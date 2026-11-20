import { type NextRequest, NextResponse } from "next/server";

import { REFRESH_COOKIE } from "@/lib/auth-shared";

/**
 * Sends signed-out visitors to /login (remembering where they were going) and
 * signed-in dispatchers away from it. This only checks that a session cookie
 * exists; the API still verifies every token, and a stale cookie is cleared by
 * the first failed refresh, which also lands the dispatcher on /login.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const signedIn = request.cookies.has(REFRESH_COOKIE);

  if (pathname === "/login") {
    return signedIn
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }

  if (!signedIn) {
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\.[\\w]+$).*)"],
};
