import {
  dispatcherProfileSchema,
  type TokenPair,
  tokenPairSchema,
} from "@boda-dispatch/shared";
import { NextResponse } from "next/server";

import { REFRESH_COOKIE, type SessionPayload } from "./auth-shared";

/** The API, as reached from the Next server (may differ from the browser's). */
export const API_URL =
  process.env.SERVER_URL ??
  process.env.NEXT_PUBLIC_SERVER_URL ??
  "http://localhost:4000";

export const callApi = (path: string, init: RequestInit = {}) =>
  fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    cache: "no-store",
  });

/**
 * Turns an API token pair into the browser's response: the refresh token goes
 * into an httpOnly cookie (never readable by page JS), the short-lived access
 * token and the dispatcher's profile go in the body.
 */
export const sessionResponse = async (raw: unknown) => {
  const pair: TokenPair = tokenPairSchema.parse(raw);

  const me = await callApi("/v1/auth/me", {
    headers: { authorization: `Bearer ${pair.access_token}` },
  });
  if (!me.ok) throw new Error(`GET /v1/auth/me failed: ${me.status}`);

  const body: SessionPayload = {
    accessToken: pair.access_token,
    expiresIn: pair.expires_in,
    dispatcher: dispatcherProfileSchema.parse(await me.json()),
  };
  const response = NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
  });
  response.cookies.set(REFRESH_COOKIE, pair.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: not sent on cross-site POSTs, so other sites can't drive refresh.
    sameSite: "lax",
    path: "/",
    maxAge: pair.refresh_expires_in,
  });
  return response;
};

export const clearSession = (response: NextResponse) => {
  response.cookies.delete(REFRESH_COOKIE);
  return response;
};

export const errorJson = (status: number, message: string) =>
  NextResponse.json({ message }, { status });
