// API 封装：base + token 注入 + 401 跳登录。字段与后端 api/routers/*.py 对齐。
import { beginTrackedActivity } from "./activityBus";
import {
  IDENTITY_STORAGE_KEY,
  serializeIdentitySnapshot,
  type IdentityUser,
} from "./identityCore";
import { uploadPercent, type UploadProgress } from "./uploadZone";

/**
 * `process` 的模块内声明。
 *
 * Next 只会把**字面形式**的 `process.env.NEXT_PUBLIC_*` 在构建期静态替换成常量，
 * 所以这个访问形式不能改写（换成 `globalThis.process?.env` 会失去替换、上线指错后端）。
 * 这里声明一次，让「不在 web/ 项目上下文里的类型检查器」（拿不到 `@types/node`）
 * 也能通过；声明是纯类型，编译后会被抹掉，不影响构建期替换与运行时行为。
 */
declare const process: { env: Record<string, string | undefined> };

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8001/api/v1";

export class UnauthorizedError extends Error {}
export class NetworkError extends Error {}

/**
 * 带状态码与响应体的 HTTP 错误（非 2xx）。
 *
 * `message` 仍是 `API <status>: <body>` —— 历史上 `errText()` 用正则从这个格式里取值，
 * 格式不能变；额外把 `status` / `body` **结构化**出来，让 `uploadErrors` 的
 * 502（可重试）/ 404（文件已丢失）/ 400（体积类型不合规）分层不必靠字符串猜。
 */
export class HttpError extends Error {
  readonly status: number;
  /** 原始响应体（可能为空串） */
  readonly body: string;
  /** 响应为空时的兜底文本（fetch 的 statusText / XHR 的 statusText） */
  readonly statusText: string;

