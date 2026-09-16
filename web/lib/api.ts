// API 封装：base + token 注入 + 401 跳登录。字段与后端 api/routers/*.py 对齐。
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8001/api/v1";

export class UnauthorizedError extends Error {}
export class NetworkError extends Error {}

const TOKEN_KEY = "pm_access_token";
const REFRESH_KEY = "pm_refresh_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function saveSession(access: string, refresh: string) {
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
  // middleware 侧可读的 cookie（MVP 非 httpOnly）
  document.cookie = `pm_access_token=${access}; path=/; max-age=${2 * 3600}`;
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  document.cookie = "pm_access_token=; path=/; max-age=0";
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

/** 把后端 HTTP 错误转成可直接展示的中文文案 */
export function errText(e: unknown): string {
  if (e instanceof UnauthorizedError) return "未登录或会话已过期，请重新登录";
  if (e instanceof NetworkError) return "无法连接后端服务，请确认 API 已启动";
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/API \d+:\s*(.+)$/);
  const body = (m ? m[1] : msg).trim();
  try {
    const j = JSON.parse(body);
    if (j && typeof j.detail === "string") return j.detail;
    if (Array.isArray(j?.detail)) return j.detail.map((d: { msg?: string }) => d.msg ?? "").join("；");
  } catch {
    /* 非 JSON，原样返回 */
  }
  return body || "请求失败";
}

