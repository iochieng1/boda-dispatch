import { loginInputSchema } from "@boda-dispatch/shared";
import type { NextRequest } from "next/server";

import { callApi, errorJson, sessionResponse } from "@/lib/auth-server";

export async function POST(request: NextRequest) {
  const parsed = loginInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return errorJson(400, "Enter your email and password");

  const res = await callApi("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });

  if (res.status === 401) return errorJson(401, "Invalid email or password");
  if (!res.ok) return errorJson(502, "Login is unavailable, try again");

  return sessionResponse(await res.json());
}
