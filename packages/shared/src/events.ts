import { z } from "zod";

export const serverHelloSchema = z.object({
  socketId: z.string().min(1),
  serverTime: z.iso.datetime(),
});
export type ServerHello = z.infer<typeof serverHelloSchema>;

/** Events the server emits to clients. */
export interface ServerToClientEvents {
  "server:hello": (payload: ServerHello) => void;
}

/** Events clients emit to the server. Empty until job mutations land. */
export type ClientToServerEvents = Record<string, never>;
