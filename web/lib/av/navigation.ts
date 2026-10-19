/**
 * 智能音视频平台（/av）的导航契约。
 *
 * 这里是「有哪些页面」的唯一真源：壳层侧栏、面包屑、动效挂载点（Stage 3 的
 * `layoutId` 与页面过渡 key）都从这份清单生成，不要再在组件里手写第二份数组。
 *
 * 与 `/spark` 的 SPARK_PAGES 刻意分开：
 *   · Spark 是 NebulaCloud 云电竞演示站，8 个页面、一套独立暗色视觉；
 *   · AV 是智能音视频平台演示站，6 个页面、跟随项目 DESIGN.md 的深浅双主题。
 * 两者在左侧导航里同属「Spark」分组，但互不共享壳层与路由表。
 */

/** 独立浏览上下文：避免与 NebulaCloud 演示站抢同一个标签页。 */
export const AV_WINDOW_TARGET = "av-platform";

export const AV_PAGES = [
  {
    slug: "overview",
    href: "/av/overview",
    label: "总览驾驶舱",
    group: "总览",
    icon: "overview",
    summary: "KPI、趋势、场景与实时告警流",
  },
  {
    slug: "monitor",
    href: "/av/monitor",
    label: "实时音视频监控",
    group: "总览",
    icon: "monitor",
    summary: "多模态感知通道与设备健康",
  },
  {
    slug: "alarm",
    href: "/av/alarm",
    label: "告警中心",
    group: "检测与处置",
    icon: "alarm",
    summary: "分级告警、闭环处置与误报观察",
  },
  {
    slug: "event",
    href: "/av/event",
    label: "事件中心",
    group: "检测与处置",
    icon: "event",
    summary: "跨告警融合与证据链追溯",
  },
  {
    slug: "device",
    href: "/av/device",
    label: "设备管理",
    group: "检测与处置",
    icon: "device",
    summary: "在线率、离线清单与固件分布",
  },
  {
    slug: "capability",
    href: "/av/capability",
    label: "能力与场景",
    group: "能力与场景",
    icon: "capability",
    summary: "算法矩阵、三场景与检测规则",
  },
] as const;

export type AvSection = (typeof AV_PAGES)[number]["slug"];
export type AvIconName = (typeof AV_PAGES)[number]["icon"] | "wave" | "menu" | "back" | "collapse" | "search" | "clock" | "user" | "chip";

export function isAvSection(value: string): value is AvSection {
  return AV_PAGES.some((page) => page.slug === value);
}

export function avPageForSection(section: string) {
  return AV_PAGES.find((page) => page.slug === section);
}

/** 默认落地页：`/av`、`/av/` 与未知 section 都收敛到这里。 */
export const AV_HOME = "/av/overview";

/** 不属于导航、但允许直达的两个辅助页（Stage 2 §二）。 */
export const AV_HIDDEN_ROUTES = [
  { slug: "__stress", label: "布局压力测试", summary: "极端值样本一次性渲染，不进导航" },
  { slug: "audio", label: "音频分析", summary: "频谱与转写，从告警详情进入，不进导航" },
] as const;

export function isAvHiddenRoute(value: string): value is (typeof AV_HIDDEN_ROUTES)[number]["slug"] {
  return AV_HIDDEN_ROUTES.some((route) => route.slug === value);
}

/**
 * 所有 `[section]` 可接受的值：6 个导航页 + 2 个辅助页。
 * 其它值一律 404，避免 `/av/whatever` 静默落回总览。
 */
export function isAvRoute(value: string): boolean {
  return isAvSection(value) || isAvHiddenRoute(value);
}

/** 在 AV 内做子页面深链接时的前缀（`/av/alarm` → `/av/alarm/AL-00042`）。 */
export function avDetailHref(section: AvSection, id: string): string {
  return `/av/${section}/${encodeURIComponent(id)}`;
}
