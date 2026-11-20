import type { NextRequest } from "next/server";

import {
  callApi,
  clearSession,
  errorJson,
  sessionResponse,
} from "@/lib/auth-server";
import { REFRESH_COOKIE } from "@/lib/auth-shared";

/** Rotates the refresh cookie and returns a fresh access token. */
export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return errorJson(401, "Not signed in");

  const res = await callApi("/v1/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  // Expired, revoked or reused: the session is over.
  if (res.status === 401 || res.status === 400) {
    return clearSession(errorJson(401, "Session expired"));
  }
  if (!res.ok) return errorJson(502, "Refresh is unavailable, try again");

  return sessionResponse(await res.json());
}
