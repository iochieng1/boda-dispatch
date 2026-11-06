import { createAdapter } from "@socket.io/redis-adapter";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@boda-dispatch/shared";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { Server } from "socket.io";

export type SocketServer = Server<ClientToServerEvents, ServerToClientEvents>;

/**
 * Attaches Socket.IO to Fastify's HTTP server. The Redis adapter relays
 * broadcasts through Redis pub/sub, so an event emitted on one instance reaches
 * sockets connected to every other instance.
 */
export const attachSocketServer = (app: FastifyInstance, redis: Redis) => {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();

  for (const client of [pubClient, subClient]) {
    client.on("error", (err) =>
      app.log.error({ err }, "Socket.IO Redis adapter error"),
    );
  }

  const io: SocketServer = new Server(app.server, {
    cors: { origin: app.config.CORS_ORIGINS },
    adapter: createAdapter(pubClient, subClient),
  });

  io.on("connection", (socket) => {
    app.log.debug({ socketId: socket.id }, "Socket connected");

    socket.emit("server:hello", {
      socketId: socket.id,
      serverTime: new Date().toISOString(),
    });
  });

  // Sockets are long-lived: drop them first so the HTTP server can close.
  app.addHook("preClose", async () => {
    io.local.disconnectSockets(true);
  });

  app.addHook("onClose", async () => {
    await io.close();
    pubClient.disconnect();
    subClient.disconnect();
  });

  return io;
};
