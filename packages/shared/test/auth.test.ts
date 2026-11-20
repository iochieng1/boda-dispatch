import { describe, expect, it } from "vitest";

import { loginInputSchema, tokenPairSchema } from "../src/index.js";

describe("loginInputSchema", () => {
  it("trims the email", () => {
    expect(
      loginInputSchema.parse({ email: " a@b.co ", password: "x" }).email,
    ).toBe("a@b.co");
  });

  it.each([
    ["an empty password", { email: "a@b.co", password: "" }],
    ["a missing email", { password: "secret" }],
    ["unknown keys", { email: "a@b.co", password: "x", admin: true }],
    [
      "a 129-character password",
      { email: "a@b.co", password: "a".repeat(129) },
    ],
  ])("rejects %s", (_, input) => {
    expect(loginInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("tokenPairSchema", () => {
  it("requires the Bearer token type", () => {
    const pair = {
      access_token: "a.b.c",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: "r",
      refresh_expires_in: 604800,
    };
    expect(tokenPairSchema.parse(pair)).toEqual(pair);
    expect(
      tokenPairSchema.safeParse({ ...pair, token_type: "MAC" }).success,
    ).toBe(false);
  });
});
