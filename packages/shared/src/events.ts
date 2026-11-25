import { z } from "zod";

import type { SocketAuth, SocketAuthRefreshAck } from "./auth.js";
import { jobSchema } from "./jobs.js";

/** Every authenticated dispatcher's socket joins this room. */
export const DISPATCH_ROOM = "dispatch";

/**
 * Carries the job as it is after the write. Events can arrive out of order or
 * twice, so clients keep whichever copy has the higher `version`.
 */
export const jobEventSchema = z.object({ job: jobSchema });
export type JobEvent = z.infer<typeof jobEventSchema>;

export const serverHelloSchema = z.object({
  socketId: z.string().min(1),
  serverTime: z.iso.datetime(),
});
export type ServerHello = z.infer<typeof serverHelloSchema>;

/** Events the server emits to clients. */
export interface ServerToClientEvents {
  "server:hello": (payload: ServerHello) => void;
  /** A job was created. */
  "job:created": (payload: JobEvent) => void;
  /** A job was edited, assigned, advanced or cancelled. */
  "job:updated": (payload: JobEvent) => void;
  /**
   * The socket's access token expired without an `auth:refresh`. The server
   * disconnects right after; the client should refresh and reconnect.
   */
  "auth:expired": () => void;
}

/** Events clients emit to the server. */
export interface ClientToServerEvents {
  /**
   * Swaps in a fresh access token on a live socket, so an expiring token
   * doesn't cost the client its connection (or its rooms).
   */
  "auth:refresh": (
    payload: SocketAuth,
    ack: (result: SocketAuthRefreshAck) => void,
  ) => void;
}
