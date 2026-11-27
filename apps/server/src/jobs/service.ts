import {
  canTransition,
  type CreateJobInput,
  isTerminalStatus,
  type Job,
  type JobChangesPage,
  type JobChangesQuery,
  type JobConflictCode,
  type JobEventType,
  type JobPage,
  type ListJobsQuery,
  type Location,
  type UpdateJobInput,
} from "@boda-dispatch/shared";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { jobEvents, jobs, riders } from "../db/schema.js";

export type JobRow = typeof jobs.$inferSelect;

/** A database handle or an open transaction. */
export type Executor = Pick<Database, "insert" | "select" | "update">;

export const toJob = (row: JobRow): Job => ({
  id: row.id,
  pickup: {
    address: row.pickupAddress,
    lat: row.pickupLat,
    lng: row.pickupLng,
  },
  dropoff: {
    address: row.dropoffAddress,
    lat: row.dropoffLat,
    lng: row.dropoffLng,
  },
  parcelDescription: row.parcelDescription,
  status: row.status,
  assignedRiderId: row.assignedRiderId,
  version: row.version,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Appends to the audit trail. Call it in the same transaction as the change. */
export const appendJobEvent = async (
  tx: Executor,
  event: {
    jobId: string;
    dispatcherId: string;
    type: JobEventType;
    payload: Record<string, unknown>;
    /** Marks this event as the record of that client mutation. */
    clientMutationId?: string | undefined;
  },
) => {
  await tx.insert(jobEvents).values({
    jobId: event.jobId,
    actorType: "DISPATCHER",
    actorId: event.dispatcherId,
    type: event.type,
    payload: event.payload,
    clientMutationId: event.clientMutationId ?? null,
  });
};

const MUTATION_ID_INDEX = "job_events_client_mutation_id_idx";

/**
 * Whether `err` is a unique violation on job_events.client_mutation_id: the
 * same mutation was applied by a concurrent request that committed first.
 * Drizzle wraps driver errors, so the cause chain is searched.
 */
const isDuplicateMutation = (err: unknown): boolean => {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const { code, constraint_name, cause } = current as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (code === "23505" && constraint_name === MUTATION_ID_INDEX) return true;
    current = cause;
  }
  return false;
};

/** The event that recorded a client mutation, if it was applied. */
const findMutation = async (db: Executor, clientMutationId: string) => {
  const [event] = await db
    .select({
      jobId: jobEvents.jobId,
      actorId: jobEvents.actorId,
      type: jobEvents.type,
    })
    .from(jobEvents)
    .where(eq(jobEvents.clientMutationId, clientMutationId))
    .limit(1);
  return event;
};

export type CreateJobResult =
  | { kind: "created"; job: Job }
  /** The mutation was applied before; nothing was written this time. */
  | { kind: "replayed"; job: Job }
  /** The mutation id was already used by a different change. */
  | { kind: "mutation_id_reused" };

const replayedCreate = async (
  db: Database,
  dispatcherId: string,
  clientMutationId: string,
): Promise<CreateJobResult | undefined> => {
  const event = await findMutation(db, clientMutationId);
  if (!event) return undefined;
  if (event.type !== "JOB_CREATED" || event.actorId !== dispatcherId) {
    return { kind: "mutation_id_reused" };
  }
  const [row] = await db.select().from(jobs).where(eq(jobs.id, event.jobId));
  return { kind: "replayed", job: toJob(row!) };
};

/**
 * Creates a job. With a `clientMutationId`, a repeat of a create that already
 * happened returns that job instead of making a second one, even when both
 * requests race: the loser's event insert hits the unique index, its whole
 * transaction (the job included) rolls back, and it answers with the winner's
 * job.
 */
export const createJob = async (
  db: Database,
  dispatcherId: string,
  { clientMutationId, ...input }: CreateJobInput,
): Promise<CreateJobResult> => {
  if (clientMutationId) {
    const replay = await replayedCreate(db, dispatcherId, clientMutationId);
    if (replay) return replay;
  }

  try {
    return await db.transaction(async (tx): Promise<CreateJobResult> => {
      const [row] = await tx
        .insert(jobs)
        .values({
          pickupAddress: input.pickup.address,
          pickupLat: input.pickup.lat,
          pickupLng: input.pickup.lng,
          dropoffAddress: input.dropoff.address,
          dropoffLat: input.dropoff.lat,
          dropoffLng: input.dropoff.lng,
          parcelDescription: input.parcelDescription,
          createdBy: dispatcherId,
        })
        .returning();

      await appendJobEvent(tx, {
        jobId: row!.id,
        dispatcherId,
        type: "JOB_CREATED",
        payload: input,
        clientMutationId,
      });

      return { kind: "created", job: toJob(row!) };
    });
  } catch (err) {
    if (clientMutationId && isDuplicateMutation(err)) {
      const replay = await replayedCreate(db, dispatcherId, clientMutationId);
      if (replay) return replay;
    }
    throw err;
  }
};

/**
 * Newest first, keyset-paginated: the cursor is the id of the last job on the
 * previous page. The comparison reads that job's own created_at inside
 * Postgres, so microsecond timestamps never lose precision on the way through
 * JavaScript, and the (status, created_at) index keeps serving the query.
 * Returns undefined when the cursor names no job.
 */
export const listJobs = async (
  db: Database,
  { status, cursor, limit }: ListJobsQuery,
): Promise<JobPage | undefined> => {
  if (cursor) {
    const [found] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.id, cursor))
      .limit(1);
    if (!found) return undefined;
  }

  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        status ? eq(jobs.status, status) : undefined,
        cursor
          ? sql`(${jobs.createdAt}, ${jobs.id}) < (select j.created_at, j.id from jobs j where j.id = ${cursor})`
          : undefined,
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    jobs: page.map(toJob),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
};

