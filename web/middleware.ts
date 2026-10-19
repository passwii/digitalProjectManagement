import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/change-password",
  "/spark",
  // stream monitor 音视频平台（BLF-1374）：与 /spark 一样是纯本地 mock 演示站，免登录。
  // 只加这一条，/spark 的鉴权与重定向行为一字未动。
  "/stream-monitor",
  // ⚠️ 必须同时放行 /mock/av：告警「加载下一页」是在**浏览器**里直接 fetch
  // `/mock/av/alarms/shard-*.json`。只放行站点路径的话，匿名用户点翻页会被 307 到
  // /login，JSON.parse 拿到 HTML 报错，告警中心只能看到首屏 50 条（review 缺陷 1）。
  // 只放行站点自己的数据目录，不动 /mock 下其它潜在数据。
  "/mock/av",
  "/icon.svg",
  "/icons",
  "/manifest.webmanifest",
  "/sw.js",
  "/pdf-cmaps",
  "/pdf-standard-fonts",
];

/**
 * 旧站点的公开路径前缀（BLF-1387 迁移前的 `/av`）。
 *
 * 站点已从 `/av` 迁到 `/stream-monitor`，但旧链接（收藏、文档、对外分享）还会继续
 * 被点到。直接 404 会留下断链，所以这里把 `/av` 与 `/av/**` 全部 308 到新路径下
 * 同样的位置：`/av/alarm/AL-00042` → `/stream-monitor/alarm/AL-00042`。
 *
 * 为什么是 308 而不是 301：308 会把方法与请求体原样带过去，语义上「永久搬家」
 * 比 301（历史上有时被当作可缓存的临时跳转）更准确，浏览器也会记住。
 *
 * 匹配必须**带斜杠边界**：`/avX`、`/av-foo` 这些相邻路径不属于旧站点，
 * 仍然按普通受保护路由处理（要求登录）。
 */
const LEGACY_AV_PREFIX = "/av";

/** 站点根路径（旧站的 `/av`、新站的 `/stream-monitor`）都收敛到总览页。 */
const SITE_HOME = "/stream-monitor/overview";

/**
 * 旧路径 → 新路径的对应表。
 *
 * 站点根直接指到**总览页**（而不是先指到新站点根再让它自己跳一次）：
 * 迁移前 `/av` 就是一跳到 `/av/overview`，迁移后应当保持同样的一跳 ——
 * 两跳会让中间多一次往返，链接预览 / 爬虫也会多跟一次。
 */
function legacyAvRedirect(pathname: string): string | null {
  if (pathname === LEGACY_AV_PREFIX || pathname === `${LEGACY_AV_PREFIX}/`) {
    return SITE_HOME;
  }
  if (!pathname.startsWith(`${LEGACY_AV_PREFIX}/`)) return null;
  return `/stream-monitor${pathname.slice(LEGACY_AV_PREFIX.length)}`;
}

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

  // 旧站点 `/av/**` → 新站点 `/stream-monitor/**`（BLF-1387 改名后的兼容重定向）。
  // 保留查询参数，位置一一对应，不留断链。
  const legacyTarget = legacyAvRedirect(pathname);
  if (legacyTarget) {
    const url = req.nextUrl.clone();
    url.pathname = legacyTarget;
    return NextResponse.redirect(url, 308);
  }

  // `/stream-monitor` → `/stream-monitor/overview`：与 /spark 的 HTTP 重定向保持一致（保留查询参数）。
  // 末尾的 `/stream-monitor/` 也要走同一条，否则会渲染一个空目录页。
  if (pathname === "/stream-monitor" || pathname === "/stream-monitor/") {
    const url = req.nextUrl.clone();
    url.pathname = SITE_HOME;
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
