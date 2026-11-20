import type { DispatcherProfile } from "@boda-dispatch/shared";

/** httpOnly cookie holding the rotating refresh token. */
export const REFRESH_COOKIE = "boda_refresh";

/** What /api/auth/login and /api/auth/refresh return to the browser. */
export type SessionPayload = {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  dispatcher: DispatcherProfile;
};

/**
 * Only same-site relative paths are allowed after login, so `?next=` can't
 * bounce a dispatcher to another site (open redirect).
 */
export const safeNextPath = (next: unknown) =>
  typeof next === "string" &&
  next.startsWith("/") &&
  !next.startsWith("//") &&
  !next.startsWith("/\\")
    ? next
    : "/";
