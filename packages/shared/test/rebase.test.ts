import { describe, expect, it } from "vitest";

import { type Job, rebaseJobEdit } from "../src/index.js";

const riderA = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const riderB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const base: Job = {
  id: "0b9f3a52-4c1e-4f7a-9a43-6a3b2f1c9d10",
  pickup: { address: "Kenyatta Ave", lat: -1.2864, lng: 36.8172 },
  dropoff: { address: "Westlands", lat: -1.2676, lng: 36.8108 },
  parcelDescription: "Envelope",
  status: "CREATED",
  assignedRiderId: null,
  version: 4,
  createdBy: riderA,
  createdAt: "2026-11-26T09:00:00.000Z",
  updatedAt: "2026-11-26T09:00:00.000Z",
};

/** The job after someone else's change. */
const moved = (changes: Partial<Job>): Job => ({
  ...base,
  ...changes,
  version: base.version + 1,
});

describe("rebaseJobEdit", () => {
  it("reapplies an edit to a field nobody else touched", () => {
    const latest = moved({ parcelDescription: "Two envelopes" });
    const dropoff = { ...base.dropoff, address: "Yaya Centre" };

    expect(rebaseJobEdit(base, latest, { dropoff })).toEqual({
      kind: "rebased",
      edit: { dropoff },
      baseVersion: 5,
    });
  });

  it("reapplies an assignment over someone else's address edit", () => {
    const latest = moved({ pickup: { ...base.pickup, address: "CBD" } });
    const edit = { status: "ASSIGNED" as const, assignedRiderId: riderA };

    expect(rebaseJobEdit(base, latest, edit)).toEqual({
      kind: "rebased",
      edit,
      baseVersion: 5,
    });
  });

  it("flags both sides changing the same field differently", () => {
    const latest = moved({ parcelDescription: "Box" });
    expect(rebaseJobEdit(base, latest, { parcelDescription: "Bag" })).toEqual({
      kind: "conflict",
      fields: ["parcelDescription"],
    });
  });

  it("flags two different riders assigned at once", () => {
    const latest = moved({ status: "ASSIGNED", assignedRiderId: riderB });
    expect(
      rebaseJobEdit(base, latest, {
        status: "ASSIGNED",
        assignedRiderId: riderA,
      }),
    ).toEqual({ kind: "conflict", fields: ["status"] });
  });

  it("flags a cancel after the job was assigned meanwhile", () => {
    const latest = moved({ status: "ASSIGNED", assignedRiderId: riderB });
    expect(rebaseJobEdit(base, latest, { status: "CANCELLED" })).toEqual({
      kind: "conflict",
      fields: ["status"],
    });
  });

  it("drops a change someone else already made", () => {
    const latest = moved({ status: "ASSIGNED", assignedRiderId: riderA });
    expect(
      rebaseJobEdit(base, latest, {
        status: "ASSIGNED",
        assignedRiderId: riderA,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("keeps the fields that still apply and drops the ones already made", () => {
    const latest = moved({ parcelDescription: "Bag" });
    expect(
      rebaseJobEdit(base, latest, {
        parcelDescription: "Bag",
        dropoff: base.pickup,
      }),
    ).toEqual({
      kind: "rebased",
      edit: { dropoff: base.pickup },
      baseVersion: 5,
    });
  });

  it("reports every conflicting field, even when others would apply", () => {
    const latest = moved({
      parcelDescription: "Box",
      dropoff: { ...base.dropoff, address: "Karen" },
    });
    expect(
      rebaseJobEdit(base, latest, {
        parcelDescription: "Bag",
        dropoff: { ...base.dropoff, address: "Kilimani" },
        pickup: { ...base.pickup, address: "CBD" },
      }),
    ).toEqual({ kind: "conflict", fields: ["dropoff", "parcelDescription"] });
  });
});
