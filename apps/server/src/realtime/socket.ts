import { createAdapter } from "@socket.io/redis-adapter";
import {
  type ClientToServerEvents,
  DISPATCH_ROOM,
  type DispatcherProfile,
  type ServerToClientEvents,
  SOCKET_UNAUTHORIZED,
  socketAuthSchema,
} from "@boda-dispatch/shared";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { Server, type Socket } from "socket.io";

import { verifyAccessToken } from "../auth/authenticate.js";

export type SocketData = {
  dispatcher: DispatcherProfile;
  /** When the socket's current access token expires (epoch ms). */
  tokenExpiresAt: number;
};

type InterServerEvents = Record<string, never>;

export type SocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Attaches Socket.IO to Fastify's HTTP server. The Redis adapter relays
 * broadcasts through Redis pub/sub, so an event emitted on one instance reaches
 * sockets connected to every other instance.
 *
 * Auth: the handshake must carry a valid access token (`auth: { token }`) or
 * the connection is refused. Access tokens are short-lived, so a connected
 * client sends `auth:refresh` with its next token before the current one
 * expires; the socket (its id and rooms) stays as it is. A socket whose token
 * runs out without a refresh gets `auth:expired` and is disconnected.
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
  });

  // The adapter subscribes as soon as it's created and doesn't handle a
  // failure, so creating it while Redis is unreachable leaves unhandled
  // rejections, which crash Node. Attach it once the subscriber is ready;
  // until then the default in-memory adapter serves this instance alone.
  // ioredis re-subscribes by itself after later reconnects.
  subClient.once("ready", () => {
    io.adapter(createAdapter(pubClient, subClient));
    app.log.debug("Socket.IO Redis adapter attached");
  });

  // Timers can't live on socket.data: the adapter may serialise it.
  const expiryTimers = new WeakMap<AppSocket, NodeJS.Timeout>();

  const scheduleExpiry = (socket: AppSocket, expiresAt: number) => {
    clearTimeout(expiryTimers.get(socket));
    socket.data.tokenExpiresAt = expiresAt;
    const timer = setTimeout(
      () => {
        app.log.debug({ socketId: socket.id }, "Socket token expired");
        socket.emit("auth:expired");
        socket.disconnect();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref();
    expiryTimers.set(socket, timer);
  };

  io.use(async (socket, next) => {
    const parsed = socketAuthSchema.safeParse(socket.handshake.auth);
    const result = parsed.success
      ? await verifyAccessToken(app, parsed.data.token).catch((err) => {
          app.log.error({ err }, "Socket auth failed");
          return undefined;
        })
      : undefined;

    if (!result) {
      return next(new Error(SOCKET_UNAUTHORIZED));
    }

    socket.data.dispatcher = result.dispatcher;
    socket.data.tokenExpiresAt = result.claims.exp * 1000;
    next();
  });

  io.on("connection", (socket) => {
    app.log.debug(
      { socketId: socket.id, dispatcherId: socket.data.dispatcher.id },
      "Socket connected",
    );

    scheduleExpiry(socket, socket.data.tokenExpiresAt);
    // Every authenticated socket is a dispatcher for now; riders will get
    // rooms of their own.
    void socket.join(DISPATCH_ROOM);

    socket.on("auth:refresh", async (payload, ack) => {
      if (typeof ack !== "function") return;

      const parsed = socketAuthSchema.safeParse(payload);
      const result = parsed.success
        ? await verifyAccessToken(app, parsed.data.token).catch(() => undefined)
        : undefined;

      // A token for a different dispatcher must not take over this socket.
      if (!result || result.dispatcher.id !== socket.data.dispatcher.id) {
        return ack({ ok: false, error: SOCKET_UNAUTHORIZED });
      }

      const expiresAt = result.claims.exp * 1000;
      socket.data.dispatcher = result.dispatcher;
      scheduleExpiry(socket, expiresAt);
      ack({ ok: true, expiresAt: new Date(expiresAt).toISOString() });
    });

    socket.on("disconnect", () => {
      clearTimeout(expiryTimers.get(socket));
      expiryTimers.delete(socket);
    });

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
