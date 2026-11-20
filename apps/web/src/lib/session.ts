"use client";

import type { DispatcherProfile } from "@boda-dispatch/shared";

import type { SessionPayload } from "./auth-shared";

type Session = {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  dispatcher: DispatcherProfile;
};

/** Refresh this long before expiry so in-flight requests never carry a dead token. */
export const REFRESH_LEAD_MS = 60_000;

// The access token lives only in memory; the refresh token is an httpOnly
// cookie that page JS can't read.
let session: Session | null = null;
let inflight: Promise<Session | null> | null = null;

const listeners = new Set<(session: Session | null) => void>();

const setSession = (next: Session | null) => {
  session = next;
  for (const listener of listeners) listener(session);
};

export const onSessionChange = (listener: (s: Session | null) => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const fromPayload = (payload: SessionPayload): Session => ({
  accessToken: payload.accessToken,
  expiresAt: Date.now() + payload.expiresIn * 1000,
  dispatcher: payload.dispatcher,
});

/**
 * Refresh tokens rotate and a reused one revokes the whole session, so two
 * tabs must never refresh at once with the same cookie. A Web Lock serialises
 * refreshes across tabs: the second tab runs after the first has stored the
 * rotated cookie.
 */
const withRefreshLock = <T>(fn: () => Promise<T>): Promise<T> =>
  typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks.request("boda-dispatch:refresh", fn) as Promise<T>)
    : fn();

const doRefresh = () =>
  withRefreshLock(async () => {
    const res = await fetch("/api/auth/refresh", { method: "POST" });
    if (res.status === 401) {
      setSession(null);
      return null;
    }
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
    const next = fromPayload((await res.json()) as SessionPayload);
    setSession(next);
    return next;
  });

/** Rotates the refresh cookie; resolves null when the session is over. */
export const refreshSession = (): Promise<Session | null> => {
  // One refresh at a time per tab, however many callers ask.
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
};

/** A valid session, refreshing first if the access token is (nearly) expired. */
export const getSession = async (): Promise<Session | null> => {
  if (session && session.expiresAt - Date.now() > REFRESH_LEAD_MS) {
    return session;
  }
  return refreshSession();
};

export const login = async (email: string, password: string) => {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const { message } = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(message ?? "Login failed");
  }
  setSession(fromPayload((await res.json()) as SessionPayload));
};

/**
 * Throws if the logout request didn't go through: the httpOnly cookie can
 * only be cleared by the server, so pretending would leave the dispatcher
 * signed in (on a shared terminal, for the next person too).
 */
export const logout = async () => {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(`Logout failed: ${res.status}`);
  setSession(null);
};

/** Full navigation, so the proxy re-checks the (now missing) cookie. */
export const redirectToLogin = () => {
  const next = window.location.pathname + window.location.search;
  window.location.assign(
    next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`,
  );
};
