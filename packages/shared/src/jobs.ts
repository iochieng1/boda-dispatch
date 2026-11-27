import { z } from "zod";

// Mirrors the Postgres enums in apps/server/src/db/schema.ts.
export const JOB_STATUSES = [
  "CREATED",
  "ASSIGNED",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const RIDER_STATUSES = ["OFFLINE", "AVAILABLE", "BUSY"] as const;
export const riderStatusSchema = z.enum(RIDER_STATUSES);
export type RiderStatus = z.infer<typeof riderStatusSchema>;

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const locationSchema = z.object({
  address: z.string().trim().min(1).max(500),
  lat: latitudeSchema,
  lng: longitudeSchema,
});
export type Location = z.infer<typeof locationSchema>;

/**
 * Kenyan mobile numbers in any common format (0712..., +254712..., 254712...,
 * 712...), normalised to 2547XXXXXXXX / 2541XXXXXXXX.
 */
export const kenyanPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .pipe(
    z
      .string()
      .regex(/^(?:\+?254|0)?[17]\d{8}$/, "Must be a Kenyan mobile number"),
  )
  .transform((value) => `254${value.slice(-9)}`);

export const createJobInputSchema = z.object({
  pickup: locationSchema,
  dropoff: locationSchema,
  parcelDescription: z.string().trim().min(1).max(500),
  clientMutationId: z.uuid().optional(),
});
export type CreateJobInput = z.infer<typeof createJobInputSchema>;

export const jobSchema = z.object({
  id: z.uuid(),
  pickup: locationSchema,
  dropoff: locationSchema,
  parcelDescription: z.string(),
  status: jobStatusSchema,
  assignedRiderId: z.uuid().nullable(),
  /** Optimistic-concurrency token: echo it back on every update. */
  version: z.number().int().positive(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Job = z.infer<typeof jobSchema>;

/** The `version` of the job a change was made against. */
export const baseVersionSchema = z.number().int().positive();

/**
 * A client-generated id for one mutation (a create, an edit or a cancel). A
 * client that queues mutations offline replays them when it reconnects, and a
 * replay can arrive twice when an ack is lost. The server applies a mutation
 * id once: a repeat gets the original status code and the job as it is now,
 * with an `Idempotent-Replayed: true` header, and changes nothing. The server
 * doesn't compare request bodies, so use a new id for every change (an id
 * reused by another dispatcher or on another job gets 400). Optional, so a
 * client that never retries can leave it out.
 */
export const clientMutationIdSchema = z.uuid();

/** Response header set when a request repeated an already-applied mutation. */
export const IDEMPOTENT_REPLAYED_HEADER = "idempotent-replayed";

/**
 * Where a job may go next. A job moves forward one step at a time and any job
 * that isn't finished can be cancelled; DELIVERED and CANCELLED are final.
 */
export const JOB_TRANSITIONS: Readonly<
  Record<JobStatus, readonly JobStatus[]>
> = {
  CREATED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  JOB_TRANSITIONS[from].includes(to);

export const isTerminalStatus = (status: JobStatus): boolean =>
  JOB_TRANSITIONS[status].length === 0;

/**
 * The fields of a job a dispatcher can change. Assigning needs a rider, and a
 * rider only makes sense when assigning.
 */
const jobEditShape = {
  pickup: locationSchema.optional(),
  dropoff: locationSchema.optional(),
  parcelDescription: z.string().trim().min(1).max(500).optional(),
  status: jobStatusSchema.optional(),
  assignedRiderId: z.uuid().optional(),
};
export type JobEdit = z.infer<z.ZodObject<typeof jobEditShape>>;

/**
 * PATCH /v1/jobs/:id. Edit the addresses or parcel, move the job to its next
 * status, or both. `baseVersion` is the `version` of the job the change was
 * made against: if the job has moved on since, the server answers 409 with
 * the current job instead of overwriting someone else's change.
 */
export const updateJobInputSchema = z
  .object({
    ...jobEditShape,
    baseVersion: baseVersionSchema,
    clientMutationId: z.uuid().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const { pickup, dropoff, parcelDescription, status } = input;
    if ([pickup, dropoff, parcelDescription, status].every((v) => !v)) {
      ctx.addIssue({ code: "custom", message: "Nothing to update" });
    }
    if (input.status === "ASSIGNED" && !input.assignedRiderId) {
      ctx.addIssue({
        code: "custom",
        path: ["assignedRiderId"],
        message: "Required when assigning a job",
      });
    }
    if (input.assignedRiderId && input.status !== "ASSIGNED") {
      ctx.addIssue({
        code: "custom",
        path: ["assignedRiderId"],
        message: "Only allowed together with status ASSIGNED",
      });
    }
  });
export type UpdateJobInput = z.infer<typeof updateJobInputSchema>;

export const cancelJobInputSchema = z
  .object({
    baseVersion: baseVersionSchema,
    reason: z.string().trim().min(1).max(500).optional(),
    clientMutationId: z.uuid().optional(),
  })
  .strict();
export type CancelJobInput = z.infer<typeof cancelJobInputSchema>;

/**
 * Why a change was refused with 409. Every 409 carries the job as it is now.
 *
 * - VERSION_CONFLICT: the job changed since `baseVersion`. Rebase and retry.
 * - JOB_CLOSED: the job is DELIVERED or CANCELLED and can no longer change.
 * - INVALID_TRANSITION: the job can't move to the requested status from its
 *   current one.
 * - RIDER_BUSY: the rider is already on another job.
 */
export const JOB_CONFLICT_CODES = [
  "VERSION_CONFLICT",
  "JOB_CLOSED",
  "INVALID_TRANSITION",
  "RIDER_BUSY",
] as const;
export const jobConflictCodeSchema = z.enum(JOB_CONFLICT_CODES);
export type JobConflictCode = z.infer<typeof jobConflictCodeSchema>;

export const jobConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal("Conflict"),
  code: jobConflictCodeSchema,
  message: z.string(),
  job: jobSchema,
});
export type JobConflict = z.infer<typeof jobConflictSchema>;

export const JOBS_PAGE_SIZE_DEFAULT = 50;
export const JOBS_PAGE_SIZE_MAX = 100;

/** GET /v1/jobs. Newest first; pass `nextCursor` back as `cursor` for more. */
export const listJobsQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(JOBS_PAGE_SIZE_MAX)
    .default(JOBS_PAGE_SIZE_DEFAULT),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const jobPageSchema = z.object({
  jobs: z.array(jobSchema),
  /** Null on the last page. */
  nextCursor: z.uuid().nullable(),
});
export type JobPage = z.infer<typeof jobPageSchema>;

/**
 * GET /v1/jobs/changes: jobs touched at or after `since`, oldest change first,
 * for a client that missed live events (e.g. across a reconnect). Pass
 * `nextCursor` back as `cursor` for more. Clients apply a job only if its
 * `version` is newer than the one they hold, so overlapping `since` is safe.
 */
export const jobChangesQuerySchema = z.object({
  since: z.iso.datetime(),
  /** Opaque: pass back the previous page's `nextCursor`. */
  cursor: z
    .string()
    .regex(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "Invalid cursor",
    )
    .optional(),
  limit: listJobsQuerySchema.shape.limit,
});
export type JobChangesQuery = z.infer<typeof jobChangesQuerySchema>;

export const jobChangesPageSchema = z.object({
  jobs: z.array(jobSchema),
  /** Null on the last page. */
  nextCursor: z.string().nullable(),
});
export type JobChangesPage = z.infer<typeof jobChangesPageSchema>;

/** `job_events.type` values. */
export const JOB_EVENT_TYPES = [
  "JOB_CREATED",
  "JOB_UPDATED",
  "JOB_STATUS_CHANGED",
] as const;
export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);
export type JobEventType = z.infer<typeof jobEventTypeSchema>;
