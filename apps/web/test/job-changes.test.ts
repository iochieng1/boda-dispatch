import type { Job, JobConflictCode, JobEdit } from "@boda-dispatch/shared";
import { describe, expect, it, vi } from "vitest";

import {
  canUseMine,
  MAX_REBASES,
  type SaveResult,
  saveJobEdit,
  type SendChange,
  type SendResult,
} from "../src/lib/job-changes";

const place = { address: "Nairobi", lat: -1.28, lng: 36.81 };
const base: Job = {
  id: "00000000-0000-4000-8000-000000000001",
  pickup: place,
  dropoff: place,
  parcelDescription: "Envelope",
  status: "CREATED",
  assignedRiderId: null,
  version: 1,
  createdBy: "00000000-0000-4000-8000-0000000000aa",
  createdAt: "2026-11-26T08:00:00.000Z",
  updatedAt: "2026-11-26T08:00:00.000Z",
};
const rider = "00000000-0000-4000-8000-0000000000bb";

const ok = (job: Job): SendResult => ({ kind: "ok", job });
const conflict = (
  job: Job,
  code: JobConflictCode = "VERSION_CONFLICT",
): SendResult => ({
  kind: "conflict",
  conflict: { statusCode: 409, error: "Conflict", code, message: code, job },
});

/** A server that answers each call in turn and records what it was sent. */
const server = (...answers: SendResult[]) => {
  const send = vi.fn<SendChange>();
  for (const answer of answers) send.mockResolvedValueOnce(answer);
  return send;
};

describe("saveJobEdit", () => {
  it("saves on the first try when nobody else got there first", async () => {
    const saved = { ...base, parcelDescription: "Box", version: 2 };
    const send = server(ok(saved));

    expect(await saveJobEdit(base, { parcelDescription: "Box" }, send)).toEqual(
      { kind: "saved", job: saved },
    );
    expect(send).toHaveBeenCalledWith({ parcelDescription: "Box" }, 1);
  });

  it("rebases onto a change to other fields and retries on its version", async () => {
    const theirs = {
      ...base,
      status: "ASSIGNED" as const,
      assignedRiderId: rider,
      version: 2,
    };
    const saved = { ...theirs, parcelDescription: "Box", version: 3 };
    const send = server(conflict(theirs), ok(saved));

    const result = await saveJobEdit(base, { parcelDescription: "Box" }, send);

    expect(result).toEqual({ kind: "saved", job: saved });
    expect(send.mock.calls).toEqual([
      [{ parcelDescription: "Box" }, 1],
      [{ parcelDescription: "Box" }, 2],
    ]);
  });

  it("asks a person when both changed the same field", async () => {
    const theirs = { ...base, parcelDescription: "Bag", version: 2 };
    const edit: JobEdit = { parcelDescription: "Box" };
    const send = server(conflict(theirs));

    expect(await saveJobEdit(base, edit, send)).toEqual({
      kind: "conflict",
      latest: theirs,
      edit,
      fields: ["parcelDescription"],
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks before cancelling a job that was assigned meanwhile", async () => {
    const theirs = {
      ...base,
      status: "ASSIGNED" as const,
      assignedRiderId: rider,
      version: 2,
    };
    const result = await saveJobEdit(
      base,
      { status: "CANCELLED" },
      server(conflict(theirs)),
    );
    expect(result).toMatchObject({ kind: "conflict", fields: ["status"] });
  });

  it("stops without resending when someone already made the same change", async () => {
    const theirs = { ...base, parcelDescription: "Box", version: 2 };
    const send = server(conflict(theirs));

    expect(await saveJobEdit(base, { parcelDescription: "Box" }, send)).toEqual(
      { kind: "saved", job: theirs },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up on a refusal a rebase can't fix", async () => {
    const closed = { ...base, status: "DELIVERED" as const, version: 5 };
    const result = await saveJobEdit(
      base,
      { parcelDescription: "Box" },
      server(conflict(closed, "JOB_CLOSED")),
    );
    expect(result).toEqual({
      kind: "refused",
      latest: closed,
      message: "JOB_CLOSED",
    });
  });

  it("gives up after a bounded number of rebases", async () => {
    // Someone keeps editing the pickup; each retry loses the race again.
    const answers = Array.from({ length: MAX_REBASES + 1 }, (_, i) =>
      conflict({
        ...base,
        pickup: { ...place, address: `Stop ${i}` },
        version: i + 2,
      }),
    );
    const send = server(...answers);

    const result = await saveJobEdit(base, { parcelDescription: "Box" }, send);

    expect(result.kind).toBe("refused");
    expect(send).toHaveBeenCalledTimes(MAX_REBASES + 1);
  });
});

type Conflict = Extract<SaveResult, { kind: "conflict" }>;

describe("canUseMine", () => {
  const assigned = {
    ...base,
    status: "ASSIGNED" as const,
    assignedRiderId: rider,
    version: 2,
  };
  const conflictWith = (latest: Job, edit: JobEdit): Conflict => ({
    kind: "conflict",
    latest,
    edit,
    fields: [],
  });

  it("allows overriding a field edit or a cancel that still applies", () => {
    expect(
      canUseMine(conflictWith(assigned, { parcelDescription: "Box" })),
    ).toBe(true);
    expect(canUseMine(conflictWith(assigned, { status: "CANCELLED" }))).toBe(
      true,
    );
  });

  it("refuses re-assigning a job someone else already assigned", () => {
    expect(
      canUseMine(
        conflictWith(assigned, { status: "ASSIGNED", assignedRiderId: rider }),
      ),
    ).toBe(false);
  });
});
