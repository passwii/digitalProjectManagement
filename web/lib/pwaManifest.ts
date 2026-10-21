/**
 * PWA 清单的公共构造（BLF-1400）。
 *
 * 为什么抽出来：三份清单（根 + 云电竞 + 智能音视频）要共享**同一套**图标
 * 声明与 `display` 等字段。以前三处各写一份，改图标时漏一处就会出现
 * 「某个站点的装机图标不对」——而且不报错，只是装出来不一样。
 *
 * ⚠️ 清单本身为什么从 `public/` 改成了 `route.ts`（BLF-1400）：
 *
 *   站点清单若放在 `public/<site>/manifest.webmanifest`，会排在两个站点的
 *   **动态路由** `app/<site>/[section]/page.tsx` 之后；`[section]` 会把
 *   `manifest.webmanifest` 当成 section 接走并返回 404。改成同级 `route.ts`
 *   也不稳，因为 Next 14 会先匹配 page，再匹配 route handler。
 *
 *   因此 `/spark/manifest.webmanifest` 和 `/stream-monitor/manifest.webmanifest`
 *   在 middleware 中、鉴权之前直接返回下面的共享清单对象，保留现有公开 URL。
 *   根清单仍由 `app/manifest.webmanifest/route.ts` 提供。
 */

/** 一份清单里用到的图标（三份清单完全一致）。 */
export const PWA_ICONS = [
  {
    src: "/icons/icon-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/icon-512-maskable.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
  {
    src: "/icon.svg",
    sizes: "any",
    type: "image/svg+xml",
    purpose: "any",
  },
] as const;

export const SPARK_PWA_MANIFEST = buildPwaManifest({
  name: "云电竞管理平台",
  description: "云电竞管理平台：运营、门店、算力与安全管理",
  id: "/spark",
  startUrl: "/spark/dashboard",
  scope: "/spark",
  themeColor: "#070a12",
  shortcuts: [
    { name: "运营总览", url: "/spark/dashboard" },
    { name: "连锁门店", url: "/spark/stores" },
    { name: "算力调度", url: "/spark/compute" },
    { name: "安全合规", url: "/spark/security" },
  ],
});

export const STREAM_MONITOR_PWA_MANIFEST = buildPwaManifest({
  name: "智能音视频平台",
  description: "音频与视频融合感知的全场景智能安防平台",
  id: "/stream-monitor",
  startUrl: "/stream-monitor/overview",
  scope: "/stream-monitor",
  themeColor: "#07131f",
  shortcuts: [
    { name: "总览驾驶舱", url: "/stream-monitor/overview" },
    { name: "实时音视频监控", url: "/stream-monitor/monitor" },
    { name: "告警中心", url: "/stream-monitor/alarm" },
    { name: "设备管理", url: "/stream-monitor/device" },
  ],
});

/** 一条快捷方式。 */
export type PwaShortcut = {
  name: string;
  url: string;
  icons?: ReadonlyArray<{ src: string; sizes: string }>;
};

/** 一份 PWA 清单。 */
export type PwaManifest = {
  name: string;
  short_name: string;
  description: string;
  lang: string;
  id?: string;
  start_url: string;
  scope: string;
  display: "standalone";
  orientation: "portrait";
  background_color: string;
  theme_color: string;
  icons: typeof PWA_ICONS;
  shortcuts: ReadonlyArray<PwaShortcut>;
};

/**
 * 造一份清单。
 *
 * `id` 显式写死（`/spark` / `/stream-monitor`）：它是这个应用的**身份**。
 * 缺了的话浏览器会用 start_url 兜底，而 start_url 一旦改动，Chrome 就会
 * 把它当成**另一个应用**（装出两个图标），且原来的不会被更新。
 */
export function buildPwaManifest(params: {
  name: string;
  description: string;
  id: string;
  startUrl: string;
  scope: string;
  themeColor: string;
  shortcuts: ReadonlyArray<PwaShortcut>;
}): PwaManifest {
  return {
    name: params.name,
    short_name: params.name,
    description: params.description,
    lang: "zh-CN",
    id: params.id,
    start_url: params.startUrl,
    scope: params.scope,
    display: "standalone",
    orientation: "portrait",
    background_color: params.themeColor,
    theme_color: params.themeColor,
    icons: PWA_ICONS,
    shortcuts: params.shortcuts,
  };
}
