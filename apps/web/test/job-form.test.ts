import { describe, expect, it } from "vitest";

import { parseJobForm } from "../src/lib/job-form";

const filled = (overrides: Record<string, string> = {}) => {
  const form = new FormData();
  const values: Record<string, string> = {
    "pickup.address": " Kenyatta Ave, Nairobi ",
    "pickup.lat": "-1.2864",
    "pickup.lng": "36.8172",
    "dropoff.address": "Westlands, Nairobi",
    "dropoff.lat": "-1.2676",
    "dropoff.lng": "36.8108",
    parcelDescription: "Envelope",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
};

describe("parseJobForm", () => {
  it("builds a job input and trims the text", () => {
    expect(parseJobForm(filled())).toEqual({
      ok: true,
      input: {
        pickup: {
          address: "Kenyatta Ave, Nairobi",
          lat: -1.2864,
          lng: 36.8172,
        },
        dropoff: { address: "Westlands, Nairobi", lat: -1.2676, lng: 36.8108 },
        parcelDescription: "Envelope",
      },
    });
  });

  it("reports a message for each bad field", () => {
    const result = parseJobForm(
      filled({ "pickup.address": "  ", "dropoff.lat": "91" }),
    );

    expect(result.ok).toBe(false);
    expect(Object.keys(!result.ok ? result.errors : {}).sort()).toEqual([
      "dropoff.lat",
      "pickup.address",
    ]);
  });

  it("treats a blank coordinate as missing rather than 0", () => {
    const result = parseJobForm(filled({ "pickup.lat": "" }));

    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors)).toEqual(["pickup.lat"]);
  });

  it("rejects text typed into a coordinate", () => {
    const result = parseJobForm(filled({ "dropoff.lng": "nairobi" }));
    expect(!result.ok && Object.keys(result.errors)).toEqual(["dropoff.lng"]);
  });
});
