import type { NextRequest } from "next/server";

import { forwardToApi } from "@/lib/api-proxy";

/** Jobs changed since a moment, for catching up after a reconnect. */
export async function GET(request: NextRequest) {
  return forwardToApi(request, `/v1/jobs/changes${request.nextUrl.search}`, {
    method: "GET",
  });
}
