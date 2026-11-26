import type { NextRequest } from "next/server";

import { forwardToApi } from "@/lib/api-proxy";

/** Edits a job, based on the version the dispatcher saw. */
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]">,
) {
  const { id } = await ctx.params;
  return forwardToApi(request, `/v1/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: await request.text(),
  });
}
