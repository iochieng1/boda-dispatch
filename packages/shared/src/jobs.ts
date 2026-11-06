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

/**
 * Every client mutation carries a client-generated id so that a mutation queued
 * offline and replayed (possibly more than once) is applied exactly once, and
 * the version it was based on so the server can reject stale writes.
 */
export const mutationEnvelopeSchema = z.object({
  clientMutationId: z.uuid(),
  baseVersion: z.number().int().positive(),
});
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;
