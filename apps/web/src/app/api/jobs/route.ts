import type { NextRequest } from "next/server";

import { forwardToApi } from "@/lib/api-proxy";

/** Lists jobs, newest first. */
export async function GET(request: NextRequest) {
  return forwardToApi(request, `/v1/jobs${request.nextUrl.search}`, {
    method: "GET",
  });
}

/** Creates a job. */
export async function POST(request: NextRequest) {
  return forwardToApi(request, "/v1/jobs", {
    method: "POST",
    body: await request.text(),
  });
}
