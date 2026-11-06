import { describe, expect, it } from "vitest";

import {
  createJobInputSchema,
  jobSchema,
  kenyanPhoneSchema,
  mutationEnvelopeSchema,
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