async function request<T>(path: string, init: RequestInit = {}, raw = false): Promise<T> {
  const token = getToken();
  const isForm = init.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isForm ? {} : { "Content-Type": "application/json" }),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (e) {
    // 主动取消（AbortController）不是网络故障：原样抛出，由调用方静默丢弃
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    throw new NetworkError("无法连接后端");
  }
  if (res.status === 401) {
    clearSession();
    throw new UnauthorizedError("未登录或会话已过期");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** GET：可选传 AbortSignal，快速切换筛选/项目时取消过期请求（BLF-1095） */
export const apiGet = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPut = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const apiDelete = <T>(path: string) => request<T>(path, { method: "DELETE" });
export const apiUpload = <T>(path: string, form: FormData) =>
  request<T>(path, { method: "POST", body: form });

/** 拼查询串：null/undefined/空串自动跳过（筛选项与分页参数共用） */
export function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** 列表分页边界（与后端 Stage 3A 契约一致：省略分页参数 = 1/20，size 上限 100） */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 列表接口通用查询（分页 + 排序白名单字段） */
export interface ListOpts {
  page?: number;
  size?: number;
  sort?: string;
}

/** 回收站行（`GET /projects/recycle-bin/list`） */
export interface RecycleBinItem {
  id: number;
  code: string;
  name: string;
  status: string;
  deleted_at: string | null;
}

/** `/projects/options` 可用性：后端 Stage 3A 前后自动切换，同一会话只探测一次 */
let optionsSupported: boolean | null = null;

/** 导出下载：附 token 拉 blob 后触发浏览器下载 */
export async function downloadFile(path: string, filename: string) {
  const res = await request<Response>(path, {}, true);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- 类型（对齐后端返回） ----------------
export interface LoginResp {
  access_token: string;
  refresh_token: string;
  token_type: string;
  must_change_pwd: boolean;
}
export interface Me {
  id: number;
  username: string;
  real_name: string;
  status: string;
  dept_id: number | null;
  roles: { code: string; name: string }[];
  must_change_pwd: boolean;
}
export interface UserOption {
  id: number;
  username: string;
  real_name: string;
  dept_id: number | null;
  status: string;
  roles: string[];
}
export interface Dept {
  id: number;
  name: string;
  parent_id: number | null;
}
export interface DictItem {
  type: string;
  code: string;
  label: string;
}
export interface MenuResp {
  roles: string[];
  /** 是否管理员（后端 /meta/me/menus 契约）：唯一管理与审批角色 */
  is_admin: boolean;
  /** 是否可审批：当前契约下与 is_admin 等价（列表 can_decide 同一判定） */
  can_approve: boolean;
  menus: { key: string; label: string; href: string }[];
  readonly: boolean;
  /** 演示数据开关当前状态（所有登录用户可读） */
  demo_on: boolean;
  /** 是否可切换演示开关（仅管理员） */
  can_toggle_demo: boolean;
}
export interface Project {
  id: number;
  code: string;
  name: string;
  type: string;
  dept_id: number | null;
  owner_id: number | null;
  member_ids: number[];
  plan_start: string | null;
  plan_end: string | null;
  budget_total: number;
  priority: string;
  client: string;
  description: string;
  status: string;
  progress: number;
  /** FTS5 命中时的关键词高亮片段（仅带 keyword 检索返回） */
  snippet?: string;
}

/** 项目选择器最小字段（`GET /projects/options`） */
export interface ProjectOption {
  id: number;
  code: string;
  name: string;
  status: string;
  owner_id: number | null;
  dept_id: number | null;
  /** 仅当回退到 `GET /projects`（后端未升级）时才有客户名 */
  client?: string;
}
export interface ProjectChange {
  id: number;
  field: string;
  old: string | null;
  new: string | null;
  by_id: number | null;
  at: string | null;
}
export interface Attachment {
  id: number;
  filename: string;
  size: number;
  uploaded_by: number | null;
  uploaded_at: string | null;
}
export interface Followup {
  id: number;
  user_id: number | null;
  method: string;
  content: string;
  next_step: string;
  happened_at: string | null;
  remind_at: string | null;
}
export interface Task {
  id: number;
  project_id: number;
  parent_id: number | null;
  level: number;
  name: string;
  owner_id: number | null;
  plan_start: string | null;
  plan_end: string | null;
  weight: number;
  progress: number;
  status: string;
  predecessor_id: number | null;
}
export interface Milestone {
  id: number;
  project_id: number;
  name: string;
  plan_date: string | null;
  actual_date: string | null;
  owner_id: number | null;
  status: string;
  overdue: boolean;
  near: boolean;
}
export interface ProgressLog {
  id: number;
  task_id: number;
  project_id: number;
  user_id: number | null;
  progress: number;
  note: string;
  remaining_days: number | null;
  created_at: string | null;
}
export interface Budget {
  id: number;
  project_id: number;
  subject: string;
  amount: number;
  period_start: string | null;
  period_end: string | null;
  spent: number;
  balance: number;
  rate: number;
  warn: boolean;
}
export interface Expense {
  id: number;
  project_id: number;
  subject: string;
  amount: number;
  exp_date: string | null;
  note: string;
  status: string;
  by_id: number | null;
  execution?: { budget: number; spent: number; balance: number; rate: number; warn: boolean; over: boolean };
}
export interface CostRow {
  project_id: number;
  project_code: string;
  project_name: string;
  dept_id: number | null;
  subject: string;
  budget: number;
  spent: number;
  balance: number;
  rate: number;
  note: string;
}
export interface Warnings {
  overdue_tasks: { task_id: number; name: string; project_id: number; plan_end: string }[];
  milestones: { milestone_id: number; name: string; project_id: number; overdue: boolean; days_left: number }[];
  stagnant_projects: { project_id: number; name: string; days_no_log: number }[];
  budget_warnings: { project_id: number; subject: string; budget: number; spent: number; balance: number; rate: number; warn: boolean; over: boolean }[];
  followup_due: { followup_id: number; project_id: number; user_id: number | null; remind_at: string | null; content: string }[];
}

// ---------------- 接口 ----------------
export const authApi = {
  login: (username: string, password: string) =>
    apiPost<LoginResp>("/auth/login", { username, password }),
  me: () => apiGet<Me>("/auth/me"),
  logout: () => apiPost<{ ok: boolean }>("/auth/logout", {}),
  changePassword: (old_password: string, new_password: string) =>
    apiPost<{ ok: boolean }>("/auth/change-password", { old_password, new_password }),
};

export const metaApi = {
  users: () => apiGet<UserOption[]>("/meta/users"),
  depts: () => apiGet<Dept[]>("/meta/depts"),
  dicts: (type = "") => apiGet<DictItem[]>(`/meta/dicts${type ? `?type=${type}` : ""}`),
  menus: () => apiGet<MenuResp>("/meta/me/menus"),
};

export const projectsApi = {
  list: (q = "", signal?: AbortSignal) => apiGet<Paged<Project>>(`/projects${q}`, signal),
  /** 项目选择器：关键词 + 分页（消费 /projects 的 keyword/page/size 契约） */
  search: (
    { keyword = "", page = 1, size = DEFAULT_PAGE_SIZE }: { keyword?: string; page?: number; size?: number },
    signal?: AbortSignal,
  ) => apiGet<Paged<Project>>(`/projects${buildQuery({ keyword: keyword.trim(), page, size })}`, signal),
  /**
   * 项目选择器专用最小字段接口（Stage 3A）：只回 id/code/name/status/owner_id/dept_id，
   * 关键词按名称/编号 LIKE 匹配（total 准确、分页可靠，不受 FTS 命中集截断影响）。
   * 后端尚未升级（该路由 404）时自动回退 `/projects`，同一会话只探测一次。
   */
  options: async (
    params: ListOpts & { keyword?: string; status?: string; owner_id?: number | string },
    signal?: AbortSignal,
  ): Promise<Paged<ProjectOption>> => {
    const query = buildQuery({
      keyword: (params.keyword ?? "").trim(),
      status: params.status,
      owner_id: params.owner_id,
      page: params.page ?? 1,
      size: params.size ?? DEFAULT_PAGE_SIZE,
      sort: params.sort,
    });
    if (optionsSupported !== false) {
      try {
        const data = await apiGet<Paged<ProjectOption>>(`/projects/options${query}`, signal);
        optionsSupported = true;
        return data;
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("API 404")) throw e;
        optionsSupported = false;
      }
    }
    const fallback = await apiGet<Paged<Project>>(`/projects${query}`, signal);
    return {
      ...fallback,
      items: fallback.items.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
        owner_id: p.owner_id,
        dept_id: p.dept_id,
        client: p.client,
      })),
    };
  },
  get: (id: number | string) => apiGet<Project>(`/projects/${id}`),
  create: (body: Partial<Project>) => apiPost<Project>("/projects", body),
  update: (id: number, body: Record<string, unknown>) => apiPatch<Project>(`/projects/${id}`, body),
  remove: (id: number) => apiDelete<{ ok: boolean }>(`/projects/${id}`),
  restore: (id: number) => apiPost<Project>(`/projects/${id}/restore`, {}),
  recycleBin: (q = "", signal?: AbortSignal) =>
    apiGet<RecycleBinItem[] | Paged<RecycleBinItem>>(`/projects/recycle-bin/list${q}`, signal),
  status: (id: number, status: string, reason = "") =>
    apiPost<Project>(`/projects/${id}/status`, { status, reason }),
  changes: (id: number) => apiGet<ProjectChange[]>(`/projects/${id}/changes`),
  attachments: (id: number) => apiGet<Attachment[]>(`/projects/${id}/attachments`),
  upload: (id: number, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiUpload<Attachment>(`/projects/${id}/attachments`, fd);
  },
  downloadAttachment: (id: number, aid: number, filename: string) =>
    downloadFile(`/projects/${id}/attachments/${aid}/download`, filename),
  deleteAttachment: (id: number, aid: number) => apiDelete<{ ok: boolean }>(`/projects/${id}/attachments/${aid}`),
  setMembers: (id: number, userIds: number[]) => apiPut<Project>(`/projects/${id}/members`, { user_ids: userIds }),
  followups: (id: number, q = "", signal?: AbortSignal) =>
    apiGet<Followup[] | Paged<Followup>>(`/projects/${id}/followups${q}`, signal),
  addFollowup: (id: number, body: Record<string, unknown>) =>
    apiPost<{ id: number }>(`/projects/${id}/followups`, body),
  updateFollowup: (id: number, fid: number, body: Record<string, unknown>) =>
    apiPatch<Record<string, unknown>>(`/projects/${id}/followups/${fid}`, body),
  deleteFollowup: (id: number, fid: number) => apiDelete<{ ok: boolean }>(`/projects/${id}/followups/${fid}`),
  progress: (id: number) =>
    apiGet<{ project_id: number; progress: number; task_count: number }>(`/projects/${id}/progress`),
  confirmProgress: (id: number) =>
    apiPost<{ progress: number; task_count: number; confirmed_at: string }>(`/projects/${id}/progress/confirm`),
};

