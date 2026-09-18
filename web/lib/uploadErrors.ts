/**
 * 附件传输失败的**语义分层**（BLF-1137）。
 *
 * 背景：附件正文的唯一持久化口径是 Cloudflare R2（BLF-1136）。HTTP 契约没变，但失败语义变成了三档，
 * 而 `errText()` 只看响应体里的 `detail`，两种情况会掉进同一句泛化文案：
 *
 *   · **502** 存储暂时不可用（R2 挂了 / 凭据错 / 网络抖）→ 正文**没丢**，重试就能成功；
 *   · **404** 正文确实不存在（对象被删 / 迁移漏了）→ 重试一万次也没用，要找管理员；
 *   · **400** 体积或类型不合规 → 换文件才行。
 *
 * 还有第三种情况最容易被误判：502 是**代理层**（nginx / Vercel 边缘）回的，响应体是 HTML 错误页，
 * 既没有 `detail` 也没有可读文案 —— 此时把 HTML 原样丢给用户，和 404 一样「什么也看不出来」。
 * 所以本模块只认「解析得出的 JSON detail」，其余一律走本地兜底文案，绝不把 HTML 贴进 UI。
 *
 * 判定顺序刻意是「先看结构化状态码，再看文案」：状态码是契约，文案是展示。
 *
 * 分层结果直接驱动两件事：
 *   1. `retryable` → 上传行是否给出「重试」按钮（只有 502 这类才是真的可重试）；
 *   2. `label` / `hint` → 三档在 UI 上肉眼可分（徽标 + 下一步动作）。
 *
 * 与后端的对应关系（文案单一来源，前端不复制业务判定）：
 *   · 502 `文件存储不可用，请稍后重试（…）` ← `api/core/attachments.py` 的 `store_attachment()`；
 *   · 404 `附件文件已丢失，请联系管理员`   ← 同上 `_LOST_MSG`；
 *   · 400 `单文件最大 100MB` / `仅允许 …`  ← `api/core/limits.py` 与各 router 的 `ALLOWED_EXT`。
 */
import { HttpError, NetworkError, UnauthorizedError, UploadAbortedError } from "./api";

export type TransferFailureKind =
  /** 5xx 存储侧失败：正文不一定写进去了，可安全重试 */
  | "storage_unavailable"
  /** 5xx 其他服务端异常：同样可重试 */
  | "server_error"
  /** 404：正文确实不存在，重试无效 */
  | "file_lost"
  /** 400/413/415：体积、类型或状态不合规，换文件或换操作 */
  | "invalid"
  /** 403：无权执行该操作 */
  | "forbidden"
  /** 401：会话失效 */
  | "session"
  /** fetch/XHR 都没能连上后端 */
  | "network"
  /** 调用方主动取消（不是失败，通常静默） */
  | "aborted"
  /** 兜底 */
  | "unknown";

export interface TransferFailure {
  kind: TransferFailureKind;
  /** HTTP 状态码；无状态码（网络 / 取消 / 未知）时为 `null` */
  status: number | null;
  /** 可直接展示的中文文案（后端 detail 优先，否则本地兜底） */
  message: string;
  /** 短徽标，用于上传行的状态标记（例如「存储暂不可用」） */
  label: string;
  /** 下一步动作提示（例如「稍后可直接重试」） */
  hint: string;
  /** 是否值得原样重试：决定 UI 是否给出「重试」按钮 */
  retryable: boolean;
}

/** 各分层的固定文案与是否可重试（唯一真相，UI 与测试都读这里）。 */
const TIERS: Record<TransferFailureKind, { label: string; hint: string; fallback: string; retryable: boolean }> = {
  storage_unavailable: {
    label: "存储暂不可用",
    hint: "文件没有丢失，稍后可直接重试",
    fallback: "文件存储暂时不可用，请稍后重试",
    retryable: true,
  },
  server_error: {
    label: "服务异常",
    hint: "服务端暂时出错，稍后可直接重试",
    fallback: "服务暂时不可用，请稍后重试",
    retryable: true,
  },
  file_lost: {
    label: "附件已丢失",
    hint: "正文确实不存在，重试无效，请联系管理员补传",
    fallback: "附件文件已丢失，请联系管理员",
    retryable: false,
  },
  invalid: {
    label: "文件不合规",
    hint: "请更换文件后重新上传",
    fallback: "文件不符合上传要求",
    retryable: false,
  },
  forbidden: {
    label: "无权限",
    hint: "请联系管理员分配权限",
    fallback: "没有权限执行该操作",
    retryable: false,
  },
  session: {
    label: "会话已失效",
    hint: "请重新登录后再试",
    fallback: "未登录或会话已过期，请重新登录",
    retryable: false,
  },
  network: {
    label: "网络异常",
    hint: "后端没连上，检查网络后可直接重试",
    fallback: "无法连接后端服务，请稍后重试",
    retryable: true,
  },
  aborted: {
    label: "已取消",
    hint: "",
    fallback: "操作已取消",
    retryable: false,
  },
  unknown: {
    label: "操作失败",
    hint: "",
    fallback: "请求失败，请稍后重试",
    retryable: false,
  },
};

