import { type NextRequest, NextResponse } from "next/server";

import { callApi, clearSession } from "@/lib/auth-server";
import { REFRESH_COOKIE } from "@/lib/auth-shared";

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    // Best effort: the cookie is cleared even if the API is unreachable.
    await callApi("/v1/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => undefined);
  }
  return clearSession(new NextResponse(null, { status: 204 }));
}