/**
 * Jobs touched at or after `since`, oldest change first, keyset-paginated. The
 * cursor is the last job's own (updated_at, id) as a microsecond-precision
 * string, not a job id: if that job were edited between two page fetches, a
 * cursor that looked its position up again would jump past every job changed
 * in between. A job edited mid-scan simply reappears later in the scan.
 * `since` has millisecond precision while updated_at has microseconds, so a
 * job changed within the same millisecond is returned again rather than
 * missed; clients dedupe by version.
 */
const UPDATED_AT_TEXT = sql<string>`to_char(${jobs.updatedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const listJobChanges = async (
  db: Database,
  { since, cursor, limit }: JobChangesQuery,
): Promise<JobChangesPage> => {
  const [cursorTime, cursorId] = cursor ? cursor.split("_") : [];

  const rows = await db
    .select({ job: jobs, updatedAtText: UPDATED_AT_TEXT })
    .from(jobs)
    .where(
      and(
        sql`${jobs.updatedAt} >= ${since}::timestamptz`,
        cursor
          ? sql`(${jobs.updatedAt}, ${jobs.id}) > (${cursorTime}::timestamptz, ${cursorId}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(jobs.updatedAt), asc(jobs.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    jobs: page.map((row) => toJob(row.job)),
    nextCursor:
      rows.length > limit && last
        ? `${last.updatedAtText}_${last.job.id}`
        : null,
  };
};

export type ChangeJobResult =
  | {
      kind: "ok";
      job: Job;
      changed: boolean;
      /** The mutation was applied before; `job` is how it is now. */
      replayed?: true;
    }
  | { kind: "not_found" }
  /** The mutation id was already used by a different change. */
  | { kind: "mutation_id_reused" }
  /** The rider in the request doesn't exist. */
  | { kind: "rider_not_found" }
  /** The job's current state doesn't allow the change. */
  | { kind: "conflict"; code: JobConflictCode; message: string; job: Job };

/** Statuses in which a job is in a rider's hands. */
const ACTIVE_STATUSES = ["ASSIGNED", "PICKED_UP"] as const;

const sameLocation = (a: Location, b: Location) =>
  a.address === b.address && a.lat === b.lat && a.lng === b.lng;

const locationOf = (row: JobRow, which: "pickup" | "dropoff"): Location =>
  toJob(row)[which];

/**
 * Edits a job and/or moves it to its next status, then appends what happened
 * to the audit trail, all in one transaction.
 *
 * Idempotent replay: with a `clientMutationId`, a change that was already
 * applied (its event carries that id) is answered with the job as it is now
 * and writes nothing, whatever has happened to the job since. The check runs
 * under the job's row lock, so two copies of one mutation racing each other
 * are serialised and the second sees the first's event.
 *
 * Optimistic concurrency: the change names the `version` it was made against
 * (`baseVersion`). If the job has moved on since, nothing is written and the
 * caller gets a VERSION_CONFLICT with the job as it is now, to rebase onto.
 * The row is locked first (SELECT ... FOR UPDATE) so that check and the write
 * see the same row, and the UPDATE itself is a compare-and-swap on version as
 * well, so a write can never land on a version it wasn't checked against.
 *
 * Assigning locks the rider too, so two jobs racing for one rider can't both
 * win: a rider who is BUSY or already holds an open job is refused.
 */
export const changeJob = async (
  db: Database,
  dispatcherId: string,
  jobId: string,
  input: UpdateJobInput & { reason?: string },
): Promise<ChangeJobResult> => {
  try {
    return await applyChange(db, dispatcherId, jobId, input);
  } catch (err) {
    // The id was recorded meanwhile by a change to another job (same-job
    // replays wait on the row lock instead). Re-running finds that event.
    if (input.clientMutationId && isDuplicateMutation(err)) {
      return applyChange(db, dispatcherId, jobId, input);
    }
    throw err;
  }
};

