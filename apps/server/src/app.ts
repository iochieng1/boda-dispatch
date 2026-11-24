import fastifyJwt from "@fastify/jwt";
import Fastify from "fastify";
import { Redis } from "ioredis";

import { ACCESS_TOKEN_TTL_SECONDS, authenticate } from "./auth/authenticate.js";
import { createLoginLimiter, type LoginLimiter } from "./auth/login-limit.js";
import { prepareDummyHash } from "./auth/password.js";
import { purgeExpiredRefreshTokens } from "./auth/refresh-tokens.js";

const REFRESH_TOKEN_PURGE_INTERVAL_MS = 60 * 60 * 1000;
import type { Config } from "./config.js";
import { createDb, type Database } from "./db/client.js";
import { attachSocketServer, type SocketServer } from "./realtime/socket.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import jobRoutes from "./routes/jobs.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    redis: Redis;
    io: SocketServer;
    loginLimiter: LoginLimiter;
  }
}

export type BuildAppOptions = {
  /** Redis key prefix for login rate limits; tests give each app its own. */
  rateLimitPrefix?: string;
};

export const buildApp = async (
  config: Config,
  { rateLimitPrefix = "ratelimit:login" }: BuildAppOptions = {},
) => {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on("error", (err) => app.log.error({ err }, "Redis error"));

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("redis", redis);
  app.decorate(
    "loginLimiter",
    createLoginLimiter({
      redis,
      log: app.log,
      prefix: rateLimitPrefix,
      maxPerIp: config.LOGIN_MAX_ATTEMPTS_PER_IP,
      maxPerEmail: config.LOGIN_MAX_ATTEMPTS_PER_EMAIL,
      windowSeconds: config.LOGIN_RATE_WINDOW_SECONDS,
    }),
  );

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    // @fastify/jwt treats a numeric expiresIn as seconds.
    sign: { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    verify: { algorithms: ["HS256"] },
  });
  app.decorateRequest("dispatcher");
  app.decorate("authenticate", authenticate);

  app.decorate("io", attachSocketServer(app, redis));

  // Expired tokens are already rejected; this just keeps the table small.
  const purgeTimer = setInterval(() => {
    purgeExpiredRefreshTokens(db).then(
      (count) =>
        count > 0 && app.log.info({ count }, "Purged expired refresh tokens"),
      (err: unknown) =>
        app.log.error({ err }, "Failed to purge expired refresh tokens"),
    );
  }, REFRESH_TOKEN_PURGE_INTERVAL_MS);
  purgeTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(purgeTimer);
    await Promise.allSettled([sql.end(), redis.quit()]);
  });

  await prepareDummyHash();

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(jobRoutes, { prefix: "/v1/jobs" });

  return app;
};
