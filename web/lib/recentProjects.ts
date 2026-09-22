"use client";
/** 项目选择器的「最近使用」：仅存 id/code/name，localStorage 不可用时静默降级 */

export interface RecentProject {
  id: number;
  code: string;
  name: string;
}

export const RECENT_PROJECTS_STORAGE_KEY = "pm_recent_projects_v1";
const MAX = 5;

function saveRecentProjects(projects: RecentProject[]) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    /* 隐私模式 / 配额不足：忽略 */
  }
}

function canUseStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

export function loadRecentProjects(): RecentProject[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
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
  saveRecentProjects(next);
  return next;
}

/** 项目进入回收站后，从本地最近使用快照中同步移除。 */
export function removeRecentProject(id: number): RecentProject[] {
  const current = loadRecentProjects();
  const next = current.filter((p) => p.id !== id);
  if (next.length !== current.length) saveRecentProjects(next);
  return next;
}

/** 将校验后的最新快照写回本地，保持 Recent 展示字段与服务端一致。 */
export function syncRecentProjects(projects: RecentProject[]): RecentProject[] {
  const next = projects.slice(0, MAX);
  saveRecentProjects(next);
  return next;
}

/** 将服务端校验结果合并回最新本地快照，避免旧请求覆盖校验期间的新选择。 */
export function reconcileValidatedRecentProjects(
  checked: RecentProject[],
  latest: RecentProject[],
  validated: RecentProject[],
): RecentProject[] {
  const checkedIds = new Set(checked.map((project) => project.id));
  const validatedById = new Map(validated.map((project) => [project.id, project]));
  return latest
    .filter((project) => !checkedIds.has(project.id) || validatedById.has(project.id))
    .map((project) => validatedById.get(project.id) ?? project);
}
