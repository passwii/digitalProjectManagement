"use client";
/** 项目选择器的「最近使用」：仅存 id/code/name，localStorage 不可用时静默降级 */

export interface RecentProject {
  id: number;
  code: string;
  name: string;
}

const KEY = "pm_recent_projects_v1";
const MAX = 5;

function canUseStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

export function loadRecentProjects(): RecentProject[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is RecentProject => {
        const r = x as Partial<RecentProject>;
        return !!r && typeof r.id === "number" && typeof r.name === "string";
      })
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function rememberProject(p: RecentProject): RecentProject[] {
  const next = [p, ...loadRecentProjects().filter((r) => r.id !== p.id)].slice(0, MAX);
  if (canUseStorage()) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式 / 配额不足：忽略 */
    }
  }
  return next;
}
