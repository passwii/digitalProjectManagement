import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/change-password"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get("pm_access_token")?.value;
  const sessionHint = req.cookies.get("pm_session")?.value;
  const hasSession = Boolean(token || sessionHint);
  const recoveringLogout = req.nextUrl.searchParams.get("logged_out") === "1";
  const authReason = req.nextUrl.searchParams.get("reason");
  const recoveringAuth = ["logout", "logout_failed", "expired"].includes(authReason ?? "");

  if (pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = hasSession ? "/dashboard" : "/login";
    return NextResponse.redirect(url);
  }

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith("/_next"));
  if (!isPublic && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (pathname === "/login" && hasSession && !recoveringLogout && !recoveringAuth) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
