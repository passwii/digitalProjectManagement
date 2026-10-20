/**
 * 站点身份（BLF-1389）：路径 → 应用名 / manifest 路径 / 主题色。
 *
 * 为什么要有这一份「真源」：
 *   · 手机端的安装提示（`components/pwa/InstallPrompt.tsx`）要按当前所在站点
 *     显示正确的名字 —— 在云电竞管理平台上不能提示「安装数科云办公」；
 *   · 两个站点的 manifest（`public/<site>/manifest.webmanifest`）里的
 *     `name` / `short_name` / `theme_color` 要跟布局导出的 `viewport.themeColor`
 *     同值，否则 standalone 启动时状态栏色与页面顶色对不上；
 *   · 验收脚本（`scripts/acceptance_blf1127_mobile.py`）要按站点选 manifest，
 *     不能拿根那份去断言站点字段。
 *
 * 三个地方各写一份字符串，迟早会漂 —— 所以收敛到这里，纯函数，好测。
 *
 * ⚠️ 品牌口径（BLF-1397 起定稿）：站点对外品牌是**中文**「智能音视频平台」，
 * URL 仍是 `/stream-monitor`（路径是稳定契约，品牌名不是）。这里不要写英文品牌。
 */

/** 一个站点的 PWA 身份。 */
export interface SiteIdentity {
  /** 站点对外品牌（用户可见）。 */
  name: string;
  /** 主屏幕图标下的短名。 */
  shortName: string;
  /** 站点自己的 manifest 路径。 */
  manifest: string;
  /** 站点底色（与 manifest 的 theme_color / background_color 同值）。 */
  themeColor: string;
  /**
   * 浅色主题下的底色（可选）。
   *
   * 只有**深浅双主题**的站点才需要它（智能音视频平台）：它的 `viewport.themeColor`
   * 用 `media` 描述符给深浅两份，浅色那份要跟页面的浅色底色对齐，
   * 否则浅色用户看到的是「深蓝状态栏 + 浅灰页面」的两截颜色。
   *
   * 单色站（云电竞管理平台）不需要这一项：它本来就只有一套暗色。
   */
  lightThemeColor?: string;
}

/**
 * 主工作台（数科云办公）自己的身份。
 *
 * ⚠️ 用 `satisfies` 而不是 `: SiteIdentity` 注解：`satisfies` 保留字面量的
 * 精确类型（`lightThemeColor` 保持**必填的** `string`），而注解会把可选字段
 * 拓宽成 `string | undefined` —— 消费方（如 `viewport.themeColor` 的
 * `media` 描述符）要的是确定的颜色值，不是一个可能为 undefined 的值。
 */
export const ROOT_SITE = {
  name: "数科云办公",
  shortName: "数科云办公",
  manifest: "/manifest.webmanifest",
  themeColor: "#0F2742",
} satisfies SiteIdentity;

/** 云电竞管理平台（`/spark`）。 */
export const SPARK_SITE = {
  name: "云电竞管理平台",
  shortName: "云电竞管理平台",
  manifest: "/spark/manifest.webmanifest",
  themeColor: "#070a12",
} satisfies SiteIdentity;

/** 智能音视频平台（`/stream-monitor`）。 */
export const STREAM_MONITOR_SITE = {
  name: "智能音视频平台",
  shortName: "智能音视频平台",
  manifest: "/stream-monitor/manifest.webmanifest",
  themeColor: "#07131f",
  // 浅色主题底色（globals.css 的 `--bg` 浅色档）。
  lightThemeColor: "#f1f5f7",
} satisfies SiteIdentity;

/** 两个独立站点的身份表（按路径前缀索引）。 */
export const SITE_IDENTITIES: ReadonlyArray<{
  /** 路径前缀（含结尾斜杠的站点根单独列在 `prefix` 里）。 */
  prefix: string;
  identity: SiteIdentity;
}> = [
  { prefix: "/spark", identity: SPARK_SITE },
  { prefix: "/stream-monitor", identity: STREAM_MONITOR_SITE },
];

/**
 * 按当前路径取站点身份。
 *
 * 匹配规则：取**最长前缀**（`/stream-monitor` 不会被别的前缀误吞），
 * 且要求前缀后面是路径分隔符或字符串结尾 ——
 * `/sparky` 不该被当成 `/spark`。
 *
 * `pathname` 为空（SSR 首帧 / 测试里没挂路由上下文）时回落到主工作台。
 */
export function siteIdentityFor(pathname: string | null | undefined): SiteIdentity {
  if (!pathname) return ROOT_SITE;
  let hit: SiteIdentity | null = null;
  let hitLength = -1;
  for (const entry of SITE_IDENTITIES) {
    const { prefix } = entry;
    const isRoot = pathname === prefix;
    const isUnder = pathname.startsWith(`${prefix}/`);
    if (!isRoot && !isUnder) continue;
    if (prefix.length > hitLength) {
      hit = entry.identity;
      hitLength = prefix.length;
    }
  }
  return hit ?? ROOT_SITE;
}
