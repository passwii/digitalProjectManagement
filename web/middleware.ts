import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/change-password",
  "/spark",
  // 智能音视频平台（BLF-1374）：与 /spark 一样是纯本地 mock 演示站，免登录。
  // 只加这一条，/spark 的鉴权与重定向行为一字未动。
  "/av",
  "/icon.svg",
  "/icons",
  "/manifest.webmanifest",
  "/sw.js",
  "/pdf-cmaps",
  "/pdf-standard-fonts",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get("pm_access_token")?.value;

  if (pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = token ? "/dashboard" : "/login";
    return NextResponse.redirect(url);
  }

  if (pathname === "/spark") {
    const url = req.nextUrl.clone();
    url.pathname = "/spark/dashboard";
    return NextResponse.redirect(url);
  }

  // `/av` → `/av/overview`：与 /spark 的 HTTP 重定向保持一致（保留查询参数）。
  // 末尾的 `/av/` 也要走同一条，否则会渲染一个空目录页。
  if (pathname === "/av" || pathname === "/av/") {
    const url = req.nextUrl.clone();
    url.pathname = "/av/overview";
    return NextResponse.redirect(url);
  }

  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  ) || pathname.startsWith("/_next");
  if (!isPublic && !token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (pathname === "/login" && token) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