  constructor(status: number, body: string, statusText = "") {
    super(`API ${status}: ${body || statusText}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body || "";
    this.statusText = statusText || "";
  }
}

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

/**
 * 身份快照的存储访问统一入口：Storage 不可用（隐私模式 / 配额不足 / SSR）时
 * 一律静默降级为 fallback —— 只影响首帧是否闪烁，不能让存储异常打断登录流程。
 */
function withIdentityStorage<T>(run: (ls: Storage) => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return run(window.localStorage);
  } catch {
    return fallback;
  }
}

/**
 * 已登录用户的身份快照（BLF-1125）：让 `/auth/me` 回来之前就能显示正确头像与姓名。
 *
 * 存在 localStorage 而非内存：刷新会重建整个 JS 上下文，内存缓存活不过刷新，
 * 那正是「刷新时先闪默认值」的成因。快照与 token 绑定存储，因此换账号
 * （token 变了）自动失效，不会把上一个人的姓名显示给新用户。
 *
 * 这里只负责存储 I/O；解析与「同一快照返回同一引用」的缓存见
 * `lib/useMeta.ts` 的身份 store（引用稳定是 useSyncExternalStore 的硬要求）。
 */
export function readIdentityRaw(): string | null {
  return withIdentityStorage((ls) => ls.getItem(IDENTITY_STORAGE_KEY), null);
}

/** 写入身份快照；存储不可用时静默降级（只影响首帧是否闪烁，不影响功能） */
export function writeIdentityCache(me: IdentityUser, token: string): void {
  withIdentityStorage((ls) => {
    ls.setItem(IDENTITY_STORAGE_KEY, serializeIdentitySnapshot(me, token));
  }, undefined);
}

/** 清除身份快照（随登出；token 本身失效时也会因 token 不匹配而自然失效） */
export function clearIdentityCache(): void {
  withIdentityStorage((ls) => {
    ls.removeItem(IDENTITY_STORAGE_KEY);
  }, undefined);
}

/** 会话失效后的登录页跳转目标：站内固定路径，不接受任何外部输入 */
const LOGIN_PATH = "/login";

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  clearIdentityCache();
  document.cookie = "pm_access_token=; path=/; max-age=0";
  if (typeof window === "undefined") return;
  // 固定站内路径 + 同源解析：目标不可被外部输入影响，无开放重定向风险
  if (window.location.pathname === LOGIN_PATH) return;
  window.location.assign(new URL(LOGIN_PATH, window.location.origin).toString());
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
  // 代理层错误页（例如 nginx / Vercel 边缘回的 502 HTML）：绝不把整页 HTML 丢进 UI，
  // 那会让 502 与 404 一样「什么都看不出来」。附件传输的 502/404/400 分层见 uploadErrors。
  if (/[<>]/.test(body)) return "请求失败，请稍后重试";
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
    throw new HttpError(res.status, body, res.statusText);
  }
  if (raw) {
    // SAFETY: `raw` 只用于下载/二进制路径，调用方按泛型 T 自行解释响应体，这里不做运行时校验
    return res as unknown as T;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 后端异常时可能返回 HTML/纯文本错误页：给出可读文案，不把 SyntaxError 泄漏到 UI
    throw new Error(`API 返回了非 JSON 响应：${text.slice(0, 120)}`);
  }
}

function trackedMutation<T>(label: string, run: () => Promise<T>): Promise<T> {
  const finish = beginTrackedActivity({ label, scope: "form" });
  return run().finally(finish);
}

/** 主动取消（组件卸载 / 关闭弹层）用的错误：`name` 与 fetch 的 AbortError 对齐，调用方可统一静默。 */
export class UploadAbortedError extends Error {
  override name = "AbortError";
}

/**
 * 上传进度回调的类型由 `uploadZone` 定义（无 DOM 依赖，便于纯逻辑模块引用）；
 * 这里重导出，调用方从 `@/lib/api` 取类型的老写法仍然可用。
 */
export type { UploadProgress };

/**
 * 带进度的上传通道：`fetch` 无法上报「已发出多少字节」，改用 `XMLHttpRequest`
 * 的 `upload.onprogress`。
 *
 * 这是全站附件的唯一上传实现，各调用点只需在 `uploadProgress` 上更新自己的 UI，
 * 不要再各写一遍 XHR。
 *
 * 约定：
 *   · 鉴权头、401 清会话、错误文案展开都与 {@link request} 保持一致，调用方拿到的
 *     错误类型不变（`UnauthorizedError` / `NetworkError` / `Error`）；
 *   · `trackedMutation` 的活动追踪保留——成功、失败、取消三条路径都会 `finish()`，
 *     顶部全局活动条不会因改写而失效；
 *   · `signal.aborted` 时在途请求立即 `abort()`，`promise` 以 `UploadAbortedError` 收场。
 */
export function apiUploadWithProgress<T>(
  path: string,
  form: FormData,
  options: { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void; headers?: Record<string, string> } = {},
): Promise<T> {
  const { signal, onProgress, headers: extraHeaders } = options;
  return trackedMutation(
    "上传中",
    () =>
      new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new UploadAbortedError("上传已取消"));
          return;
        }

        const xhr = new XMLHttpRequest();
        const token = getToken();

        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        function onAbort() {
          xhr.abort();
        }

        xhr.open("POST", `${API_BASE}${path}`);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        Object.entries(extraHeaders ?? {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        // 不手动设置 Content-Type：交给浏览器补 multipart boundary。

        if (onProgress) {
          xhr.upload.onprogress = (event) => {
            onProgress({
              loaded: event.loaded,
              total: event.total,
              percent: uploadPercent(event.loaded, event.total, event.lengthComputable),
            });
          };
        }

        xhr.onload = () => {
          cleanup();
          if (xhr.status === 401) {
            clearSession();
            reject(new UnauthorizedError("未登录或会话已过期"));
            return;
          }
          const text = xhr.responseText;
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new HttpError(xhr.status, text, xhr.statusText));
            return;
          }
          if (xhr.status === 204 || !text) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`API 返回了非 JSON 响应：${text.slice(0, 120)}`));
          }
        };

        xhr.onerror = () => {
          cleanup();
          reject(new NetworkError("无法连接后端"));
        };

        xhr.onabort = () => {
          cleanup();
          reject(new UploadAbortedError("上传已取消"));
        };

        xhr.ontimeout = () => {
          cleanup();
          reject(new NetworkError("上传超时"));
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        xhr.send(form);
      }),
  );
}

/** GET：可选传 AbortSignal，快速切换筛选/项目时取消过期请求（BLF-1095） */
export const apiGet = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
export const apiGetScoped = <T>(path: string, headers: Record<string, string>, signal?: AbortSignal) =>
  request<T>(path, { signal, headers });
export const apiPost = <T>(path: string, body?: unknown) =>
  trackedMutation("提交中", () =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  );
export const apiPut = <T>(path: string, body: unknown) =>
  trackedMutation("保存中", () => request<T>(path, { method: "PUT", body: JSON.stringify(body) }));
export const apiPatch = <T>(path: string, body: unknown) =>
  trackedMutation("保存中", () => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }));
export const apiPostScoped = <T>(path: string, body: unknown, headers: Record<string, string>) =>
  trackedMutation("提交中", () =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), headers }),
  );
export const apiPatchScoped = <T>(path: string, body: unknown, headers: Record<string, string>) =>
  trackedMutation("保存中", () =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), headers }),
  );
export const apiDeleteScoped = <T>(path: string, headers: Record<string, string>) =>
  trackedMutation("删除中", () => request<T>(path, { method: "DELETE", headers }));
export const apiDelete = <T>(path: string) =>
  trackedMutation("删除中", () => request<T>(path, { method: "DELETE" }));

/** 上传入口的可选参数：取消信号 + 进度回调（两者都可缺省）。 */
export type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  headers?: Record<string, string>;
};

/**
 * 上传（带进度）。保留原 `apiUpload` 名字与签名前缀，各 api 命名空间无需改动调用方式，
 * 只需按需补上第三个 `options`。
 */
export const apiUpload = <T>(path: string, form: FormData, options?: UploadOptions) =>
  apiUploadWithProgress<T>(path, form, options);

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
  const finish = beginTrackedActivity({ label: "下载中", scope: "form" });
  try {
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
  } finally {
    finish();
  }
}

export async function downloadFileScoped(path: string, filename: string, headers: Record<string, string>) {
  const finish = beginTrackedActivity({ label: "下载中", scope: "form" });
  try {
    const res = await request<Response>(path, { headers }, true);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    finish();
  }
}

/**
 * 需要鉴权的文件转浏览器对象 URL（图片 / PDF 预览用，调用方负责 revokeObjectURL）。
 *
 * `type` 是**安全参数**，不是装饰：下载响应头里的 `Content-Type` 来自上传时的客户端声明，
 * 后端只校验扩展名、不校验 type，因此它不可信（`任意.pdf` + `text/html` 会原样回放）。
 * blob URL 继承创建者源，而 token 在 `localStorage`，把这个类型交给 `<iframe>` 就等于
 * 以应用同源执行攻击者写的 HTML。传入由**扩展名**定权的类型（见 `previewBlobType`）即可断开该链路：
 * `blob.slice` 只改写类型、不重编码字节。不传 `type` 时保持原行为（如下载/缩略图路径的调用方）。
 */
export async function fetchObjectUrl(path: string, type?: string): Promise<string> {
  const res = await request<Response>(path, {}, true);
  const blob = await res.blob();
  return URL.createObjectURL(type ? blob.slice(0, blob.size, type) : blob);
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
  can_finance: boolean;
  menus: { key: string; label: string; href: string }[];
  readonly: boolean;
  /** 演示数据开关当前状态（所有登录用户可读） */
  demo_on: boolean;
  /** 是否可切换演示开关（仅管理员） */
  can_toggle_demo: boolean;
}

export interface FinanceBook {
  id: number;
  code: string;
  name: string;
  base_currency: string;
  currencies: string[];
  status: string;
}
export interface FinancePeriod {
  id: number;
  year: number;
  month: number;
  period: string;
  status: "open" | "closed" | "locked";
  start_date: string;
  end_date: string;
  version: number;
}
export interface FinanceAccount {
  id: number;
  code: string;
  name: string;
  level: number;
  parent_id: number | null;
  direction: "D" | "C";
  category: string;
  subject_version: string;
  aux_flags: Record<string, boolean>;
  is_leaf: boolean;
  is_active: boolean;
}
export interface FinanceEntry {
  id?: number;
  line_no?: number;
  account_id: number;
  account_code?: string;
  account_name?: string;
  summary: string;
  debit: string;
  credit: string;
  aux_detail?: Record<string, unknown>;
  cashflow_item?: string | null;
}
export interface FinanceVoucher {
  id: number;
  period_id: number;
  voucher_no: string;
  voucher_date: string;
  status: "draft" | "pending" | "posted" | "void";
  source: string;
  summary: string;
  total_debit: string;
  total_credit: string;
  created_by: number | null;
  reviewed_by: number | null;
  posted_by: number | null;
  reversal_of: number | null;
  decision_reason: string;
  lines: FinanceEntry[];
}
export interface FinanceBalance {
  account_id: number;
  account_code: string;
  account_name: string;
  debit_total: string;
  credit_total: string;
  ending_debit: string;
  ending_credit: string;
}

export interface FinanceVoucherInput {
  period_id: number;
  voucher_no: string;
  voucher_date: string;
  summary: string;
  source?: string;
  lines: FinanceEntry[];
}
export interface FinanceVoucherTemplate {
  id: number;
  code: string;
  name: string;
  lines: FinanceEntry[];
  is_active: boolean;
}
export interface CashTransaction {
  id: number;
  kind: "receipt" | "payment" | "expense";
  status: string;
  amount: string;
  voucher: FinanceVoucher;
}
export interface BankStatement {
  id: number;
  external_id: string;
  transaction_date: string;
  direction: "inflow" | "outflow";
  amount: string;
  account_code: string;
  summary: string;
  counterparty: string;
  status: "unmatched" | "matched" | "ignored";
  matched_voucher_id: number | null;
}
export interface FixedAsset {
  id: number;
  code: string;
  name: string;
  category: string;
  acquisition_date: string;
  original_cost: string;
  residual_rate: string;
  useful_life_months: number;
  accumulated_depreciation: string;
  net_book_value: string;
  status: string;
}

function financeHeaders(bookCode: string): Record<string, string> {
  return { "X-Account-Book": bookCode };
}

export const financeApi = {
  books: {
    list: (signal?: AbortSignal) => apiGet<FinanceBook[]>("/finance/books", signal),
    create: (body: { code: string; name: string; base_currency?: string }) =>
      apiPost<FinanceBook>("/finance/books", body),
  },
  periods: (book: string, year?: number, signal?: AbortSignal) =>
    apiGetScoped<FinancePeriod[]>(`/finance/periods${buildQuery({ year })}`, financeHeaders(book), signal),
  periodStatus: (book: string, id: number, status: FinancePeriod["status"], version: number, reopen = false) =>
    apiPatchScoped<Pick<FinancePeriod, "id" | "status" | "version">>(
      `/finance/periods/${id}`,
      { status },
      { ...financeHeaders(book), "If-Match": String(version), ...(reopen ? { "X-Reopen-Period": "confirm" } : {}) },
    ),
  accounts: (book: string, signal?: AbortSignal) =>
    apiGetScoped<FinanceAccount[]>("/finance/accounts/tree", financeHeaders(book), signal),
  opening: (book: string, signal?: AbortSignal) =>
    apiGetScoped<{ id: number; account_id: number; aux_key: string; debit: string; credit: string }[]>(
      "/finance/opening-balances",
      financeHeaders(book),
      signal,
    ),
  openingCheck: (book: string, signal?: AbortSignal) =>
    apiGetScoped<{ balanced: boolean; debit: string; credit: string; difference: string }>(
      "/finance/opening-balances/check",
      financeHeaders(book),
      signal,
    ),
  vouchers: (book: string, params: { status?: string; period_id?: number; page?: number; size?: number } = {}, signal?: AbortSignal) =>
    apiGetScoped<Paged<FinanceVoucher>>(
      `/finance/vouchers${buildQuery(params)}`,
      financeHeaders(book),
      signal,
    ),
  templates: (book: string, signal?: AbortSignal) =>
    apiGetScoped<FinanceVoucherTemplate[]>("/finance/voucher-templates", financeHeaders(book), signal),
  createTemplate: (book: string, body: { code: string; name: string; lines: FinanceEntry[] }) =>
    apiPostScoped<FinanceVoucherTemplate>("/finance/voucher-templates", body, financeHeaders(book)),
  fromTemplate: (book: string, body: { template_id: number; period_id: number; voucher_no: string; voucher_date: string; summary: string }) =>
    apiPostScoped<FinanceVoucher>("/finance/vouchers/from-template", body, financeHeaders(book)),
  importVouchers: (book: string, periodId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiUpload<{ imported: number; vouchers: FinanceVoucher[] }>(
      `/finance/vouchers/import?period_id=${periodId}`,
      form,
      { headers: financeHeaders(book) },
    );
  },
  exportVouchers: (book: string, periodId: number) =>
    downloadFileScoped(`/finance/vouchers/export?period_id=${periodId}`, `vouchers_${periodId}.xlsx`, financeHeaders(book)),
  createVoucher: (book: string, body: FinanceVoucherInput) =>
    apiPostScoped<FinanceVoucher>("/finance/vouchers", body, financeHeaders(book)),
  submitVoucher: (book: string, id: number) =>
    apiPostScoped<FinanceVoucher>(`/finance/vouchers/${id}/submit`, {}, financeHeaders(book)),
  approveVoucher: (book: string, id: number) =>
    apiPostScoped<FinanceVoucher>(`/finance/vouchers/${id}/approve`, {}, financeHeaders(book)),
  postVoucher: (book: string, id: number) =>
    apiPostScoped<FinanceVoucher>(`/finance/vouchers/${id}/post`, {}, financeHeaders(book)),
  rejectVoucher: (book: string, id: number, reason: string) =>
    apiPostScoped<FinanceVoucher>(`/finance/vouchers/${id}/reject`, { reason }, financeHeaders(book)),
  reverseVoucher: (book: string, id: number) =>
    apiPostScoped<FinanceVoucher>(`/finance/vouchers/${id}/reverse`, {}, financeHeaders(book)),
  balances: (book: string, periodId: number, signal?: AbortSignal) =>
    apiGetScoped<{ items: FinanceBalance[] }>(
      `/finance/balances?period_id=${periodId}`,
      financeHeaders(book),
      signal,
    ),
  closeCheck: (book: string, periodId: number, signal?: AbortSignal) =>
    apiGetScoped<{ period_id: number; ready: boolean; issues: { code: string; message: string }[] }>(
      `/finance/close/check?period_id=${periodId}`,
      financeHeaders(book),
      signal,
    ),
  close: (book: string, periodId: number, version: number) =>
    apiPostScoped<{ id: number; status: string; version: number }>(
      `/finance/close/run?period_id=${periodId}`,
      {},
      { ...financeHeaders(book), "If-Match": String(version) },
    ),
  reopen: (book: string, periodId: number, version: number) =>
    apiPostScoped<{ id: number; status: string; version: number }>(
      `/finance/close/reverse?period_id=${periodId}&confirm=true`,
      {},
      { ...financeHeaders(book), "If-Match": String(version) },
    ),
  balanceSheet: (book: string, periodId: number, signal?: AbortSignal) =>
    apiGetScoped<{ totals: { assets: string; liabilities: string; equity: string; profit_before_close: string; balanced: boolean } }>(
      `/finance/reports/balance-sheet?period_id=${periodId}`,
      financeHeaders(book),
      signal,
    ),
  income: (book: string, periodId: number, signal?: AbortSignal) =>
    apiGetScoped<{ totals: { income: string; expense: string; profit: string } }>(
      `/finance/reports/income?period_id=${periodId}`,
      financeHeaders(book),
      signal,
    ),
  cashflow: (book: string, periodId: number, signal?: AbortSignal) =>
    apiGetScoped<{ ready: boolean; unclassified_amount: string }>(
      `/finance/reports/cashflow?period_id=${periodId}`,
      financeHeaders(book),
      signal,
    ),
  cashTransactions: (book: string, body: Record<string, unknown>) =>
    apiPostScoped<CashTransaction>("/finance/cash-transactions", body, financeHeaders(book)),
  bankStatements: (book: string, periodId?: number, signal?: AbortSignal) =>
    apiGetScoped<{ total: number; items: BankStatement[] }>(
      `/finance/bank-statements${buildQuery({ period_id: periodId })}`,
      financeHeaders(book),
      signal,
    ),
  importBankStatements: (book: string, periodId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiUpload<{ imported: number; items: BankStatement[] }>(
      `/finance/bank-statements/import?period_id=${periodId}`,
      form,
      { headers: financeHeaders(book) },
    );
  },
  matchBankStatement: (book: string, statementId: number, voucherId: number) =>
    apiPostScoped<{ id: number; status: string; matched_voucher_id: number }>(
      `/finance/bank-statements/${statementId}/match`,
      { voucher_id: voucherId },
      financeHeaders(book),
    ),
  reconciliation: (book: string, periodId: number, signal?: AbortSignal) =>
    apiGetScoped<{ period_id: number; bank_total: string; unmatched_count: number; unmatched_amount: string; items: BankStatement[] }>(
      `/finance/bank-reconciliation?period_id=${periodId}`,
      financeHeaders(book),
      signal,
    ),
  fixedAssets: (book: string, signal?: AbortSignal) =>
    apiGetScoped<{ total: number; items: FixedAsset[] }>("/finance/fixed-assets", financeHeaders(book), signal),
  createFixedAsset: (book: string, body: Record<string, unknown>) =>
    apiPostScoped<FixedAsset>("/finance/fixed-assets", body, financeHeaders(book)),
  depreciateFixedAssets: (book: string, periodId: number) =>
    apiPostScoped<{ period_id: number; depreciated: number; total_amount: string }>(
      `/finance/fixed-assets/depreciate?period_id=${periodId}`,
      {},
      financeHeaders(book),
    ),
};
export interface Project {
  id: number;
  code: string;
  name: string;
  type: string;
  dept_id: number | null;
  owner_id: number | null;
  owner_name?: string;
  member_ids: number[];
  plan_start: string | null;
  plan_end: string | null;
  budget_total: number;
  priority: string;
  client: string;
  client_contact: string;
  client_phone: string;
  description: string;
  contract_status?: string;
  forward_contract?: string;
  backward_contract?: string;
  status: string;
  progress: number;
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

/**
 * 负责人筛选项（`GET /projects/owners`）：台账「负责人」列实际出现的姓名 + 项目数。
 *
 * 选项取「展示口径的姓名」而不是账号 id —— 负责人没有登录账号时后端会把
 * `owner_id` 落成创建人的 id，按 id 筛会出现「选谁都是全部结果」。
 */
export interface ProjectOwnerOption {
  name: string;
  count: number;
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
  ref_type?: string;
  category?: string;
  content_type?: string;
  uploaded_by: number | null;
  uploaded_at: string | null;
}

export type ContactAttachmentCategory =
  | "id_card"
  | "education"
  | "degree"
  | "professional_cert"
  | "labor_contract"
  | "other";

export interface ContactAttachment extends Attachment {
  category: ContactAttachmentCategory | "";
}

export interface Contact {
  id: number;
  user_id: number | null;
  username: string;
  name: string;
  real_name: string;
  mobile: string;
  dept_id: number | null;
  dept_name: string;
  account_status: string;
  has_account: boolean;
  employee_no: string;
  position: string;
  manager_id: number | null;
  manager_name: string;
  employment_type: string;
  employment_status: "active" | "probation" | "leave";
  hire_date: string | null;
  regular_date: string | null;
  leave_date: string | null;
  work_email: string;
  office_phone: string;
  work_location: string;
  contract_type: string;
  contract_start: string | null;
  contract_end: string | null;
  gender: string;
  birth_date: string | null;
  id_card_no: string;
  id_card_masked: string;
  native_place: string;
  political_status: string;
  marital_status: string;
  address: string;
  highest_education: string;
  school: string;
  major: string;
  graduation_date: string | null;
  degree: string;
  emergency_contact: string;
  emergency_relation: string;
  emergency_phone: string;
  remark: string;
  has_profile: boolean;
  attachment_count: number;
  updated_at: string | null;
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
  created_at?: string | null;
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
  decision_reason?: string;
  decided_at?: string | null;
  resubmit_count?: number;
  can_resubmit?: boolean;
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
  /**
   * 负责人筛选项（`GET /projects/owners`）：台账实际出现的负责人姓名 + 项目数。
   *
   * 与「负责人」筛选同口径：下拉里选到的任何名字都能被 `GET /projects?owner=<姓名>`
   * 精确筛出（含没有登录账号的负责人）。服务端有界（200 行），一次取回本地渲染。
   */
  owners: (signal?: AbortSignal) => apiGet<ProjectOwnerOption[]>("/projects/owners", signal),
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
  changes: (id: number, signal?: AbortSignal) => apiGet<ProjectChange[]>(`/projects/${id}/changes`, signal),
  attachments: (id: number, refType = "", signal?: AbortSignal) =>
    apiGet<Attachment[]>(
      `/projects/${id}/attachments${refType ? `?ref_type=${encodeURIComponent(refType)}` : ""}`,
      signal,
    ),
  upload: (id: number, file: File, refType = "", options?: UploadOptions) => {
    const fd = new FormData();
    fd.append("file", file);
    if (refType) fd.append("ref_type", refType);
    return apiUpload<Attachment>(`/projects/${id}/attachments`, fd, options);
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
  progress: (id: number, signal?: AbortSignal) =>
    apiGet<{ project_id: number; progress: number; task_count: number }>(`/projects/${id}/progress`, signal),
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

/** 支出票据（后端 `GET /expenses/{id}/vouchers` 契约，BLF-1150/BLF-1151） */
export interface ExpenseVoucher {
  id: number;
  filename: string;
  size: number;
  content_type?: string;
  uploaded_by: number | null;
  uploaded_at: string | null;
}

export const expensesApi = {
  list: (q = "", signal?: AbortSignal) =>
    apiGet<Expense[] | Paged<Expense>>(`/expenses${q}`, signal),
  create: (body: Record<string, unknown>) => apiPost<Expense>("/expenses", body),
  vouchers: (eid: number, signal?: AbortSignal) =>
    apiGet<ExpenseVoucher[]>(`/expenses/${eid}/vouchers`, signal),
  uploadVoucher: (eid: number, file: File, options?: UploadOptions) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiUpload<ExpenseVoucher>(`/expenses/${eid}/vouchers`, fd, options);
  },
  downloadVoucher: (eid: number, aid: number, filename: string) =>
    downloadFile(`/expenses/${eid}/vouchers/${aid}/download`, filename),
  deleteVoucher: (eid: number, aid: number) =>
    apiDelete<{ ok: boolean }>(`/expenses/${eid}/vouchers/${aid}`),
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
  warnings: (signal?: AbortSignal) => apiGet<Warnings>("/reports/warnings", signal),
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
  operator_name: string;
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

export const contactsApi = {
  list: (q = "", signal?: AbortSignal) =>
    apiGet<Paged<Contact>>(`/contacts${q}`, signal),
  options: (keyword = "") =>
    apiGet<{ id: number; name: string; dept_id: number | null; position: string }[]>(
      `/contacts/options${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ""}`,
    ),
  create: (body: Record<string, unknown>) =>
    apiPost<Contact>("/contacts", body),
  get: (id: number) => apiGet<Contact>(`/contacts/${id}`),
  update: (id: number, body: Record<string, unknown>) =>
    apiPatch<Contact>(`/contacts/${id}`, body),
  attachments: (id: number, category: ContactAttachmentCategory | "" = "", signal?: AbortSignal) =>
    apiGet<ContactAttachment[]>(
      `/contacts/${id}/attachments${category ? `?category=${encodeURIComponent(category)}` : ""}`,
      signal,
    ),
  upload: (id: number, category: ContactAttachmentCategory, file: File, options?: UploadOptions) => {
    const fd = new FormData();
    fd.append("category", category);
    fd.append("file", file);
    return apiUpload<ContactAttachment>(`/contacts/${id}/attachments`, fd, options);
  },
  downloadAttachment: (id: number, aid: number, filename: string) =>
    downloadFile(`/contacts/${id}/attachments/${aid}/download`, filename),
  deleteAttachment: (id: number, aid: number) =>
    apiDelete<{ ok: boolean }>(`/contacts/${id}/attachments/${aid}`),
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
  list: (q = "", signal?: AbortSignal) =>
    apiGet<{ total: number; unread: number; page: number; size: number; items: Notification[] }>(`/notifications${q}`, signal),
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

// ---------------- 我的友商（BLF-1152 后端 / BLF-1153 前端） ----------------
// 契约见 `api/routers/partners.py`：全接口仅管理员；列表统一分页信封；
// 人员/业绩合同是作用域内小集合（返回数组）；附件 `ref_type='partner'` + 分类。
export type PartnerAttachmentCategory =
  | "qual_cert"
  | "performance"
  | "contract"
  | "other";

/** 附件分类中文名（与后端 `ATTACHMENT_CATEGORY_LABELS` 同口径）。 */
export const PARTNER_ATTACHMENT_CATEGORY_LABELS: Record<PartnerAttachmentCategory, string> = {
  qual_cert: "资质证书",
  performance: "业绩证明",
  contract: "合同扫描",
  other: "其他",
};

export interface PartnerAttachment extends Attachment {
  category: PartnerAttachmentCategory | "";
  category_label?: string;
}

export interface PartnerMember {
  id: number;
  partner_id: number;
  name: string;
  position: string;
  phone: string;
  email: string;
  remark: string;
  created_at: string | null;
}

export interface PartnerContract {
  id: number;
  partner_id: number;
  project_name: string;
  amount: number;
  signed_date: string | null;
  remark: string;
  created_at: string | null;
}

export interface Partner {
  id: number;
  name: string;
  partner_type: string;
  contact_name: string;
  phone: string;
  email: string;
  address: string;
  remark: string;
  /** 列表行携带计数；详情携带数组（两者不同时出现，用可选字段如实表达）。 */
  member_count?: number;
  contract_count?: number;
  members?: PartnerMember[];
  contracts?: PartnerContract[];
  attachment_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export const partnersApi = {
  list: (q = "", signal?: AbortSignal) =>
    apiGet<Paged<Partner>>(`/partners${q}`, signal),
  get: (id: number) => apiGet<Partner>(`/partners/${id}`),
  create: (body: Record<string, unknown>) =>
    apiPost<Partner>("/partners", body),
  update: (id: number, body: Record<string, unknown>) =>
    apiPatch<Partner>(`/partners/${id}`, body),
  remove: (id: number) => apiDelete<{ ok: boolean }>(`/partners/${id}`),
  members: (pid: number, signal?: AbortSignal) =>
    apiGet<PartnerMember[]>(`/partners/${pid}/members`, signal),
  createMember: (pid: number, body: Record<string, unknown>) =>
    apiPost<PartnerMember>(`/partners/${pid}/members`, body),
  updateMember: (pid: number, mid: number, body: Record<string, unknown>) =>
    apiPatch<PartnerMember>(`/partners/${pid}/members/${mid}`, body),
  deleteMember: (pid: number, mid: number) =>
    apiDelete<{ ok: boolean }>(`/partners/${pid}/members/${mid}`),
  contracts: (pid: number, signal?: AbortSignal) =>
    apiGet<PartnerContract[]>(`/partners/${pid}/contracts`, signal),
  createContract: (pid: number, body: Record<string, unknown>) =>
    apiPost<PartnerContract>(`/partners/${pid}/contracts`, body),
  updateContract: (pid: number, cid: number, body: Record<string, unknown>) =>
    apiPatch<PartnerContract>(`/partners/${pid}/contracts/${cid}`, body),
  deleteContract: (pid: number, cid: number) =>
    apiDelete<{ ok: boolean }>(`/partners/${pid}/contracts/${cid}`),
  attachments: (pid: number, category: PartnerAttachmentCategory | "" = "", signal?: AbortSignal) =>
    apiGet<PartnerAttachment[]>(
      `/partners/${pid}/attachments${category ? `?category=${encodeURIComponent(category)}` : ""}`,
      signal,
    ),
  upload: (pid: number, category: PartnerAttachmentCategory, file: File, options?: UploadOptions) => {
    const fd = new FormData();
    fd.append("category", category);
    fd.append("file", file);
    return apiUpload<PartnerAttachment>(`/partners/${pid}/attachments`, fd, options);
  },
  downloadAttachment: (pid: number, aid: number, filename: string) =>
    downloadFile(`/partners/${pid}/attachments/${aid}/download`, filename),
  deleteAttachment: (pid: number, aid: number) =>
    apiDelete<{ ok: boolean }>(`/partners/${pid}/attachments/${aid}`),
};
