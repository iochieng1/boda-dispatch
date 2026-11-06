import { JOB_STATUSES, RIDER_STATUSES } from "@boda-dispatch/shared";
import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// 6 decimal places is ~11 cm of precision: plenty for a doorstep.
const latitude = (name: string) =>
  numeric(name, { precision: 8, scale: 6, mode: "number" }).notNull();
const longitude = (name: string) =>
  numeric(name, { precision: 9, scale: 6, mode: "number" }).notNull();

export const riderStatus = pgEnum("rider_status", RIDER_STATUSES);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);
export const actorType = pgEnum("actor_type", [
  "DISPATCHER",
  "RIDER",
  "SYSTEM",
]);

export const riders = pgTable(
  "riders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Normalised to 2547XXXXXXXX / 2541XXXXXXXX (see kenyanPhoneSchema).
    phone: text("phone").notNull().unique(),
    status: riderStatus("status").notNull().default("OFFLINE"),
    // Updated on every heartbeat; drives presence and "stale rider" detection.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("riders_status_idx").on(t.status)],
);

export const dispatchers = pgTable(
  "dispatchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("dispatchers_email_lower_idx").on(sql`lower(${t.email})`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pickupAddress: text("pickup_address").notNull(),
    pickupLat: latitude("pickup_lat"),
    pickupLng: longitude("pickup_lng"),
    dropoffAddress: text("dropoff_address").notNull(),
    dropoffLat: latitude("dropoff_lat"),
    dropoffLng: longitude("dropoff_lng"),
    parcelDescription: text("parcel_description").notNull(),
    status: jobStatus("status").notNull().default("CREATED"),
    assignedRiderId: uuid("assigned_rider_id").references(() => riders.id),
    /**
     * Optimistic concurrency control. Every write is a compare-and-swap:
     *
     *   UPDATE jobs SET ..., version = version + 1
     *   WHERE id = $id AND version = $baseVersion
     *
     * If two dispatchers (or a dispatcher and a rider coming back online) edit
     * the same job, exactly one update matches; the other affects zero rows and
     * the API answers 409 with the current job so the client can rebase its
     * change instead of silently overwriting someone else's.
     */
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => dispatchers.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("jobs_version_positive", sql`${t.version} >= 1`),
    check(
      "jobs_pickup_coords_valid",
      sql`${t.pickupLat} between -90 and 90 and ${t.pickupLng} between -180 and 180`,
    ),
    check(
      "jobs_dropoff_coords_valid",
      sql`${t.dropoffLat} between -90 and 90 and ${t.dropoffLng} between -180 and 180`,
    ),
    // A job that is in a rider's hands must say whose.
    check(
      "jobs_rider_required_when_active",
      sql`${t.status} not in ('ASSIGNED', 'PICKED_UP', 'DELIVERED') or ${t.assignedRiderId} is not null`,
    ),
    // The live board: open jobs, newest first.
    index("jobs_status_created_idx").on(t.status, t.createdAt),
    index("jobs_assigned_rider_idx")
      .on(t.assignedRiderId)
      .where(sql`${t.assignedRiderId} is not null`),
  ],
);

// Append-only audit trail of everything that happened to a job.
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    actorType: actorType("actor_type").notNull(),
    // Dispatcher or rider id; null for SYSTEM events.
    actorId: uuid("actor_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    /**
     * Client-generated id (UUID) of the mutation that produced this event.
     * Riders on patchy mobile data queue mutations offline and replay them when
     * they reconnect; a replay may arrive twice (retry after a lost ack). The
     * unique index makes the event insert the dedupe point: a duplicate fails
     * with a unique violation and the server returns the original result
     * instead of applying the change again. Null for server-originated events
     * (Postgres treats NULLs as distinct, so they never collide).
     */
    clientMutationId: text("client_mutation_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("job_events_job_idx").on(t.jobId, t.id),
    uniqueIndex("job_events_client_mutation_id_idx").on(t.clientMutationId),
  ],
);
