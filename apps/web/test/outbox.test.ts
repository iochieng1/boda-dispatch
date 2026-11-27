import type {
  CreateJobInput,
  Job,
  JobEdit,
  JobConflictCode,
} from "@boda-dispatch/shared";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import type { SendResult } from "../src/lib/job-changes";
import {
  countChanges,
  JobRequestError,
  MemoryMutationStore,
  type MutationStore,
  type NewMutation,
  OfflineError,
  type QueuedMutation,
  replayQueue,
  SignedOutError,
  type Transport,
  withPendingEdits,
} from "../src/lib/outbox";
import { IndexedDbMutationStore } from "../src/lib/outbox-store";

const place = { address: "Nairobi", lat: -1.28, lng: 36.81 };
const DISPATCHER = "00000000-0000-4000-8000-0000000000aa";
const jobId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (n: number, overrides: Partial<Job> = {}): Job => ({
  id: jobId(n),
  pickup: place,
  dropoff: place,
  parcelDescription: `Parcel ${n}`,
  status: "CREATED",
  assignedRiderId: null,
  version: 1,
  createdBy: DISPATCHER,
  createdAt: "2026-11-27T08:00:00.000Z",
  updatedAt: "2026-11-27T08:00:00.000Z",
  ...overrides,
});

let ids = 0;
const nextId = () =>
  `00000000-0000-4000-9000-${String(++ids).padStart(12, "0")}`;

const editOf = (base: Job, edit: JobEdit): NewMutation => ({
  id: nextId(),
  dispatcherId: DISPATCHER,
  queuedAt: new Date().toISOString(),
  state: { kind: "pending" },
  kind: "edit",
  jobId: base.id,
  base,
  edit,
});

const createOf = (input: CreateJobInput): NewMutation => ({
  id: nextId(),
  dispatcherId: DISPATCHER,
  queuedAt: new Date().toISOString(),
  state: { kind: "pending" },
  kind: "create",
  input,
});

/**
 * A small stand-in for the API: versions, compare-and-swap and mutation-id
 * dedupe behave like the server's. It can be offline, refuse, or apply a
 * change and then lose the answer.
 */
class FakeApi implements Transport {
  jobs = new Map<string, Job>();
  applied = new Map<string, string>();
  online = true;
  loseNextAck = false;
  refuseWith: Error | null = null;
  received: {
    jobId: string;
    edit: JobEdit;
    baseVersion: number;
    id: string;
  }[] = [];

  constructor(...jobs: Job[]) {
    for (const j of jobs) this.jobs.set(j.id, j);
  }

  /** Someone else's change, straight to the server. */
  theirs(id: string, change: Partial<Job>) {
    const current = this.jobs.get(id)!;
    this.jobs.set(id, { ...current, ...change, version: current.version + 1 });
  }

  private answer<T>(result: T): T {
    if (this.loseNextAck) {
      this.loseNextAck = false;
      throw new OfflineError();
    }
    return result;
  }

  create = async (input: CreateJobInput, id: string): Promise<Job> => {
    if (!this.online) throw new OfflineError();
    if (this.refuseWith) throw this.refuseWith;
    const existing = this.applied.get(id);
    if (existing) return this.jobs.get(existing)!;
    const created = job(100 + this.jobs.size, {
      parcelDescription: input.parcelDescription,
    });
    this.jobs.set(created.id, created);
    this.applied.set(id, created.id);
    return this.answer(created);
  };

  edit = async (
    jobId: string,
    edit: JobEdit,
    baseVersion: number,
    id: string,
  ): Promise<SendResult> => {
    if (!this.online) throw new OfflineError();
    if (this.refuseWith) throw this.refuseWith;
    this.received.push({ jobId, edit, baseVersion, id });
    const current = this.jobs.get(jobId)!;
    if (this.applied.has(id)) return { kind: "ok", job: current };

    const conflict = (code: JobConflictCode): SendResult => ({
      kind: "conflict",
      conflict: {
        statusCode: 409,
        error: "Conflict",
        code,
        message: code,
        job: current,
      },
    });
    if (current.status === "CANCELLED") return conflict("JOB_CLOSED");
    if (current.version !== baseVersion) return conflict("VERSION_CONFLICT");

    const next = { ...current, ...edit, version: current.version + 1 };
    this.jobs.set(jobId, next);
    this.applied.set(id, jobId);
    return this.answer({ kind: "ok", job: next });
  };
}

