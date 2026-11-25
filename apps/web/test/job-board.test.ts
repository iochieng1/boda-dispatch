import type { Job } from "@boda-dispatch/shared";
import { describe, expect, it } from "vitest";

import {
  applyJobs,
  columnsOf,
  emptyBoard,
  RESYNC_OVERLAP_MS,
  resyncSince,
} from "../src/lib/job-board";

const place = { address: "Nairobi", lat: -1.28, lng: 36.81 };
const job = (n: number, overrides: Partial<Job> = {}): Job => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  pickup: place,
  dropoff: place,
  parcelDescription: `Parcel ${n}`,
  status: "CREATED",
  assignedRiderId: null,
  version: 1,
  createdBy: "00000000-0000-4000-8000-0000000000aa",
  createdAt: `2026-11-25T08:00:0${n}.000Z`,
  updatedAt: `2026-11-25T08:00:0${n}.000Z`,
  ...overrides,
});

describe("applyJobs", () => {
  it("adds jobs and tracks the newest updatedAt seen", () => {
    const state = applyJobs(emptyBoard, [job(2), job(1)]);

    expect(Object.keys(state.jobs)).toHaveLength(2);
    expect(state.lastSeen).toBe("2026-11-25T08:00:02.000Z");
  });

  it("keeps the copy with the higher version, whatever the arrival order", () => {
    const v2 = job(1, { version: 2, status: "CANCELLED" });
    const late = job(1, { version: 1 });

    const state = applyJobs(applyJobs(emptyBoard, [v2]), [late]);

    expect(state.jobs[v2.id]).toBe(v2);
  });

  it("is idempotent: applying the same job again returns the same state", () => {
    const once = applyJobs(emptyBoard, [job(1)]);

    expect(applyJobs(once, [job(1)])).toBe(once);
  });

  it("replaces a job with a newer version", () => {
    const first = job(1);
    const next = job(1, {
      version: 2,
      status: "ASSIGNED",
      updatedAt: "2026-11-25T08:00:09.000Z",
    });

    const state = applyJobs(applyJobs(emptyBoard, [first]), [next]);

    expect(state.jobs[first.id]).toBe(next);
    expect(state.lastSeen).toBe(next.updatedAt);
  });

  it("does not mutate the previous state", () => {
    const before = applyJobs(emptyBoard, [job(1)]);
    applyJobs(before, [job(2)]);

    expect(Object.keys(before.jobs)).toHaveLength(1);
  });
});

describe("columnsOf", () => {
  it("groups by status, newest first", () => {
    const state = applyJobs(emptyBoard, [
      job(1),
      job(2),
      job(3, { status: "ASSIGNED", version: 2 }),
    ]);

    const columns = columnsOf(state);

    expect(columns.CREATED.map((j) => j.parcelDescription)).toEqual([
      "Parcel 2",
      "Parcel 1",
    ]);
    expect(columns.ASSIGNED).toHaveLength(1);
    expect(columns.DELIVERED).toEqual([]);
  });

  it("moves a job between columns when its status changes", () => {
    const created = applyJobs(emptyBoard, [job(1)]);
    const moved = applyJobs(created, [
      job(1, { status: "ASSIGNED", version: 2 }),
    ]);

    expect(columnsOf(moved).CREATED).toEqual([]);
    expect(columnsOf(moved).ASSIGNED).toHaveLength(1);
  });
});

describe("resyncSince", () => {
  it("starts a little before the newest update seen", () => {
    const seen = "2026-11-25T08:00:30.000Z";

    expect(Date.parse(seen) - Date.parse(resyncSince(seen))).toBe(
      RESYNC_OVERLAP_MS,
    );
  });
});
