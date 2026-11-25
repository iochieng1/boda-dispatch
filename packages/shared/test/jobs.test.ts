import { describe, expect, it } from "vitest";

import {
  canTransition,
  cancelJobInputSchema,
  createJobInputSchema,
  JOB_STATUSES,
  jobChangesQuerySchema,
  jobSchema,
  kenyanPhoneSchema,
  listJobsQuerySchema,
  mutationEnvelopeSchema,
  updateJobInputSchema,
} from "../src/index.js";

const location = {
  address: "Kenyatta Ave, Nairobi",
  lat: -1.2864,
  lng: 36.8172,
};

describe("createJobInputSchema", () => {
  it("accepts a valid job and trims text", () => {
    const parsed = createJobInputSchema.parse({
      pickup: location,
      dropoff: { address: " Westlands ", lat: -1.2676, lng: 36.8108 },
      parcelDescription: "  Envelope  ",
    });

    expect(parsed.dropoff.address).toBe("Westlands");
    expect(parsed.parcelDescription).toBe("Envelope");
  });

  it("rejects out-of-range coordinates", () => {
    const result = createJobInputSchema.safeParse({
      pickup: { ...location, lat: 91 },
      dropoff: { ...location, lng: -181 },
      parcelDescription: "Box",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([
      "pickup.lat",
      "dropoff.lng",
    ]);
  });

  it("rejects an empty parcel description", () => {
    expect(
      createJobInputSchema.safeParse({
        pickup: location,
        dropoff: location,
        parcelDescription: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("jobSchema", () => {
  const job = {
    id: "0b9f3a52-4c1e-4f7a-9a43-6a3b2f1c9d10",
    pickup: location,
    dropoff: location,
    parcelDescription: "Box",
    status: "CREATED",
    assignedRiderId: null,
    version: 1,
    createdBy: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    createdAt: "2026-11-06T09:00:00.000Z",
    updatedAt: "2026-11-06T09:00:00.000Z",
  };

  it("accepts a valid job", () => {
    expect(jobSchema.parse(job)).toEqual(job);
  });

  it("rejects an unknown status and a zero version", () => {
    expect(jobSchema.safeParse({ ...job, status: "LOST" }).success).toBe(false);
    expect(jobSchema.safeParse({ ...job, version: 0 }).success).toBe(false);
  });
});

describe("mutationEnvelopeSchema", () => {
  it("requires a UUID client mutation id", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        clientMutationId: "not-a-uuid",
        baseVersion: 1,
      }).success,
    ).toBe(false);
  });
});

describe("kenyanPhoneSchema", () => {
  it.each(["0712345678", "+254712345678", "254 712 345 678", "712-345-678"])(
    "normalises %s",
    (input) => {
      expect(kenyanPhoneSchema.parse(input)).toBe("254712345678");
    },
  );

  it("accepts 01xx numbers", () => {
    expect(kenyanPhoneSchema.parse("0110123456")).toBe("254110123456");
  });

  it.each(["0812345678", "12345", "+255712345678"])("rejects %s", (input) => {
    expect(kenyanPhoneSchema.safeParse(input).success).toBe(false);
  });
});

describe("canTransition", () => {
  it.each([
    ["CREATED", "ASSIGNED"],
    ["ASSIGNED", "PICKED_UP"],
    ["PICKED_UP", "DELIVERED"],
    ["CREATED", "CANCELLED"],
    ["ASSIGNED", "CANCELLED"],
    ["PICKED_UP", "CANCELLED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ["CREATED", "PICKED_UP"],
    ["CREATED", "DELIVERED"],
    ["ASSIGNED", "CREATED"],
    ["ASSIGNED", "DELIVERED"],
    ["PICKED_UP", "ASSIGNED"],
    ["CREATED", "CREATED"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("lets nothing leave DELIVERED or CANCELLED", () => {
    for (const from of ["DELIVERED", "CANCELLED"] as const) {
      for (const to of JOB_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe("updateJobInputSchema", () => {
  const riderId = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

  it("accepts an edit of the parcel on its own", () => {
    expect(
      updateJobInputSchema.parse({ parcelDescription: " Laptop " }),
    ).toEqual({ parcelDescription: "Laptop" });
  });

  it("accepts an assignment with a rider", () => {
    expect(
      updateJobInputSchema.safeParse({
        status: "ASSIGNED",
        assignedRiderId: riderId,
      }).success,
    ).toBe(true);
  });

  it("rejects an empty update", () => {
    expect(updateJobInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects assigning without a rider", () => {
    const result = updateJobInputSchema.safeParse({ status: "ASSIGNED" });
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([
      "assignedRiderId",
    ]);
  });

  it("rejects a rider without the ASSIGNED status", () => {
    expect(
      updateJobInputSchema.safeParse({ assignedRiderId: riderId }).success,
    ).toBe(false);
    expect(
      updateJobInputSchema.safeParse({
        status: "PICKED_UP",
        assignedRiderId: riderId,
      }).success,
    ).toBe(false);
  });

  it("rejects fields a dispatcher may not set", () => {
    expect(
      updateJobInputSchema.safeParse({ version: 9, parcelDescription: "x" })
        .success,
    ).toBe(false);
  });
});

describe("cancelJobInputSchema", () => {
  it("makes the reason optional", () => {
    expect(cancelJobInputSchema.parse({})).toEqual({});
    expect(cancelJobInputSchema.parse({ reason: " Customer called " })).toEqual(
      { reason: "Customer called" },
    );
  });
});

describe("listJobsQuerySchema", () => {
  it("defaults the page size and coerces the limit from a query string", () => {
    expect(listJobsQuerySchema.parse({}).limit).toBe(50);
    expect(listJobsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
  });

  it("rejects an unknown status, a bad cursor and an oversized page", () => {
    expect(listJobsQuerySchema.safeParse({ status: "LOST" }).success).toBe(
      false,
    );
    expect(listJobsQuerySchema.safeParse({ cursor: "abc" }).success).toBe(
      false,
    );
    expect(listJobsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("jobChangesQuerySchema", () => {
  it("requires an ISO `since` and defaults the page size", () => {
    const since = "2026-11-25T08:00:00.000Z";
    expect(jobChangesQuerySchema.parse({ since })).toEqual({
      since,
      limit: 50,
    });
    expect(jobChangesQuerySchema.safeParse({}).success).toBe(false);
    expect(
      jobChangesQuerySchema.safeParse({ since: "yesterday" }).success,
    ).toBe(false);
  });

  it("caps the page size like the job list", () => {
    const since = "2026-11-25T08:00:00.000Z";
    expect(jobChangesQuerySchema.safeParse({ since, limit: 101 }).success).toBe(
      false,
    );
  });
});