const applyChange = async (
  db: Database,
  dispatcherId: string,
  jobId: string,
  input: UpdateJobInput & { reason?: string },
): Promise<ChangeJobResult> =>
  db.transaction(async (tx): Promise<ChangeJobResult> => {
    const [current] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .for("update");
    if (!current) return { kind: "not_found" };

    // Before any other check: a replay of an applied change succeeds even if
    // the job has moved on or closed since.
    const { clientMutationId } = input;
    if (clientMutationId) {
      const applied = await findMutation(tx, clientMutationId);
      if (applied) {
        return applied.jobId === jobId &&
          applied.actorId === dispatcherId &&
          applied.type !== "JOB_CREATED"
          ? { kind: "ok", job: toJob(current), changed: false, replayed: true }
          : { kind: "mutation_id_reused" };
      }
    }

    const conflict = (
      code: JobConflictCode,
      message: string,
    ): ChangeJobResult => ({
      kind: "conflict",
      code,
      message,
      job: toJob(current),
    });

    // A closed job can't change whatever version the client saw, and saying
    // so spares it a rebase that could only fail again.
    if (isTerminalStatus(current.status)) {
      return conflict(
        "JOB_CLOSED",
        `Job is ${current.status} and can no longer change`,
      );
    }

    if (current.version !== input.baseVersion) {
      return conflict(
        "VERSION_CONFLICT",
        `Job has changed since version ${input.baseVersion}; it is now at version ${current.version}`,
      );
    }

    const { status, assignedRiderId } = input;
    if (status && !canTransition(current.status, status)) {
      return conflict(
        "INVALID_TRANSITION",
        `Cannot move a job from ${current.status} to ${status}`,
      );
    }

    if (assignedRiderId) {
      const [rider] = await tx
        .select({ id: riders.id, status: riders.status })
        .from(riders)
        .where(eq(riders.id, assignedRiderId))
        .for("update");
      if (!rider) return { kind: "rider_not_found" };

      const [otherJob] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.assignedRiderId, assignedRiderId),
            inArray(jobs.status, ACTIVE_STATUSES),
            ne(jobs.id, jobId),
          ),
        )
        .limit(1);
      if (rider.status === "BUSY" || otherJob) {
        return conflict("RIDER_BUSY", "Rider is already on another job");
      }
    }

    // Only fields that actually differ are written and recorded.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const set: Partial<typeof jobs.$inferInsert> = {};

    for (const which of ["pickup", "dropoff"] as const) {
      const next = input[which];
      const prev = locationOf(current, which);
      if (next && !sameLocation(prev, next)) {
        changes[which] = { from: prev, to: next };
        Object.assign(
          set,
          which === "pickup"
            ? {
                pickupAddress: next.address,
                pickupLat: next.lat,
                pickupLng: next.lng,
              }
            : {
                dropoffAddress: next.address,
                dropoffLat: next.lat,
                dropoffLng: next.lng,
              },
        );
      }
    }
    if (
      input.parcelDescription !== undefined &&
      input.parcelDescription !== current.parcelDescription
    ) {
      changes.parcelDescription = {
        from: current.parcelDescription,
        to: input.parcelDescription,
      };
      set.parcelDescription = input.parcelDescription;
    }
    if (status) {
      set.status = status;
      if (assignedRiderId) set.assignedRiderId = assignedRiderId;
    }

    // Nothing differs: don't bump the version or pad the audit trail.
    if (Object.keys(set).length === 0) {
      return { kind: "ok", job: toJob(current), changed: false };
    }

    const [updated] = await tx
      .update(jobs)
      .set({ ...set, version: sql`${jobs.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, jobId), eq(jobs.version, input.baseVersion)))
      .returning();
    // Unreachable while the row is locked; kept so the write is safe even if
    // the lock ever goes.
    if (!updated) {
      throw new Error(`Job ${jobId} changed under a row lock`);
    }

    // The mutation id goes on the first event only (the index is unique).
    let mutationId = clientMutationId;
    if (Object.keys(changes).length > 0) {
      await appendJobEvent(tx, {
        jobId,
        dispatcherId,
        type: "JOB_UPDATED",
        payload: { changes },
        clientMutationId: mutationId,
      });
      mutationId = undefined;
    }
    if (status) {
      await appendJobEvent(tx, {
        jobId,
        dispatcherId,
        clientMutationId: mutationId,
        type: "JOB_STATUS_CHANGED",
        payload: {
          from: current.status,
          to: status,
          ...(assignedRiderId && { assignedRiderId }),
          ...(input.reason && { reason: input.reason }),
        },
      });
    }

    return { kind: "ok", job: toJob(updated), changed: true };
  });
