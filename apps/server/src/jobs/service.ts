import {
  canTransition,
  type CreateJobInput,
  isTerminalStatus,
  type Job,
  type JobChangesPage,
  type JobChangesQuery,
  type JobEventType,
  type JobPage,
  type ListJobsQuery,
  type Location,
  type UpdateJobInput,
} from "@boda-dispatch/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";

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
  },
) => {
  await tx.insert(jobEvents).values({
    jobId: event.jobId,
    actorType: "DISPATCHER",
    actorId: event.dispatcherId,
    type: event.type,
    payload: event.payload,
  });
};

export const createJob = async (
  db: Database,
  dispatcherId: string,
  input: CreateJobInput,
): Promise<Job> =>
  db.transaction(async (tx) => {
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
      payload: {
        pickup: input.pickup,
        dropoff: input.dropoff,
        parcelDescription: input.parcelDescription,
      },
    });

    return toJob(row!);
  });

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
  | { kind: "ok"; job: Job; changed: boolean }
  | { kind: "not_found" }
  /** The rider in the request doesn't exist. */
  | { kind: "rider_not_found" }
  /** The job's current state doesn't allow the change. */
  | { kind: "conflict"; message: string; job: Job };

const sameLocation = (a: Location, b: Location) =>
  a.address === b.address && a.lat === b.lat && a.lng === b.lng;

const locationOf = (row: JobRow, which: "pickup" | "dropoff"): Location =>
  toJob(row)[which];

/**
 * Edits a job and/or moves it to its next status, then appends what happened
 * to the audit trail, all in one transaction. The row is locked first
 * (SELECT ... FOR UPDATE), so two requests racing on one job run one after the
 * other and the second is checked against the first one's result: a job can't
 * be assigned twice or cancelled after it was delivered.
 */
export const changeJob = async (
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

    const conflict = (message: string): ChangeJobResult => ({
      kind: "conflict",
      message,
      job: toJob(current),
    });

    if (isTerminalStatus(current.status)) {
      return conflict(`Job is ${current.status} and can no longer change`);
    }

    const { status, assignedRiderId } = input;
    if (status && !canTransition(current.status, status)) {
      return conflict(`Cannot move a job from ${current.status} to ${status}`);
    }

    if (assignedRiderId) {
      const [rider] = await tx
        .select({ id: riders.id })
        .from(riders)
        .where(eq(riders.id, assignedRiderId))
        .limit(1);
      if (!rider) return { kind: "rider_not_found" };
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
      .where(eq(jobs.id, jobId))
      .returning();

    if (Object.keys(changes).length > 0) {
      await appendJobEvent(tx, {
        jobId,
        dispatcherId,
        type: "JOB_UPDATED",
        payload: { changes },
      });
    }
    if (status) {
      await appendJobEvent(tx, {
        jobId,
        dispatcherId,
        type: "JOB_STATUS_CHANGED",
        payload: {
          from: current.status,
          to: status,
          ...(assignedRiderId && { assignedRiderId }),
          ...(input.reason && { reason: input.reason }),
        },
      });
    }

    return { kind: "ok", job: toJob(updated!), changed: true };
  });
