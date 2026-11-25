import { randomUUID } from "node:crypto";

import type { Job, JobChangesPage, JobPage } from "@boda-dispatch/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { jobEvents, jobs, riders } from "../src/db/schema.js";
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

  const createRider = async () => {
    const [rider] = await app.db
      .insert(riders)
      .values({
        name: "Otieno",
        phone: `2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      })
      .returning({ id: riders.id });
    return rider!.id;
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/v1/jobs/${id}`,
      payload,
      headers: auth,
    });

  const cancel = (id: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/jobs/${id}/cancel`,
      payload,
      headers: auth,
    });

  const trail = (id: string) =>
    app.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, id))
      .orderBy(asc(jobEvents.id));

  const assign = async (job: Job) =>
    patch(job.id, { status: "ASSIGNED", assignedRiderId: await createRider() });

  /** A job moved to `status` through the API. */
  const jobIn = async (status: Job["status"]) => {
    const job = await create();
    if (status === "CREATED") return job;
    if (status === "CANCELLED") {
      await cancel(job.id);
      return job;
    }
    await assign(job);
    if (status === "ASSIGNED") return job;
    await patch(job.id, { status: "PICKED_UP" });
    if (status === "PICKED_UP") return job;
    await patch(job.id, { status: "DELIVERED" });
    return job;
  };

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

  describe("PATCH /v1/jobs/:id", () => {
    it("edits the job, bumps the version and records what changed", async () => {
      const job = await create();
      const newDropoff = { ...dropoff, address: "Sarit Centre, Westlands" };

      const res = await patch(job.id, {
        dropoff: newDropoff,
        parcelDescription: "Two envelopes",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<Job>()).toMatchObject({
        dropoff: newDropoff,
        parcelDescription: "Two envelopes",
        status: "CREATED",
        version: 2,
      });
      const events = await trail(job.id);
      expect(events.map((e) => e.type)).toEqual(["JOB_CREATED", "JOB_UPDATED"]);
      expect(events[1]).toMatchObject({
        actorId: dispatcher.id,
        payload: {
          changes: {
            dropoff: { from: dropoff, to: newDropoff },
            parcelDescription: {
              from: "Envelope for the lawyer",
              to: "Two envelopes",
            },
          },
        },
      });
    });

    it("does nothing, and logs nothing, when nothing differs", async () => {
      const job = await create();

      const res = await patch(job.id, {
        parcelDescription: job.parcelDescription,
        pickup,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<Job>().version).toBe(1);
      expect(await trail(job.id)).toHaveLength(1);
    });

    it("assigns a rider", async () => {
      const job = await create();
      const riderId = await createRider();

      const res = await patch(job.id, {
        status: "ASSIGNED",
        assignedRiderId: riderId,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<Job>()).toMatchObject({
        status: "ASSIGNED",
        assignedRiderId: riderId,
        version: 2,
      });
    });

    it("keeps a complete audit trail through the whole lifecycle", async () => {
      const job = await create();
      const riderId = await createRider();

      await patch(job.id, { status: "ASSIGNED", assignedRiderId: riderId });
      await patch(job.id, { parcelDescription: "Envelope, sealed" });
      await patch(job.id, { status: "PICKED_UP" });
      const delivered = await patch(job.id, { status: "DELIVERED" });

      expect(delivered.json<Job>()).toMatchObject({
        status: "DELIVERED",
        version: 5,
      });
      const events = await trail(job.id);
      expect(events.map((e) => [e.type, e.payload])).toEqual([
        ["JOB_CREATED", expect.objectContaining({ pickup, dropoff })],
        [
          "JOB_STATUS_CHANGED",
          { from: "CREATED", to: "ASSIGNED", assignedRiderId: riderId },
        ],
        ["JOB_UPDATED", expect.anything()],
        ["JOB_STATUS_CHANGED", { from: "ASSIGNED", to: "PICKED_UP" }],
        ["JOB_STATUS_CHANGED", { from: "PICKED_UP", to: "DELIVERED" }],
      ]);
      expect(events.every((e) => e.actorId === dispatcher.id)).toBe(true);
    });

    it.each([
      ["CREATED", "PICKED_UP"],
      ["CREATED", "DELIVERED"],
      ["CREATED", "CREATED"],
      ["ASSIGNED", "CREATED"],
      ["ASSIGNED", "DELIVERED"],
      ["PICKED_UP", "ASSIGNED"],
    ] as const)("returns 409 for %s -> %s", async (from, to) => {
      const job = await jobIn(from);
      const before = await trail(job.id);
      const riderId = to === "ASSIGNED" ? await createRider() : undefined;

      const res = await patch(job.id, {
        status: to,
        ...(riderId && { assignedRiderId: riderId }),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: "Conflict",
        message: `Cannot move a job from ${from} to ${to}`,
        job: { id: job.id, status: from },
      });
      expect(await trail(job.id)).toHaveLength(before.length);
    });

    it.each(["DELIVERED", "CANCELLED"] as const)(
      "returns 409 for any change to a %s job",
      async (status) => {
        const job = await jobIn(status);
        const before = await trail(job.id);

        for (const change of [
          { parcelDescription: "Too late" },
          { status: "CANCELLED" },
        ]) {
          const res = await patch(job.id, change);
          expect(res.statusCode).toBe(409);
          expect(res.json().message).toBe(
            `Job is ${status} and can no longer change`,
          );
        }
        expect(await trail(job.id)).toHaveLength(before.length);
      },
    );

    it("lets a dispatcher cancel through PATCH from any open status", async () => {
      for (const from of ["CREATED", "ASSIGNED", "PICKED_UP"] as const) {
        const job = await jobIn(from);
        const res = await patch(job.id, { status: "CANCELLED" });
        expect(res.statusCode).toBe(200);
        expect(res.json<Job>().status).toBe("CANCELLED");
      }
    });

    it("returns 400 on assignedRiderId for an unknown rider and leaves the job alone", async () => {
      const job = await create();

      const res = await patch(job.id, {
        status: "ASSIGNED",
        assignedRiderId: randomUUID(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().issues).toEqual([
        { path: "assignedRiderId", message: "Rider not found" },
      ]);
      expect((await trail(job.id)).length).toBe(1);
    });

    it("returns 404 for an unknown job", async () => {
      const res = await patch(randomUUID(), { parcelDescription: "x" });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for a bad id or body", async () => {
      const job = await create();
      expect(
        (await patch("not-a-uuid", { parcelDescription: "x" })).statusCode,
      ).toBe(400);
      expect((await patch(job.id, {})).statusCode).toBe(400);
      expect((await patch(job.id, { status: "ASSIGNED" })).statusCode).toBe(
        400,
      );
      expect((await patch(job.id, { version: 3 })).statusCode).toBe(400);
    });

    it("requires authentication", async () => {
      const job = await create();
      const res = await app.inject({
        method: "PATCH",
        url: `/v1/jobs/${job.id}`,
        payload: { parcelDescription: "x" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("lets only one of two simultaneous assignments win", async () => {
      const job = await create();
      const [a, b] = [await createRider(), await createRider()];

      const results = await Promise.all([
        patch(job.id, { status: "ASSIGNED", assignedRiderId: a }),
        patch(job.id, { status: "ASSIGNED", assignedRiderId: b }),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const events = await trail(job.id);
      expect(
        events.filter((e) => e.type === "JOB_STATUS_CHANGED"),
      ).toHaveLength(1);
      const winner = results.find((r) => r.statusCode === 200)!.json<Job>();
      const [row] = await app.db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(row!.assignedRiderId).toBe(winner.assignedRiderId);
      expect(row!.version).toBe(2);
    });
  });

  describe("POST /v1/jobs/:id/cancel", () => {
    it.each(["CREATED", "ASSIGNED", "PICKED_UP"] as const)(
      "cancels a %s job and records the reason",
      async (from) => {
        const job = await jobIn(from);

        const res = await cancel(job.id, { reason: "Customer called" });

        expect(res.statusCode).toBe(200);
        expect(res.json<Job>()).toMatchObject({ status: "CANCELLED" });
        const events = await trail(job.id);
        expect(events.at(-1)).toMatchObject({
          type: "JOB_STATUS_CHANGED",
          actorId: dispatcher.id,
          payload: { from, to: "CANCELLED", reason: "Customer called" },
        });
      },
    );

    it("keeps the rider on a cancelled job, for the record", async () => {
      const job = await jobIn("ASSIGNED");
      const before = (
        await app.db.select().from(jobs).where(eq(jobs.id, job.id))
      )[0]!;

      const res = await cancel(job.id);

      expect(res.json<Job>().assignedRiderId).toBe(before.assignedRiderId);
    });

    it("accepts a request with no body", async () => {
      const job = await create();
      const res = await app.inject({
        method: "POST",
        url: `/v1/jobs/${job.id}/cancel`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
    });

    it.each(["DELIVERED", "CANCELLED"] as const)(
      "returns 409 for a %s job",
      async (status) => {
        const job = await jobIn(status);
        const before = await trail(job.id);

        const res = await cancel(job.id);

        expect(res.statusCode).toBe(409);
        expect(await trail(job.id)).toHaveLength(before.length);
      },
    );

    it("returns 404 for an unknown job and 400 for a bad id or body", async () => {
      expect((await cancel(randomUUID())).statusCode).toBe(404);
      expect((await cancel("nope")).statusCode).toBe(400);
      const job = await create();
      expect((await cancel(job.id, { reason: "" })).statusCode).toBe(400);
      expect((await cancel(job.id, { extra: 1 })).statusCode).toBe(400);
    });

    it("requires authentication", async () => {
      const job = await create();
      const res = await app.inject({
        method: "POST",
        url: `/v1/jobs/${job.id}/cancel`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
  describe("GET /v1/jobs/changes", () => {
    const changes = (query: string) =>
      app.inject({
        method: "GET",
        url: `/v1/jobs/changes?${query}`,
        headers: auth,
      });

    it("returns jobs touched since a moment, oldest change first", async () => {
      const first = await create();
      const second = await create();
      const rider = await createRider();
      const since = new Date().toISOString();
      await patch(first.id, { status: "ASSIGNED", assignedRiderId: rider });
      const third = await create();

      const res = await changes(`since=${encodeURIComponent(since)}`);

      expect(res.statusCode).toBe(200);
      const page = res.json<JobPage>();
      expect(page.jobs.map((j) => j.id)).toEqual([first.id, third.id]);
      expect(page.jobs[0]).toMatchObject({ status: "ASSIGNED", version: 2 });
      expect(page.jobs.map((j) => j.id)).not.toContain(second.id);
      expect(page.nextCursor).toBeNull();
    });

    it("pages with a cursor without skipping or repeating a job", async () => {
      const since = new Date().toISOString();
      const made = [await create(), await create(), await create()];

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await changes(
          `since=${encodeURIComponent(since)}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page: JobChangesPage = res.json<JobChangesPage>();
        seen.push(...page.jobs.map((j) => j.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toEqual(made.map((j) => j.id));
    });

    it("does not skip jobs when the cursor's job is edited between pages", async () => {
      const since = new Date().toISOString();
      const [first, second, third] = [
        await create(),
        await create(),
        await create(),
      ] as [Job, Job, Job];
      const rider = await createRider();

      const page1 = (
        await changes(`since=${encodeURIComponent(since)}&limit=1`)
      ).json<JobChangesPage>();
      expect(page1.jobs.map((j) => j.id)).toEqual([first.id]);
      // The job the cursor points at changes before the next page is read.
      await patch(first.id, { status: "ASSIGNED", assignedRiderId: rider });

      const page2 = (
        await changes(
          `since=${encodeURIComponent(since)}&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        )
      ).json<JobChangesPage>();

      expect(page2.jobs.map((j) => j.id)).toEqual([
        second.id,
        third.id,
        first.id,
      ]);
    });

    it("rejects a missing or malformed since and a malformed cursor", async () => {
      expect((await changes("")).statusCode).toBe(400);
      expect((await changes("since=yesterday")).statusCode).toBe(400);
      const since = encodeURIComponent(new Date().toISOString());
      expect(
        (await changes(`since=${since}&cursor=${randomUUID()}`)).statusCode,
      ).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/jobs/changes?since=${encodeURIComponent(new Date().toISOString())}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
