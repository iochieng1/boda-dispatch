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

const BASE = "http://boda-dispatch.invalid";

/**
 * Only same-origin paths are allowed after login, so `?next=` can't bounce a
 * dispatcher to another site (open redirect). The value is resolved the way a
 * browser would (which strips tabs and newlines, so "/\t/evil.com" means
 * "//evil.com") and rejected unless it stays on our origin.
 */
export const safeNextPath = (next: unknown): string => {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/";
  }
  return url.origin === BASE ? url.pathname + url.search + url.hash : "/";
};