export const tasksApi = {
  list: (q = "", signal?: AbortSignal) =>
    apiGet<Task[] | Paged<Task>>(`/tasks${q}`, signal),
  create: (body: Record<string, unknown>) => apiPost<Task>("/tasks", body),
  update: (id: number, body: Record<string, unknown>) => apiPatch<Task>(`/tasks/${id}`, body),
  remove: (id: number) => apiDelete<void>(`/tasks/${id}`),
  import: (projectId: number, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiUpload<{ imported: number }>(`/tasks/import?project_id=${projectId}`, fd);
  },
};

export const milestonesApi = {
  list: (projectId: number, opts: ListOpts = {}, signal?: AbortSignal) =>
    apiGet<Milestone[] | Paged<Milestone>>(
      `/milestones${buildQuery({ project_id: projectId, ...opts })}`,
      signal,
    ),
  create: (body: Record<string, unknown>) => apiPost<Milestone>("/milestones", body),
  update: (id: number, body: Record<string, unknown>) => apiPatch<Milestone>(`/milestones/${id}`, body),
  remove: (id: number) => apiDelete<void>(`/milestones/${id}`),
};

export const progressApi = {
  logs: (q = "", signal?: AbortSignal) =>
    apiGet<ProgressLog[] | Paged<ProgressLog>>(`/progress-logs${q}`, signal),
  report: (body: { task_id: number; progress: number; note?: string; remaining_days?: number | null }) =>
    apiPost<{ id: number; progress: number }>("/progress-logs", body),
};

