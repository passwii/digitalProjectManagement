import type { ReactNode } from "react";

/**
 * 居中药丸导航的入口模型。
 *
 * `external` 表示「独立站点」入口：它们可以出现在「更多」浮层里，但**永远不补位**
 * 进药丸的五个主入口（/spark、/stream-monitor 这类站点有自己的浏览上下文）。
 * `target` 原样透传给链接：桌面端由 layout 传 `_blank`，手机端不传 —— 组件不会
 * 自己推断，避免手机端凭空多开标签页。
 */
export interface ShellNavItem {
  href: string;
  label: string;
  icon?: ReactNode;
  external?: boolean;
  target?: string;
}

/** 药丸里的五个固定主入口，顺序即展示顺序。 */
export const PRIMARY_NAV_HREFS = [
  "/dashboard",
  "/projects",
  "/progress",
  "/costs",
  "/approvals",
] as const;

/** 主入口缺位时的补位顺序（只在前面的主入口缺失时启用，补满五个为止）。 */
export const FALLBACK_NAV_HREFS = [
  "/contacts",
  "/opportunities",
  "/assets",
  "/reports",
] as const;

/** 药丸主入口数量：固定五个，其余全部进「更多」。 */
export const PRIMARY_NAV_SLOTS = PRIMARY_NAV_HREFS.length;

export interface NavSplit {
  /** 药丸里的主入口（按固定顺序，缺位时按 FALLBACK_NAV_HREFS 补足，最多五个）。 */
  primary: ShellNavItem[];
  /** 「更多」浮层里的入口（保持输入顺序；独立站点永远在这里）。 */
  overflow: ShellNavItem[];
  /** 当前路径是否落在「更多」浮层（用于高亮「更多」而不是药丸项）。 */
  activeInOverflow: boolean;
}

/**
 * href 的归一化视图：去掉 query / hash 与末尾斜杠。
 *
 * 用于去重与激活匹配，不改动渲染用的原始 href（保留 query 等）。
 */
export function canonicalNavHref(href: string): string {
  const withoutQuery = href.trim().split(/[?#]/, 1)[0] ?? "";
  if (!withoutQuery) return "/";
  if (withoutQuery === "/") return "/";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * 单个导航项是否命中当前路径。
 *
 * 口径与 layout 的 `pathname.startsWith(href + "/")` 一致：`/projects` 命中
 * `/projects/42`，但 `/project` 不会误命中 `/projects`。
 */
export function navItemMatchesPath(itemHref: string, activeHref: string): boolean {
  const item = canonicalNavHref(itemHref);
  const active = canonicalNavHref(activeHref);
  if (item === active) return true;
  if (item === "/") return active.startsWith("/");
  return active.startsWith(item + "/");
}

/**
 * 在候选列表里找出当前路径对应的项；有前缀嵌套时取**最长**匹配，
 * 保证 `/finance/settings` 不会被更短的 `/finance` 抢走。
 */
export function findActiveNavItem(
  items: readonly ShellNavItem[],
  activeHref: string,
): ShellNavItem | undefined {
  let match: ShellNavItem | undefined;
  let matchLength = -1;

  for (const item of items) {
    if (!navItemMatchesPath(item.href, activeHref)) continue;
    const length = canonicalNavHref(item.href).length;
    if (length > matchLength) {
      match = item;
      matchLength = length;
    }
  }

  return match;
}

/**
 * 项目模块附带的两个快捷入口。
 *
 * 后端 RBAC 模块目录里没有独立的 `progress` / `costs` 模块：这两个页面是项目台账的
 * 子视图，权限由「项目」模块 + 后端项目范围共同约束。因此不能硬编码进主入口，只在
 * 用户确实拿到 `/projects` 时补位，避免给没有项目权限的人显示必然 403 的入口。
 */
export const PROJECT_SCOPED_SHORTCUTS = ["/progress", "/costs"] as const;

export function projectScopedShortcutHrefs(items: readonly ShellNavItem[]): string[] {
  const hasProjects = items.some((item) => canonicalNavHref(item.href) === "/projects");
  if (!hasProjects) return [];
  return PROJECT_SCOPED_SHORTCUTS.filter(
    (href) => !items.some((item) => canonicalNavHref(item.href) === href),
  );
}

/**
 * 按 href 去重：保留第一次出现的项（顺序稳定，便于 output 与输入对齐）。
 * 主入口 / 补位 / 更多都消费这份去重结果。
 */
export function dedupeNavItems(items: readonly ShellNavItem[]): ShellNavItem[] {
  const seen = new Set<string>();
  const unique: ShellNavItem[] = [];

  for (const item of items) {
    const key = canonicalNavHref(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

/**
 * 把后端菜单拆成药丸主入口与「更多」浮层。
 *
 * 规则（与已确认草稿一致）：
 *  1. 五个主入口按 PRIMARY_NAV_HREFS 固定顺序取，最多五个；
 *  2. 某主入口缺失时按 FALLBACK_NAV_HREFS 的顺序补位，不改变已有主入口的相对顺序；
 *  3. `external` 项永远不补位进药丸，只进「更多」；
 *  4. 重复 href 只保留第一项；
 *  5. 当前路径落在溢出层时 `activeInOverflow` 为 true。
 */
export function splitNav(
  items: readonly ShellNavItem[],
  activeHref: string,
): NavSplit {
  const unique = dedupeNavItems(items);
  const used = new Set<string>();
  const primary: ShellNavItem[] = [];

  const takePrimarySlot = (href: string) => {
    if (primary.length >= PRIMARY_NAV_SLOTS) return;
    const key = canonicalNavHref(href);
    if (used.has(key)) return;
    const item = unique.find((candidate) => canonicalNavHref(candidate.href) === key);
    // 独立站点（external）不补位；缺失本身不阻塞后续补位。
    if (!item || item.external) return;
    used.add(key);
    primary.push(item);
  };

  for (const href of PRIMARY_NAV_HREFS) takePrimarySlot(href);
  for (const href of FALLBACK_NAV_HREFS) takePrimarySlot(href);

  const overflow = unique.filter((item) => !used.has(canonicalNavHref(item.href)));
  const activeItem = findActiveNavItem([...primary, ...overflow], activeHref);

  return {
    primary,
    overflow,
    activeInOverflow: activeItem
      ? overflow.some((item) => item === activeItem)
      : false,
  };
}
