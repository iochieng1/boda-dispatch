import type {
  CreateJobInput,
  Job,
  JobEventType,
  JobPage,
  ListJobsQuery,
} from "@boda-dispatch/shared";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { jobEvents, jobs } from "../db/schema.js";

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