export const budgetsApi = {
  list: (projectId: number, opts: ListOpts = {}, signal?: AbortSignal) =>
    apiGet<Budget[] | Paged<Budget>>(
      `/budgets${buildQuery({ project_id: projectId, ...opts })}`,
      signal,
    ),
  create: (body: Record<string, unknown>) => apiPost<Budget>("/budgets", body),
  adjust: (id: number, body: Record<string, unknown>) => apiPatch<Budget>(`/budgets/${id}`, body),
  adjusts: (projectId: number, opts: ListOpts = {}, signal?: AbortSignal) =>
    apiGet<Record<string, unknown>[] | Paged<Record<string, unknown>>>(
      `/budget-adjusts${buildQuery({ project_id: projectId, ...opts })}`,
      signal,
    ),
  approveAdjust: (id: number, body: Record<string, unknown>) =>
    apiPost<Record<string, unknown>>(`/budget-adjusts/${id}/approve`, body),
};

export const expensesApi = {
  list: (q = "", signal?: AbortSignal) =>
    apiGet<Expense[] | Paged<Expense>>(`/expenses${q}`, signal),
  create: (body: Record<string, unknown>) => apiPost<Expense>("/expenses", body),
  approve: (id: number) => apiPost<Expense>(`/expenses/${id}/approve`, {}),
  reject: (id: number, reason: string) => apiPost<Expense>(`/expenses/${id}/reject`, { reason }),
  exception: (id: number, reason: string) => apiPost<Expense>(`/expenses/${id}/exception`, { reason }),
};

