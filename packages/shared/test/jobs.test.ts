import { describe, expect, it } from "vitest";

import {
  canTransition,
  cancelJobInputSchema,
  clientMutationIdSchema,
  createJobInputSchema,
  JOB_STATUSES,
  jobChangesQuerySchema,
  jobConflictSchema,
  jobSchema,
  kenyanPhoneSchema,
  listJobsQuerySchema,
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

const validJob = {
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

describe("jobSchema", () => {
  const job = validJob;

  it("accepts a valid job", () => {
    expect(jobSchema.parse(job)).toEqual(job);
  });

  it("rejects an unknown status and a zero version", () => {
    expect(jobSchema.safeParse({ ...job, status: "LOST" }).success).toBe(false);
    expect(jobSchema.safeParse({ ...job, version: 0 }).success).toBe(false);
  });
});

describe("clientMutationId", () => {
  const id = "00000000-0000-4000-8000-000000000123";

  it("is optional on a create, an edit and a cancel", () => {
    expect(
      updateJobInputSchema.safeParse({ baseVersion: 1, status: "CANCELLED" })
        .success,
    ).toBe(true);
    expect(cancelJobInputSchema.safeParse({ baseVersion: 1 }).success).toBe(
      true,
    );
  });

  it("is accepted as a UUID on every mutation", () => {
    expect(
      updateJobInputSchema.safeParse({
        baseVersion: 1,
        status: "CANCELLED",
        clientMutationId: id,
      }).success,
    ).toBe(true);
    expect(
      cancelJobInputSchema.safeParse({ baseVersion: 1, clientMutationId: id })
        .success,
    ).toBe(true);
    expect(clientMutationIdSchema.safeParse(id).success).toBe(true);
  });

  it("must be a UUID", () => {
    expect(clientMutationIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(
      cancelJobInputSchema.safeParse({
        baseVersion: 1,
        clientMutationId: "not-a-uuid",
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
  const v = { baseVersion: 3 };

  it("accepts an edit of the parcel on its own", () => {
    expect(
      updateJobInputSchema.parse({ ...v, parcelDescription: " Laptop " }),
    ).toEqual({ ...v, parcelDescription: "Laptop" });
  });

  it("accepts an assignment with a rider", () => {
    expect(
      updateJobInputSchema.safeParse({
        ...v,
        status: "ASSIGNED",
        assignedRiderId: riderId,
      }).success,
    ).toBe(true);
  });

  it("requires the version the change was based on", () => {
    const result = updateJobInputSchema.safeParse({ parcelDescription: "x" });
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([
      "baseVersion",
    ]);
    expect(
      updateJobInputSchema.safeParse({ baseVersion: 0, parcelDescription: "x" })
        .success,
    ).toBe(false);
  });

  it("rejects an update with nothing but a version", () => {
    const result = updateJobInputSchema.safeParse(v);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      "Nothing to update",
    ]);
  });

  it("rejects assigning without a rider", () => {
    const result = updateJobInputSchema.safeParse({ ...v, status: "ASSIGNED" });
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([
      "assignedRiderId",
    ]);
  });

  it("rejects a rider without the ASSIGNED status", () => {
    expect(
      updateJobInputSchema.safeParse({ ...v, assignedRiderId: riderId })
        .success,
    ).toBe(false);
    expect(
      updateJobInputSchema.safeParse({
        ...v,
        status: "PICKED_UP",
        assignedRiderId: riderId,
      }).success,
    ).toBe(false);
  });

  it("rejects fields a dispatcher may not set", () => {
    expect(
      updateJobInputSchema.safeParse({
        ...v,
        version: 9,
        parcelDescription: "x",
      }).success,
    ).toBe(false);
  });
});

describe("cancelJobInputSchema", () => {
  it("requires the version and makes the reason optional", () => {
    expect(cancelJobInputSchema.parse({ baseVersion: 2 })).toEqual({
      baseVersion: 2,
    });
    expect(
      cancelJobInputSchema.parse({
        baseVersion: 2,
        reason: " Customer called ",
      }),
    ).toEqual({ baseVersion: 2, reason: "Customer called" });
    expect(cancelJobInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("jobConflictSchema", () => {
  it("parses a 409 body and rejects an unknown code", () => {
    const body = {
      statusCode: 409,
      error: "Conflict",
      code: "VERSION_CONFLICT",
      message: "Job has changed",
      job: validJob,
    };
    expect(jobConflictSchema.parse(body)).toEqual(body);
    expect(jobConflictSchema.safeParse({ ...body, code: "OOPS" }).success).toBe(
      false,
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
