import { randomUUID } from "node:crypto";

import { IDEMPOTENT_REPLAYED_HEADER, type Job } from "@boda-dispatch/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { jobEvents, jobs } from "../src/db/schema.js";
import { buildTestApp, createDispatcher, loginAs } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const newJob = {
  pickup: { address: "Kenyatta Ave, Nairobi", lat: -1.2864, lng: 36.8172 },
  dropoff: { address: "Westlands, Nairobi", lat: -1.2676, lng: 36.8108 },
  parcelDescription: "Envelope for the lawyer",
};

describe("client mutation replay", () => {
  let app: App;
  let auth: { authorization: string };
  let otherAuth: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp();
    const bearer = async () => {
      const tokens = await loginAs(app, await createDispatcher(app));
      return { authorization: `Bearer ${tokens.access_token}` };
    };
    auth = await bearer();
    otherAuth = await bearer();
  });

  afterAll(async () => {
    await app.close();
  });

  const create = (payload: Record<string, unknown>, headers = auth) =>
    app.inject({ method: "POST", url: "/v1/jobs", payload, headers });

  const patch = (
    id: string,
    payload: Record<string, unknown>,
    headers = auth,
  ) => app.inject({ method: "PATCH", url: `/v1/jobs/${id}`, payload, headers });

  const cancel = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/v1/jobs/${id}/cancel`,
      payload,
      headers: auth,
    });

  const freshJob = async () => {
    const res = await create(newJob);
    expect(res.statusCode).toBe(201);
    return res.json<Job>();
  };

  const trail = (id: string) =>
    app.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, id))
      .orderBy(asc(jobEvents.id));

  const jobsWithParcel = (parcelDescription: string) =>
    app.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.parcelDescription, parcelDescription));

  describe("create", () => {
    it("creates one job however often the same mutation arrives", async () => {
      const clientMutationId = randomUUID();
      const parcelDescription = `Replayed create ${clientMutationId}`;
      const payload = { ...newJob, parcelDescription, clientMutationId };

      const first = await create(payload);
      const second = await create(payload);

      expect(first.statusCode).toBe(201);
      expect(first.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
      expect(second.statusCode).toBe(201);
      expect(second.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe("true");
      expect(second.json<Job>().id).toBe(first.json<Job>().id);
      expect(await jobsWithParcel(parcelDescription)).toHaveLength(1);

      const [event] = await trail(first.json<Job>().id);
      expect(event).toMatchObject({ type: "JOB_CREATED", clientMutationId });
      expect(event!.payload).not.toHaveProperty("clientMutationId");
    });

    it("creates one job when copies of a mutation race", async () => {
      const clientMutationId = randomUUID();
      const parcelDescription = `Racing create ${clientMutationId}`;
      const payload = { ...newJob, parcelDescription, clientMutationId };

      const answers = await Promise.all(
        Array.from({ length: 5 }, () => create(payload)),
      );

      expect(answers.map((res) => res.statusCode)).toEqual(Array(5).fill(201));
      expect(new Set(answers.map((res) => res.json<Job>().id)).size).toBe(1);
      expect(await jobsWithParcel(parcelDescription)).toHaveLength(1);
    });

    it("creates separate jobs without a mutation id", async () => {
      const parcelDescription = `No mutation id ${randomUUID()}`;
      await create({ ...newJob, parcelDescription });
      await create({ ...newJob, parcelDescription });
      expect(await jobsWithParcel(parcelDescription)).toHaveLength(2);
    });

    it("refuses a mutation id another dispatcher already used", async () => {
      const clientMutationId = randomUUID();
      await create({ ...newJob, clientMutationId });

      const res = await create({ ...newJob, clientMutationId }, otherAuth);

      expect(res.statusCode).toBe(400);
      expect(res.json().issues).toEqual([
        {
          path: "clientMutationId",
          message: "Already used by a different change",
        },
      ]);
    });
  });

  describe("edit and cancel", () => {
    it("applies an edit once and answers a replay with the job as it is now", async () => {
      const job = await freshJob();
      const clientMutationId = randomUUID();
      const edit = {
        parcelDescription: "Two envelopes",
        baseVersion: job.version,
        clientMutationId,
      };

      const first = await patch(job.id, edit);
      expect(first.statusCode).toBe(200);
      expect(first.json<Job>().version).toBe(2);

      // Someone else moves the job on before the replay arrives.
      await patch(job.id, { parcelDescription: "Three", baseVersion: 2 });

      const replay = await patch(job.id, edit);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe("true");
      expect(replay.json<Job>()).toMatchObject({
        version: 3,
        parcelDescription: "Three",
      });

      const events = await trail(job.id);
      expect(events.map((e) => e.type)).toEqual([
        "JOB_CREATED",
        "JOB_UPDATED",
        "JOB_UPDATED",
      ]);
      expect(events[1]!.clientMutationId).toBe(clientMutationId);
    });

    it("applies a cancel once, and a replay after it is still a success", async () => {
      const job = await freshJob();
      const payload = {
        baseVersion: job.version,
        clientMutationId: randomUUID(),
      };

      expect((await cancel(job.id, payload)).statusCode).toBe(200);
      // Without the mutation id this would be 409 JOB_CLOSED.
      const replay = await cancel(job.id, payload);

      expect(replay.statusCode).toBe(200);
      expect(replay.json<Job>()).toMatchObject({
        status: "CANCELLED",
        version: 2,
      });
      expect((await trail(job.id)).map((e) => e.type)).toEqual([
        "JOB_CREATED",
        "JOB_STATUS_CHANGED",
      ]);
    });

    it("records the mutation id once for an edit that writes two events", async () => {
      const job = await freshJob();
      const clientMutationId = randomUUID();

      const res = await patch(job.id, {
        parcelDescription: "Box",
        status: "CANCELLED",
        baseVersion: job.version,
        clientMutationId,
      });

      expect(res.statusCode).toBe(200);
      const events = await trail(job.id);
      expect(events.map((e) => [e.type, e.clientMutationId])).toEqual([
        ["JOB_CREATED", null],
        ["JOB_UPDATED", clientMutationId],
        ["JOB_STATUS_CHANGED", null],
      ]);
    });

    it("applies copies of one edit racing each other once", async () => {
      const job = await freshJob();
      const edit = {
        parcelDescription: "Raced",
        baseVersion: job.version,
        clientMutationId: randomUUID(),
      };

      const answers = await Promise.all(
        Array.from({ length: 5 }, () => patch(job.id, edit)),
      );

      expect(answers.map((res) => res.statusCode)).toEqual(Array(5).fill(200));
      expect(
        answers.filter((res) => res.headers[IDEMPOTENT_REPLAYED_HEADER]),
      ).toHaveLength(4);
      expect(await trail(job.id)).toHaveLength(2);
    });

    it("lets a refused change retry with the same mutation id", async () => {
      const job = await freshJob();
      await patch(job.id, { parcelDescription: "Theirs", baseVersion: 1 });
      const clientMutationId = randomUUID();

      const stale = await patch(job.id, {
        status: "CANCELLED",
        baseVersion: 1,
        clientMutationId,
      });
      expect(stale.statusCode).toBe(409);

      // The rebased retry is the same mutation, so it keeps its id.
      const retry = await patch(job.id, {
        status: "CANCELLED",
        baseVersion: 2,
        clientMutationId,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
      expect(retry.json<Job>().status).toBe("CANCELLED");
    });

    it("refuses a mutation id already used on another job", async () => {
      const [a, b] = [await freshJob(), await freshJob()];
      const clientMutationId = randomUUID();
      await patch(a.id, {
        parcelDescription: "A",
        baseVersion: 1,
        clientMutationId,
      });

      const res = await patch(b.id, {
        parcelDescription: "B",
        baseVersion: 1,
        clientMutationId,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toBe("clientMutationId");
    });

    it("refuses a create's mutation id on an edit of that job", async () => {
      const clientMutationId = randomUUID();
      const job = (await create({ ...newJob, clientMutationId })).json<Job>();

      const res = await patch(job.id, {
        parcelDescription: "Box",
        baseVersion: 1,
        clientMutationId,
      });

      expect(res.statusCode).toBe(400);
    });

    it("refuses another dispatcher's mutation id", async () => {
      const job = await freshJob();
      const clientMutationId = randomUUID();
      await patch(job.id, {
        parcelDescription: "Mine",
        baseVersion: 1,
        clientMutationId,
      });

      const res = await patch(
        job.id,
        { parcelDescription: "Mine", baseVersion: 1, clientMutationId },
        otherAuth,
      );

      expect(res.statusCode).toBe(400);
    });

    it("rejects a mutation id that isn't a UUID", async () => {
      const job = await freshJob();
      const res = await patch(job.id, {
        parcelDescription: "Box",
        baseVersion: 1,
        clientMutationId: "abc",
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