/** 支出列表统一解包（支持数组与分页信封两种返回） */
export function unwrapList<T>(data: T[] | { items?: T[] }): T[] {
  return Array.isArray(data) ? data : data.items ?? [];
}

/** 兼容两种列表返回：Stage 3 前为裸数组，Stage 3 后为 {total,page,size,items} 信封 */
export interface Paged<T> {
  total: number;
  page: number;
  size: number;
  items: T[];
  /** 后端是否已提供分页信封（未提供时 total 退化为当前批条数） */
  paged: boolean;
}

export function unwrapPaged<T>(
  data: T[] | { items?: T[]; total?: number; page?: number; size?: number } | null | undefined,
): Paged<T> {
  if (!data) return { total: 0, page: 1, size: 0, items: [], paged: false };
  if (Array.isArray(data)) {
    return { total: data.length, page: 1, size: data.length, items: data, paged: false };
  }
  const items = data.items ?? [];
  return {
    total: typeof data.total === "number" ? data.total : items.length,
    page: data.page ?? 1,
    size: data.size ?? items.length,
    items,
    paged: typeof data.total === "number",
  };
}

export const reportsApi = {
  cost: (q = "", signal?: AbortSignal) => apiGet<{ items: CostRow[]; note: string; total?: number }>(`/reports/cost${q}`, signal),
  warnings: () => apiGet<Warnings>("/reports/warnings"),
  exportCost: (q = "") => downloadFile(`/reports/cost/export${q}`, "cost_report.xlsx"),
};

export interface AdminUser {
  id: number;
  username: string;
  real_name: string;
  status: string;
  dept_id: number | null;
  roles: { code: string; name: string }[];
}
export interface AuditLog {
  id: number;
  user_id: number | null;
  action: string;
  resource: string;
  resource_id: string | null;
  detail: string;
  ip: string;
  created_at: string | null;
}

/** 演示数据开关（全局，仅管理员可切换） */
export interface DemoDataState {
  on: boolean;
  demo_projects: number;
  demo_projects_deleted: number;
}

export const demoApi = {
  get: () => apiGet<DemoDataState>("/admin/demo-data"),
  set: (on: boolean) => apiPut<{ on: boolean }>("/admin/demo-data", { on }),
};

export const adminApi = {
  users: (page = 1, size = 20, signal?: AbortSignal) =>
    apiGet<Paged<AdminUser>>(`/admin/users${buildQuery({ page, size })}`, signal),
  createUser: (body: Record<string, unknown>) => apiPost<AdminUser>("/admin/users", body),
  updateUser: (id: number, body: Record<string, unknown>) => apiPatch<AdminUser>(`/admin/users/${id}`, body),
  roles: (signal?: AbortSignal) => apiGet<{ id: number; code: string; name: string }[]>("/admin/roles", signal),
  dicts: (type = "", signal?: AbortSignal) =>
    apiGet<DictItem[]>(`/admin/dicts${type ? `?type=${type}` : ""}`, signal),
  createDict: (body: Record<string, unknown>) => apiPost<{ id: number }>("/admin/dicts", body),
  params: (signal?: AbortSignal) => apiGet<Record<string, string>>("/admin/params", signal),
  setParams: (body: Record<string, string>) => apiPut<{ ok: boolean }>("/admin/params", body),
  logs: (q = "", signal?: AbortSignal) => apiGet<Paged<AuditLog>>(`/admin/logs${q}`, signal),
};

// ---------------- Stage 3：站内通知 + 审批中心 ----------------
export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string;
  ref_type: string;
  ref_id: number | null;
  project_id: number | null;
  read: boolean;
  created_at: string | null;
}

