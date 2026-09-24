/** Stable browsing-context name so desktop and mobile entries reuse one Spark tab. */
export const SPARK_WINDOW_TARGET = "spark-demo";

export const SPARK_PAGES = [
  { slug: "dashboard", href: "/spark/dashboard", label: "运营总览", group: "运营", icon: "dashboard" },
  { slug: "stores", href: "/spark/stores", label: "连锁门店", group: "运营", icon: "store" },
  { slug: "compute", href: "/spark/compute", label: "算力调度", group: "运营", icon: "compute", badge: "LIVE" },
  { slug: "billing", href: "/spark/billing", label: "计费收银", group: "运营", icon: "billing" },
  { slug: "content", href: "/spark/content", label: "内容与赛事", group: "运营", icon: "content" },
  { slug: "security", href: "/spark/security", label: "安全合规", group: "监管", icon: "security", badge: "3" },
  { slug: "ops", href: "/spark/ops", label: "运维工单", group: "系统", icon: "ops" },
  { slug: "permission", href: "/spark/permission", label: "权限管理", group: "系统", icon: "permission" },
] as const;

export type SparkSection = (typeof SPARK_PAGES)[number]["slug"];
export type SparkIconName = (typeof SPARK_PAGES)[number]["icon"] | "spark" | "menu" | "back" | "collapse";

export function isSparkSection(value: string): value is SparkSection {
  return SPARK_PAGES.some((page) => page.slug === value);
}

export function sparkPageForSection(section: string) {
  return SPARK_PAGES.find((page) => page.slug === section);
}
