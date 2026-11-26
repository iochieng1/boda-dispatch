import { type NextRequest, NextResponse } from "next/server";

import { callApi, errorJson } from "@/lib/auth-server";

/**
 * Forwards a request to the API with the browser's access token and returns
 * the API's answer as is. The API decides whether the token is valid; this
 * just spares it a CORS setup for REST.
 */
export const forwardToApi = async (
  request: NextRequest,
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: string },
) => {
  const authorization = request.headers.get("authorization");
  if (!authorization) return errorJson(401, "Not signed in");

  let res: Response;
  try {
    res = await callApi(path, {
      method: init.method,
      headers: { authorization },
      ...(init.body !== undefined && { body: init.body }),
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
};
