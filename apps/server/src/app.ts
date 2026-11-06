import Fastify from "fastify";
import { Redis } from "ioredis";

import type { Config } from "./config.js";
import { createDb, type Database } from "./db/client.js";
import { attachSocketServer, type SocketServer } from "./realtime/socket.js";
import healthRoutes from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    redis: Redis;
    io: SocketServer;
  }
}

export const buildApp = async (config: Config) => {
  const app = Fastify({
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
  app.decorate("io", attachSocketServer(app, redis));

  app.addHook("onClose", async () => {
    await Promise.allSettled([sql.end(), redis.quit()]);
  });

  await app.register(healthRoutes);

  return app;
};
