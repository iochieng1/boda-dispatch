import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { callApi, errorJson } from "@/lib/auth-server";

/**
 * Creates a job. The browser's access token is passed through and the API
 * decides whether it is valid; this just spares the API a CORS setup for REST.
 */
export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return errorJson(401, "Not signed in");

  let res: Response;
  try {
    res = await callApi("/v1/jobs", {
      method: "POST",
      headers: { authorization },
      body: await request.text(),
    });
  } catch {
    return errorJson(502, "The API is unreachable, try again");
  }

  return new NextResponse(await res.text(), {
    status: res.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
