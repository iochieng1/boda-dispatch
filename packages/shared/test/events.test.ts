import { describe, expect, it } from "vitest";

import { serverHelloSchema } from "../src/index.js";

describe("serverHelloSchema", () => {
  it("accepts a hello payload", () => {
    const hello = { socketId: "abc123", serverTime: new Date().toISOString() };
    expect(serverHelloSchema.parse(hello)).toEqual(hello);
  });

  it("rejects a non-ISO server time", () => {
    expect(
      serverHelloSchema.safeParse({ socketId: "abc", serverTime: "yesterday" })
        .success,
    ).toBe(false);
  });
});
