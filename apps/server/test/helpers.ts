import { randomUUID } from "node:crypto";

import type { TokenPair } from "@boda-dispatch/shared";
import { inject } from "vitest";

import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { type Config, loadConfig } from "../src/config.js";
import { dispatchers } from "../src/db/schema.js";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    JWT_SECRET: "test-jwt-secret-that-is-at-least-32-chars",
  }),
  ...overrides,
});

export const buildTestApp = (overrides: Partial<Config> = {}) =>
  buildApp(testConfig(overrides));

type App = Awaited<ReturnType<typeof buildApp>>;

export const DISPATCHER_PASSWORD = "correct-horse-battery";

/** Inserts a dispatcher with a unique email; returns its id and credentials. */
export const createDispatcher = async (app: App, name = "Jane Wanjiru") => {
  const email = `dispatcher-${randomUUID()}@boda.example`;
  const [row] = await app.db
    .insert(dispatchers)
    .values({
      email,
      name,
      passwordHash: await hashPassword(DISPATCHER_PASSWORD),
    })
    .returning({ id: dispatchers.id });
  return { id: row!.id, email, name, password: DISPATCHER_PASSWORD };
};

/** Logs in through the API and returns the token pair. */
export const loginAs = async (
  app: App,
  credentials: { email: string; password: string },
) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: credentials.email, password: credentials.password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed: ${res.statusCode} ${res.body}`);
  }
  return res.json<TokenPair>();
};
