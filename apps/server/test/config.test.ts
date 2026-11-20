import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-jwt-secret-that-is-at-least-32-chars",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(validEnv)).toEqual({
      ...validEnv,
      NODE_ENV: "development",
      PORT: 4000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      REFRESH_REUSE_GRACE_SECONDS: 30,
      CORS_ORIGINS: ["http://localhost:3000"],
    });
  });

  it("coerces PORT to a number", () => {
    expect(loadConfig({ ...validEnv, PORT: "8080" }).PORT).toBe(8080);
  });

  it("splits and trims CORS_ORIGINS", () => {
    expect(
      loadConfig({
        ...validEnv,
        CORS_ORIGINS: "https://boda.example, http://localhost:3000",
      }).CORS_ORIGINS,
    ).toEqual(["https://boda.example", "http://localhost:3000"]);
  });

  it("rejects an invalid CORS origin", () => {
    expect(() =>
      loadConfig({ ...validEnv, CORS_ORIGINS: "not a url" }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "staging" })).toThrow(
      /NODE_ENV/,
    );
  });

  it("rejects a JWT_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrow(
      /JWT_SECRET/,
    );
  });

  it("fails fast and lists every missing variable", () => {
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET/,
    );
  });
});
