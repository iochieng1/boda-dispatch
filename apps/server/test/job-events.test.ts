import type { AddressInfo } from "node:net";

import {
  type ClientToServerEvents,
  type Job,
  type JobEvent,
  jobEventSchema,
  type ServerToClientEvents,
} from "@boda-dispatch/shared";
import { type Socket, io as connect } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { riders } from "../src/db/schema.js";
import { buildTestApp, createDispatcher, loginAs } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const newJob = {
  pickup: { address: "Kenyatta Ave, Nairobi", lat: -1.2864, lng: 36.8172 },
  dropoff: { address: "Westlands, Nairobi", lat: -1.2676, lng: 36.8108 },
  parcelDescription: "Envelope for the lawyer",
};

const urlOf = (app: App) =>
  `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

describe("live job events", () => {
  // Two server instances sharing one Redis, as in production.
  let a: App;
  let b: App;
  let auth: { authorization: string };
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    a = await buildTestApp();
    b = await buildTestApp();
    await Promise.all(
      [a, b].map((app) => app.listen({ port: 0, host: "127.0.0.1" })),
    );
    const dispatcher = await createDispatcher(a);
    auth = {
      authorization: `Bearer ${(await loginAs(a, dispatcher)).access_token}`,
    };
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  /** A connected dispatcher socket that records the job events it receives. */
  const listen = async (app: App) => {
    const dispatcher = await createDispatcher(app);
    const client: ClientSocket = connect(urlOf(app), {
      transports: ["websocket"],
      reconnection: false,
      auth: { token: (await loginAs(app, dispatcher)).access_token },
    });
    clients.push(client);
    const received: { event: string; payload: JobEvent }[] = [];
    client.on("job:created", (payload) =>
      received.push({ event: "job:created", payload }),
    );
    client.on("job:updated", (payload) =>
      received.push({ event: "job:updated", payload }),
    );
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return {
      id: client.id!,
      // Test files share one Redis, so other files' jobs arrive here too.
      eventsFor: (jobId: string) =>
        received.filter((r) => r.payload.job.id === jobId),
    };
  };
  type Listener = Awaited<ReturnType<typeof listen>>;

  // The adapter attaches once its Redis subscriber is ready; wait until each
  // instance can see the other's sockets before relying on cross-instance
  // delivery.
  const bridged = async (...listeners: Listener[]) => {
    for (const app of [a, b]) {
      await expect
        .poll(async () => (await app.io.fetchSockets()).map((s) => s.id), {
          timeout: 5_000,
        })
        .toEqual(expect.arrayContaining(listeners.map((l) => l.id)));
    }
  };

  const request = (
    method: "POST" | "PATCH",
    url: string,
    payload: Record<string, unknown>,
  ) => a.inject({ method, url, payload, headers: auth });

  it("delivers job:created to dispatchers on both instances", async () => {
    const onA = await listen(a);
    const onB = await listen(b);
    await bridged(onA, onB);

    const res = await request("POST", "/v1/jobs", newJob);
    const job = res.json<Job>();

    for (const listener of [onA, onB]) {
      await expect
        .poll(() => listener.eventsFor(job.id).length, { timeout: 5_000 })
        .toBe(1);
      const [received] = listener.eventsFor(job.id);
      expect(received!.event).toBe("job:created");
      expect(jobEventSchema.parse(received!.payload).job).toEqual(job);
    }
  });

  it("delivers job:updated for edits, assignment and cancellation", async () => {
    const onB = await listen(b);
    await bridged(onB);
    const [rider] = await a.db
      .insert(riders)
      .values({
        name: "Otieno",
        phone: `2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      })
      .returning({ id: riders.id });
    const job = (await request("POST", "/v1/jobs", newJob)).json<Job>();

    await request("PATCH", `/v1/jobs/${job.id}`, {
      baseVersion: 1,
      status: "ASSIGNED",
      assignedRiderId: rider!.id,
    });
    await request("POST", `/v1/jobs/${job.id}/cancel`, { baseVersion: 2 });

    await expect
      .poll(() => onB.eventsFor(job.id).length, { timeout: 5_000 })
      .toBe(3);
    const received = onB.eventsFor(job.id);
    expect(received.map((r) => r.event)).toEqual([
      "job:created",
      "job:updated",
      "job:updated",
    ]);
    expect(received.map((r) => r.payload.job.status)).toEqual([
      "CREATED",
      "ASSIGNED",
      "CANCELLED",
    ]);
    expect(received.map((r) => r.payload.job.version)).toEqual([1, 2, 3]);
  });

  it("stays silent when a write changes nothing or fails", async () => {
    const onA = await listen(a);
    const job = (await request("POST", "/v1/jobs", newJob)).json<Job>();
    await expect.poll(() => onA.eventsFor(job.id).length).toBe(1);

    // Same description: no change. CREATED can't jump to DELIVERED, and a
    // stale version is refused: both 409.
    const same = await request("PATCH", `/v1/jobs/${job.id}`, {
      baseVersion: 1,
      parcelDescription: job.parcelDescription,
    });
    const invalid = await request("PATCH", `/v1/jobs/${job.id}`, {
      baseVersion: 1,
      status: "DELIVERED",
    });
    const stale = await request("PATCH", `/v1/jobs/${job.id}`, {
      baseVersion: 5,
      parcelDescription: "Stale",
    });
    expect(same.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(409);
    expect(stale.statusCode).toBe(409);
    // A later event proves the earlier requests were already processed.
    await request("PATCH", `/v1/jobs/${job.id}`, {
      baseVersion: 1,
      parcelDescription: "Something else",
    });

    await expect
      .poll(() => onA.eventsFor(job.id).length, { timeout: 5_000 })
      .toBe(2);
    expect(onA.eventsFor(job.id)[1]!.payload.job.version).toBe(2);
  });
});
