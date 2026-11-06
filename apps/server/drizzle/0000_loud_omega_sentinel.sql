CREATE TYPE "public"."actor_type" AS ENUM('DISPATCHER', 'RIDER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('CREATED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."rider_status" AS ENUM('OFFLINE', 'AVAILABLE', 'BUSY');--> statement-breakpoint
CREATE TABLE "dispatchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"client_mutation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pickup_address" text NOT NULL,
	"pickup_lat" numeric(8, 6) NOT NULL,
	"pickup_lng" numeric(9, 6) NOT NULL,
	"dropoff_address" text NOT NULL,
	"dropoff_lat" numeric(8, 6) NOT NULL,
	"dropoff_lng" numeric(9, 6) NOT NULL,
	"parcel_description" text NOT NULL,
	"status" "job_status" DEFAULT 'CREATED' NOT NULL,
	"assigned_rider_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_version_positive" CHECK ("jobs"."version" >= 1),
	CONSTRAINT "jobs_pickup_coords_valid" CHECK ("jobs"."pickup_lat" between -90 and 90 and "jobs"."pickup_lng" between -180 and 180),
	CONSTRAINT "jobs_dropoff_coords_valid" CHECK ("jobs"."dropoff_lat" between -90 and 90 and "jobs"."dropoff_lng" between -180 and 180),
	CONSTRAINT "jobs_rider_required_when_active" CHECK ("jobs"."status" not in ('ASSIGNED', 'PICKED_UP', 'DELIVERED') or "jobs"."assigned_rider_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "riders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"status" "rider_status" DEFAULT 'OFFLINE' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "riders_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_rider_id_riders_id_fk" FOREIGN KEY ("assigned_rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_dispatchers_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."dispatchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatchers_email_lower_idx" ON "dispatchers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "job_events_job_idx" ON "job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_client_mutation_id_idx" ON "job_events" USING btree ("client_mutation_id");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_assigned_rider_idx" ON "jobs" USING btree ("assigned_rider_id") WHERE "jobs"."assigned_rider_id" is not null;--> statement-breakpoint
CREATE INDEX "riders_status_idx" ON "riders" USING btree ("status");