describe("replayQueue", () => {
  let store: MemoryMutationStore;
  beforeEach(() => {
    store = new MemoryMutationStore();
  });

  const replay = (api: Transport, settled: unknown[] = []) =>
    replayQueue(store, DISPATCHER, api, (m, s) => settled.push([m.id, s]));

  /**
   * Queues an edit the way the dashboard does: based on the job as shown,
   * with the dispatcher's earlier waiting changes applied.
   */
  const queueEdit = async (server: Job, edit: JobEdit) => {
    const shown = withPendingEdits(server, await store.list(DISPATCHER));
    return store.add(editOf(shown, edit));
  };

  it("syncs three edits made offline, in order, once back online", async () => {
    const original = job(1);
    const api = new FakeApi(original);
    api.online = false;

    await queueEdit(original, { parcelDescription: "Box" });
    await queueEdit(original, { dropoff: { ...place, address: "Westlands" } });
    await queueEdit(original, { parcelDescription: "Two boxes" });

    expect(await replay(api)).toBe("offline");
    expect(await store.list(DISPATCHER)).toHaveLength(3);

    api.online = true;
    expect(await replay(api)).toBe("done");

    expect(await store.list(DISPATCHER)).toEqual([]);
    expect(api.jobs.get(original.id)).toMatchObject({
      parcelDescription: "Two boxes",
      dropoff: { address: "Westlands" },
      version: 4,
    });
    // Each was sent in order and applied once; later ones were rebased onto
    // the earlier ones without asking.
    const applied = api.received.filter((r) => api.applied.has(r.id));
    expect(new Set(applied.map((r) => r.id)).size).toBe(3);
    expect(api.received.map((r) => r.edit)).toEqual([
      { parcelDescription: "Box" },
      { dropoff: { ...place, address: "Westlands" } },
      { dropoff: { ...place, address: "Westlands" } },
      { parcelDescription: "Two boxes" },
      { parcelDescription: "Two boxes" },
    ]);
  });

  it("stops at the first offline failure and keeps the rest in order", async () => {
    const [a, b] = [job(1), job(2)];
    const api = new FakeApi(a, b);
    await queueEdit(a, { parcelDescription: "A" });
    await queueEdit(b, { parcelDescription: "B" });
    api.online = false;

    expect(await replay(api)).toBe("offline");
    expect((await store.list(DISPATCHER)).map((m) => m.state.kind)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("applies a change whose answer was lost only once when replayed", async () => {
    const original = job(1);
    const api = new FakeApi(original);
    const queued = await queueEdit(original, { parcelDescription: "Box" });

    api.loseNextAck = true;
    expect(await replay(api)).toBe("offline");
    // The server has it, but the dashboard doesn't know.
    expect(api.jobs.get(original.id)!.version).toBe(2);
    expect(await store.list(DISPATCHER)).toHaveLength(1);

    expect(await replay(api)).toBe("done");
    expect(api.jobs.get(original.id)!.version).toBe(2);
    expect(api.received.map((r) => r.id)).toEqual([queued.id, queued.id]);
    expect(await store.list(DISPATCHER)).toEqual([]);
  });

  it("creates a job queued offline once, even after a lost answer", async () => {
    const api = new FakeApi();
    const input = {
      pickup: place,
      dropoff: place,
      parcelDescription: "Made offline",
    };
    await store.add(createOf(input));
    api.loseNextAck = true;

    expect(await replay(api)).toBe("offline");
    const settled: unknown[] = [];
    expect(await replay(api, settled)).toBe("done");

    expect(api.jobs.size).toBe(1);
    expect(settled).toEqual([
      [expect.any(String), { kind: "saved", job: [...api.jobs.values()][0] }],
    ]);
  });

  it("keeps a conflicting change for the dispatcher and holds that job's later ones", async () => {
    const [a, b] = [job(1), job(2)];
    const api = new FakeApi(a, b);
    api.online = false;
    const mine = await queueEdit(a, { parcelDescription: "Mine" });
    const later = await queueEdit(a, { status: "CANCELLED" });
    await queueEdit(b, { parcelDescription: "Other job" });

    // Meanwhile someone else changes the same field differently.
    api.theirs(a.id, { parcelDescription: "Theirs" });
    api.online = true;
    const settled: [string, { kind: string }][] = [];
    expect(await replay(api, settled)).toBe("done");

    const left = await store.list(DISPATCHER);
    expect(left.map((m) => [m.id, m.state.kind])).toEqual([
      [mine.id, "conflict"],
      [later.id, "pending"],
    ]);
    expect(left[0]!.state).toMatchObject({
      kind: "conflict",
      fields: ["parcelDescription"],
      latest: { parcelDescription: "Theirs", version: 2 },
    });
    // The other job's change went through; the held cancel was never sent.
    expect(api.jobs.get(b.id)!.parcelDescription).toBe("Other job");
    expect(api.jobs.get(a.id)!.status).toBe("CREATED");
    expect(settled.map(([id, s]) => [id, s.kind])).toEqual([
      [mine.id, "conflict"],
      [expect.any(String), "saved"],
    ]);
    expect(countChanges(left)).toEqual({ waiting: 1, attention: 1 });

    // Keep theirs: the held change goes next time.
    await store.remove(left[0]!);
    expect(await replay(api)).toBe("done");
    expect(api.jobs.get(a.id)).toMatchObject({
      status: "CANCELLED",
      parcelDescription: "Theirs",
    });
  });

  it("keeps a refused change with the server's message", async () => {
    const closed = job(1, { status: "CANCELLED" });
    const api = new FakeApi(closed);
    await store.add(editOf(job(1), { parcelDescription: "Late" }));

    expect(await replay(api)).toBe("done");
    expect((await store.list(DISPATCHER))[0]!.state).toEqual({
      kind: "refused",
      message: "JOB_CLOSED",
      latest: closed,
    });
  });

  it("keeps a create the API rejects, with its field errors", async () => {
    const api = new FakeApi();
    api.refuseWith = new JobRequestError("Invalid request body", {
      parcelDescription: "Too long",
    });
    await store.add(
      createOf({ pickup: place, dropoff: place, parcelDescription: "x" }),
    );

    expect(await replay(api)).toBe("done");
    expect((await store.list(DISPATCHER))[0]!.state).toEqual({
      kind: "refused",
      message: "Invalid request body",
      fieldErrors: { parcelDescription: "Too long" },
    });
  });

  it("stops without touching the queue when signed out", async () => {
    const api = new FakeApi(job(1));
    api.refuseWith = new SignedOutError();
    await queueEdit(job(1), { parcelDescription: "Box" });

    expect(await replay(api)).toBe("signed_out");
    expect((await store.list(DISPATCHER))[0]!.state.kind).toBe("pending");
  });

  it("replays only the signed-in dispatcher's changes", async () => {
    const api = new FakeApi(job(1));
    await store.add({
      ...editOf(job(1), { parcelDescription: "Someone else's" }),
      dispatcherId: "00000000-0000-4000-8000-0000000000bb",
    });

    expect(await replay(api)).toBe("done");
    expect(api.received).toEqual([]);
  });
});

describe("withPendingEdits", () => {
  it("shows waiting changes on top of the server's job, keeping its version", () => {
    const server = job(1, { version: 3 });
    const pending = [
      { ...editOf(server, { parcelDescription: "Box" }), seq: 1 },
      { ...editOf(server, { status: "CANCELLED" }), seq: 2 },
    ] as QueuedMutation[];

    expect(withPendingEdits(server, pending)).toEqual({
      ...server,
      parcelDescription: "Box",
      status: "CANCELLED",
    });
  });

  it("leaves out conflicted changes and other jobs' changes", () => {
    const server = job(1);
    const conflicted = {
      ...editOf(server, { parcelDescription: "Mine" }),
      seq: 1,
      state: {
        kind: "conflict",
        latest: server,
        fields: ["parcelDescription"],
      },
    } as QueuedMutation;
    const other = {
      ...editOf(job(2), { parcelDescription: "Other" }),
      seq: 2,
    } as QueuedMutation;

    expect(withPendingEdits(server, [conflicted, other])).toBe(server);
  });
});

describe.each([
  ["MemoryMutationStore", () => new MemoryMutationStore()],
  [
    "IndexedDbMutationStore",
    () => new IndexedDbMutationStore(new IDBFactory()),
  ],
] as const)("%s", (_, makeStore) => {
  let store: MutationStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("lists a dispatcher's changes in the order they were added", async () => {
    const first = await store.add(editOf(job(1), { parcelDescription: "1" }));
    await store.add({
      ...editOf(job(1), { parcelDescription: "x" }),
      dispatcherId: "00000000-0000-4000-8000-0000000000bb",
    });
    const second = await store.add(editOf(job(2), { parcelDescription: "2" }));

    const listed = await store.list(DISPATCHER);
    expect(listed.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it("updates and removes a change", async () => {
    const a = await store.add(editOf(job(1), { parcelDescription: "1" }));
    const b = await store.add(editOf(job(2), { parcelDescription: "2" }));

    await store.put({
      ...a,
      state: { kind: "refused", message: "No" },
    });
    await store.remove(b);

    expect(await store.list(DISPATCHER)).toEqual([
      { ...a, state: { kind: "refused", message: "No" } },
    ]);
  });
});

describe("IndexedDbMutationStore", () => {
  it("keeps queued changes across a reload", async () => {
    const factory = new IDBFactory();
    const queued = await new IndexedDbMutationStore(factory).add(
      editOf(job(1), { parcelDescription: "Box" }),
    );

    const reopened = new IndexedDbMutationStore(factory);
    expect(await reopened.list(DISPATCHER)).toEqual([queued]);
  });
});
