import { z } from "zod";

export const loginInputSchema = z
  .object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginInput = z.infer<typeof loginInputSchema>;

export const refreshInputSchema = z
  .object({ refresh_token: z.string().min(1).max(128) })
  .strict();
export type RefreshInput = z.infer<typeof refreshInputSchema>;

export const dispatcherProfileSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
});
export type DispatcherProfile = z.infer<typeof dispatcherProfileSchema>;

export const tokenPairSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  /** Access token lifetime in seconds. */
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  /** Refresh token lifetime in seconds. */
  refresh_expires_in: z.number().int().positive(),
  /** Who the tokens belong to, so clients need no extra request. */
  dispatcher: dispatcherProfileSchema,
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/** Sent in the Socket.IO handshake (`auth`) and with `auth:refresh`. */
export const socketAuthSchema = z.object({ token: z.string().min(1) });
export type SocketAuth = z.infer<typeof socketAuthSchema>;

/** `connect_error.message` when the handshake token is missing or invalid. */
export const SOCKET_UNAUTHORIZED = "unauthorized";

export type SocketAuthRefreshAck =
  | { ok: true; expiresAt: string }
  | { ok: false; error: typeof SOCKET_UNAUTHORIZED };