export interface PendingFilings {
  kind: "project_filing";
  id: number;
  project_id: number;
  code: string;
  name: string;
  owner_id: number | null;
  budget_total: number;
  plan_start: string | null;
  plan_end: string | null;
  can_decide: boolean;
}
export interface PendingAdjust {
  kind: "budget_adjust";
  id: number;
  project_id: number;
  project_name: string;
  subject: string;
  old_amount: number;
  new_amount: number;
  reason: string;
  by_id: number | null;
  can_decide: boolean;
}
export interface PendingExpense {
  kind: "expense";
  id: number;
  project_id: number;
  project_name: string;
  subject: string;
  amount: number;
  exp_date: string | null;
  note: string;
  by_id: number | null;
  can_decide: boolean;
}
export interface PendingApprovals {
  project_filings: PendingFilings[];
  budget_adjusts: PendingAdjust[];
  expenses: PendingExpense[];
  /** 三类待办总数（= 三个数组长度之和，与 totals 一致） */
  total: number;
  /** Stage 3A：三类待办真实总数，每类服务端最多返回 limit 条 */
  totals?: { project_filings: number; budget_adjusts: number; expenses: number };
  /** Stage 3A：本次请求的 limit（默认 200，上限 500） */
  limit?: number;
}

export const notificationsApi = {
  list: (q = "") =>
    apiGet<{ total: number; unread: number; page: number; size: number; items: Notification[] }>(`/notifications${q}`),
  count: () => apiGet<{ unread: number }>("/notifications/count"),
  read: (id: number) => apiPost<{ ok: boolean }>(`/notifications/${id}/read`, {}),
  readAll: () => apiPost<{ ok: boolean; read: number }>("/notifications/read-all", {}),
};

export const approvalsApi = {
  pending: () => apiGet<PendingApprovals>("/approvals/pending"),
  decide: (kind: string, id: number, approve: boolean, reason = "") =>
    apiPost<{ kind: string; id: number; status: string }>(`/approvals/${kind}/${id}/decide`, { approve, reason }),
  exception: (eid: number, reason = "") =>
    apiPost<{ kind: string; id: number; status: string }>(`/approvals/expense/${eid}/exception`, { reason }),
};

// ---------------- Stage 4：工作台看板 ----------------
export interface DashboardKpi {
  my_projects: number;
  active_projects: number;
  overdue_tasks: number;
  my_overdue_tasks: number;
  near_milestones: number;
  stagnant_projects: number;
  total_budget: number;
  total_spent: number;
  total_rate: number;
  month_spent: number;
  month: string;
  pending_approvals: number;
  unread_notifications: number;
}
export interface HealthRow {
  id: number;
  code: string;
  name: string;
  status: string;
  priority: string;
  owner_id: number | null;
  progress: number;
  plan_end: string | null;
  budget: number;
  spent: number;
  rate: number;
  overdue_tasks: number;
  stagnant_days: number;
  health: "ok" | "risk" | "bad" | "closed";
}
export interface DashboardSummary {
  kpi: DashboardKpi;
  trend: { month: string; spent: number }[];
  by_subject: { subject: string; budget: number; spent: number }[];
  health: HealthRow[];
}
export interface Weekly {
  range: { from: string; to: string };
  project_id: number | null;
  progress_logs: { task_id: number; project_id: number; user_id: number | null; progress: number; note: string; created_at: string | null }[];
  log_count: number;
  overdue: { id: number; name: string; project_id: number; plan_end: string | null; progress: number; owner_id: number | null }[];
  due_soon: { id: number; name: string; project_id: number; plan_end: string | null; progress: number; owner_id: number | null }[];
  projects: { id: number; code: string; name: string; status: string; progress: number }[];
}

export const dashboardApi = {
  summary: () => apiGet<DashboardSummary>("/dashboard/summary"),
  weekly: (projectId = 0) =>
    apiGet<Weekly>(`/dashboard/my-weekly${projectId ? `?project_id=${projectId}` : ""}`),
};