/**
 * 从形如 `API 502: {"detail":"…"}` 的错误消息里拆出状态码与响应体。
 *
 * 与 `api.request()` / `apiUploadWithProgress()` 的 `Error` 构造格式保持一致；
 * 拿不到状态码（非 API 错误）返回 `null`。
 */
export function splitApiMessage(message: string): { status: number; body: string } | null {
  const m = message.match(/^API (\d{3}):?\s?([\s\S]*)$/);
  if (!m) return null;
  return { status: Number(m[1]), body: m[2] ?? "" };
}

/**
 * 取出响应体里可展示的 `detail`（FastAPI 的两种形态：字符串 / 校验错误数组）。
 *
 * 非 JSON（例如代理的 HTML 502 页）返回 `null` —— 交由调用方走兜底文案。
 */
export function extractDetail(body: string): string | null {
  const raw = body.trim();
  if (!raw || !raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; message?: unknown };
    if (typeof parsed?.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
    if (Array.isArray(parsed?.detail)) {
      const joined = parsed.detail
        .map((row) => (row as { msg?: string } | null)?.msg ?? "")
        .filter(Boolean)
        .join("；");
      if (joined) return joined;
    }
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    /* 非 JSON：不是后端契约里的错误体 */
  }
  return null;
}

/**
 * 文案是否可以直接展示给用户。
 *
 * 排除 HTML/XML（代理错误页）、超长内容与空串：宁可显示本地兜底文案，
 * 也不要把 `<!DOCTYPE html>…` 贴进上传行。
 */
export function isDisplayable(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (value.length > 160) return false;
  return !/[<>]/.test(value);
}

/** 由状态码定分层。 */
export function kindForStatus(status: number): TransferFailureKind {
  if (status === 502 || status === 503 || status === 504) return "storage_unavailable";
  if (status === 404) return "file_lost";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "invalid";
  if (status === 401) return "session";
  if (status === 403) return "forbidden";
  if (status >= 500) return "server_error";
  return "unknown";
}

/** 组装分层结果（内部共用：状态码 + 响应体 → 文案）。 */
function build(kind: TransferFailureKind, status: number | null, body: string): TransferFailure {
  const tier = TIERS[kind];
  const detail = extractDetail(body);
  const plain = body.trim();
  const message = isDisplayable(detail ?? "")
    ? (detail as string)
    : !detail && plain && isDisplayable(plain)
      ? plain
      : tier.fallback;
  return { kind, status, message, label: tier.label, hint: tier.hint, retryable: tier.retryable };
}

/** 由「状态码 + 响应体」直接构造分层结果（测试与调用方都可用，不依赖 Error 实例）。 */
export function failureFromResponse(status: number, body: string): TransferFailure {
  return build(kindForStatus(status), status, body);
}

/**
 * 把任意异常翻译成分层结果。
 *
 * 判定优先级：主动取消 → 401 → 网络 → API 状态码 → 兜底。
 * 401 与取消**不看状态码以外的东西**，避免被响应体里的文案带偏。
 */
export function classifyTransferFailure(e: unknown): TransferFailure {
  if (e instanceof UploadAbortedError || (e as { name?: string } | null)?.name === "AbortError") {
    return build("aborted", null, "");
  }
  if (e instanceof UnauthorizedError) return build("session", 401, "");
  if (e instanceof NetworkError) return build("network", null, "");

  // 结构化状态码优先（HttpError 由 api.ts 抛出，与 message 格式同源）
  if (e instanceof HttpError) return build(kindForStatus(e.status), e.status, e.body);

  const raw = e instanceof Error ? e.message : String(e ?? "");
  const parsed = splitApiMessage(raw);
  if (parsed) return build(kindForStatus(parsed.status), parsed.status, parsed.body);
  return build("unknown", null, raw);
}

/**
 * 上传行/附件行的一行文案：`文案` + 「（可重试）」或动作提示。
 *
 * 502 与 404 在**行内**就已经分开：前者结尾是「可重试」，后者是「请联系管理员…」。
 */
export function failureLine(f: TransferFailure): string {
  const tail = f.retryable ? "可重试" : f.hint;
  return tail ? `${f.message}（${tail}）` : f.message;
}

/** Toast 文案：`徽标：文案`，可重试时附上动作提示。 */
export function failureToast(f: TransferFailure): string {
  const tail = f.hint ? ` · ${f.hint}` : "";
  return `${f.label}：${f.message}${tail}`;
}

/**
 * 一批文件的失败提示（多文件时只报一次）。
 *
 * 同一个原因（例如整批都撞上 502）就在结尾告知「可点行内「重试」」，
 * 多个原因混在一起就只说「多种原因」——逐条原因已经在上传行里了，
 * toast 不必把 N 条重得完整的话再展开一遍。
 */
export function batchFailureToast(failures: readonly TransferFailure[]): string {
  const first = failures[0];
  if (!first) return "";
  const head = `${failures.length} 个文件上传失败`;
  const sameReason = failures.every((f) => f.label === first.label);
  const tail = sameReason ? first.label : "多种原因";
  const action = sameReason && first.retryable ? "，可点行内「重试」" : "";
  return `${head}（${tail}）：${first.message}${action}`;
}
