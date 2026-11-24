import { randomUUID } from "node:crypto";

import type { Job, JobPage } from "@boda-dispatch/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { jobEvents, jobs } from "../src/db/schema.js";
import { buildTestApp, createDispatcher, loginAs } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const pickup = { address: "Kenyatta Ave, Nairobi", lat: -1.2864, lng: 36.8172 };
const dropoff = { address: "Westlands, Nairobi", lat: -1.2676, lng: 36.8108 };
const newJob = {
  pickup,
  dropoff,
  parcelDescription: "Envelope for the lawyer",
};

describe("jobs", () => {
  let app: App;
  let dispatcher: Awaited<ReturnType<typeof createDispatcher>>;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp();
    dispatcher = await createDispatcher(app);
    const tokens = await loginAs(app, dispatcher);
    auth = { authorization: `Bearer ${tokens.access_token}` };
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (
    payload: Record<string, unknown>,
    headers: Record<string, string> = auth,
  ) => app.inject({ method: "POST", url: "/v1/jobs", payload, headers });

  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await post({ ...newJob, ...overrides });
    expect(res.statusCode).toBe(201);
    return res.json<Job>();
  };

  const list = (query = "") =>
    app.inject({ method: "GET", url: `/v1/jobs${query}`, headers: auth });

  describe("POST /v1/jobs", () => {
    it("creates a CREATED job owned by the dispatcher", async () => {
      const res = await post(newJob);

      expect(res.statusCode).toBe(201);
      expect(res.json<Job>()).toMatchObject({
        pickup,
        dropoff,
        parcelDescription: "Envelope for the lawyer",
        status: "CREATED",
        assignedRiderId: null,
        version: 1,
        createdBy: dispatcher.id,
      });
    });

    it("starts the audit trail with a JOB_CREATED event", async () => {
      const job = await create();

      const events = await app.db
        .select()
        .from(jobEvents)
        .where(eq(jobEvents.jobId, job.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "JOB_CREATED",
        actorType: "DISPATCHER",
        actorId: dispatcher.id,
        payload: newJob,
      });
    });

    it("rejects an invalid body with 400 and writes nothing", async () => {
      const before = await app.db.select().from(jobs);

      const res = await post({ ...newJob, pickup: { ...pickup, lat: 95 } });

      expect(res.statusCode).toBe(400);
      expect(res.json().issues).toEqual([
        expect.objectContaining({ path: "pickup.lat" }),
      ]);
      expect(await app.db.select().from(jobs)).toHaveLength(before.length);
    });

    it("requires authentication", async () => {
      expect((await post(newJob, {})).statusCode).toBe(401);
    });
  });

  describe("GET /v1/jobs", () => {
    it("requires authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/jobs" });
      expect(res.statusCode).toBe(401);
    });

    it("lists newest first and pages with a cursor", async () => {
      const mine = [];
      for (let i = 0; i < 5; i++) {
        mine.push(await create({ parcelDescription: `Parcel ${i}` }));
      }
      const newestFirst = mine.map((j) => j.id).reverse();

      const first = (await list("?limit=2")).json<JobPage>();
      expect(first.jobs.map((j) => j.id)).toEqual(newestFirst.slice(0, 2));
      expect(first.nextCursor).toBe(newestFirst[1]);

      const second = (
        await list(`?limit=2&cursor=${first.nextCursor}`)
      ).json<JobPage>();
      expect(second.jobs.map((j) => j.id)).toEqual(newestFirst.slice(2, 4));

      const third = (
        await list(`?limit=2&cursor=${second.nextCursor}`)
      ).json<JobPage>();
      expect(third.jobs[0]!.id).toBe(newestFirst[4]);
    });

    it("walks every job exactly once, even with identical timestamps", async () => {
      // One statement means one created_at for all rows: the id tie-break
      // has to keep the pages stable.
      await app.db.insert(jobs).values(
        Array.from({ length: 7 }, (_, i) => ({
          pickupAddress: "A",
          pickupLat: -1.2,
          pickupLng: 36.8,
          dropoffAddress: "B",
          dropoffLat: -1.3,
          dropoffLng: 36.9,
          parcelDescription: `Tied ${i}`,
          createdBy: dispatcher.id,
        })),
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: JobPage = (
          await list(`?limit=3${cursor ? `&cursor=${cursor}` : ""}`)
        ).json<JobPage>();
        seen.push(...page.jobs.map((j) => j.id));
        cursor = page.nextCursor;
      } while (cursor);

      const all = await app.db.select({ id: jobs.id }).from(jobs);
      expect(seen).toHaveLength(all.length);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("filters by status", async () => {
      const job = await create();
      await app.db
        .update(jobs)
        .set({ status: "CANCELLED" })
        .where(eq(jobs.id, job.id));

      const cancelled = (await list("?status=CANCELLED")).json<JobPage>();
      expect(cancelled.jobs.map((j) => j.id)).toContain(job.id);
      expect(cancelled.jobs.every((j) => j.status === "CANCELLED")).toBe(true);

      const created = (await list("?status=CREATED&limit=100")).json<JobPage>();
      expect(created.jobs.map((j) => j.id)).not.toContain(job.id);
    });

    it("returns 400 for a bad status, limit or cursor", async () => {
      expect((await list("?status=LOST")).statusCode).toBe(400);
      expect((await list("?limit=0")).statusCode).toBe(400);
      expect((await list("?cursor=nope")).statusCode).toBe(400);
      expect((await list(`?cursor=${randomUUID()}`)).statusCode).toBe(400);
    });
  });
});
