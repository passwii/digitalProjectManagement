/**
 * 当前用户身份快照的纯逻辑：token 绑定 + 形状校验 + 序列化（BLF-1125）。
 *
 * 为什么需要一份本地快照：`/auth/me` 要等一次网络往返，而侧栏/顶栏的头像与姓名
 * 必须在**首帧**就是对的。没有快照时 React 只能先渲染 `null` 的兜底值
 * （老实现是「当前用户」），于是刷新时先闪一个假名字再换成真名字。
 *
 * 这里刻意不依赖 DOM，也不依赖 `lib/api`：`tsconfig.test.json` 只有 ES2022，
 * 编译不了带 DOM 引用的 `api.ts`，抽出来才能用 node:test 覆盖
 * 「坏数据/别人的身份不能被当成当前用户」这类回归点。
 * 存储与 React 绑定分别在 `lib/api.ts`、`lib/useMeta.ts`。
 */

/** 身份快照至少要有的字段（与 `lib/api` 的 `Me` 结构兼容，故用泛型放宽） */
export interface IdentityUser {
  id: number;
  username: string;
  real_name: string;
  roles: readonly { code: string; name: string }[];
}

/** localStorage 键：与 access token 同级的会话级数据，登出/换账号即失效 */
export const IDENTITY_STORAGE_KEY = "pm_identity_v1";

interface StoredIdentity {
  token: string;
  me: unknown;
}

function isRole(v: unknown): v is { code: string; name: string } {
  const r = v as { code?: unknown; name?: unknown } | null;
  return r !== null && typeof r === "object" && typeof r.code === "string" && typeof r.name === "string";
}

/**
 * 形状校验：字段缺失/类型不对/roles 里混入垃圾一律不认。
 * 宁可退回骨架屏，也不能把一个来路不明的对象当作当前用户显示出去。
 */
function isIdentityUser(v: unknown): v is IdentityUser {
  const u = v as Partial<IdentityUser> | null;
  if (u === null || typeof u !== "object") return false;
  return (
    typeof u.id === "number" &&
    typeof u.username === "string" &&
    typeof u.real_name === "string" &&
    Array.isArray(u.roles) &&
    u.roles.every(isRole)
  );
}

export function serializeIdentitySnapshot(me: IdentityUser, token: string): string {
  const stored: StoredIdentity = { token, me };
  return JSON.stringify(stored);
}

/**
 * 解析快照：只有 **token 与当前会话一致** 且内容形状合法时才算命中。
 * 非 JSON、结构不符、token 不符（换了账号/会话）一律返回 `null`，即「没有缓存」。
 */
export function parseIdentitySnapshot<T extends IdentityUser>(
  raw: string | null,
  token: string | null,
): T | null {
  if (!raw || !token) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIdentity> | null;
    if (!parsed || typeof parsed.token !== "string" || parsed.token !== token) return null;
    if (!isIdentityUser(parsed.me)) return null;
    return parsed.me as T;
  } catch {
    return null;
  }
}

// ---------------- 身份展示文案（纯派生，UI 只负责渲染） ----------------

/**
 * 展示用姓名：`real_name` 优先，缺省回落 `username`。
 * 没有身份数据时返回空串 —— 占位文案（老实现的「当前用户」）必须由渲染层
 * 换成骨架屏，否则用户会看到一句假名字然后被换掉，即本次要修的闪烁。
 */
export function displayNameOf(me: IdentityUser | null): string {
  if (!me) return "";
  return me.real_name || me.username;
}

export interface RoleLine {
  /** 侧栏整行文案 */
  text: string;
  /** 鼠标悬停的完整说明 */
  tip: string;
}

export interface IdentityView {
  /**
   * 展示用姓名。`null` = 尚未确认 —— UI 必须渲染骨架，
   * **绝不能回退到「当前用户」这类占位文案**，那正是本次闪烁的来源。
   */
  name: string | null;
  /** 侧栏角色行；`null` = 权限未确认 → 骨架 */
  role: RoleLine | null;
  /** 顶栏身份短描述；`null` = 权限未确认 → 骨架 */
  roleShort: string | null;
}

export interface IdentityViewInput {
  me: IdentityUser | null;
  /** `null` = 权限尚未确认（`/meta/me/menus` 在飞行中） */
  isAdmin: boolean | null;
  /** 权限同步失败：既不能声称管理员也不能声称普通用户，但可以如实告知失败 */
  permsFailed?: boolean;
  /** 身份接口失败且没有可用快照：如实告知，而不是把骨架永远转下去 */
  identityFailed?: boolean;
}

/** 身份接口失败时的中性文案：明确"不知道"，不冒充任何用户 */
export const IDENTITY_UNAVAILABLE = "身份信息未同步";

/**
 * 把身份与权限两股异步状态推导成展示文案。
 *
 * 核心约定：**未确认就返回 `null`（骨架），绝不猜一个默认值。**
 * 老实现用 `me?.real_name || "当前用户"` 直接渲染，于是刷新时先显示「当前用户」
 * 再被真实姓名替换 —— 这就是 BLF-1125 的闪烁。权限同理：不能先显示「普通用户」
 * 再把管理员改成「管理员」（`isAdmin === null` 即此情形）。
 *
 * 失败状态与加载状态必须区分：失败时可以调用者已知的信息（快照/角色名），
 * 否则骨架屏会永远转下去（老实现则是永远显示「当前用户」）。
 */
export function identityViewOf({
  me,
  isAdmin,
  permsFailed = false,
  identityFailed = false,
}: IdentityViewInput): IdentityView {
  const confirmedName = displayNameOf(me);
  // 有快照就用快照的姓名（它是本会话的真实数据）；否则只有在失败时才给出中性文案
  const name = confirmedName || (identityFailed ? IDENTITY_UNAVAILABLE : null);
  const roleNames = me ? me.roles.map((r) => r.name).filter(Boolean) : [];

  // 权限同步失败：不断言管理/非管理员，只陈述已确认的角色名并引导重试
  if (permsFailed) {
    return {
      name,
      role: {
        text: "权限信息加载失败",
        tip: "权限信息加载失败，仅显示基础入口；可在导航下方点击「重试」",
      },
      roleShort: roleNames.length ? roleNames.join(" / ") : IDENTITY_UNAVAILABLE,
    };
  }

  // 权限还没回来：角色区保持骨架，不输出任何角色断言
  if (isAdmin === null) return { name, role: null, roleShort: null };

  if (isAdmin) {
    return {
      name,
      role: {
        text: "管理员 · 全局管理与审批",
        tip: "管理员是唯一的管理与审批角色，可跨部门、跨项目查看与处理管理数据",
      },
      roleShort: "管理员",
    };
  }

  return {
    name,
    role: {
      text: "普通用户 · 参与项目业务",
      tip: roleNames.length
        ? `角色：${roleNames.join(" / ")}（当前仅参与项目业务，无管理与审批权限）`
        : "当前账号无管理与审批权限，仅参与项目业务",
    },
    roleShort: "项目成员",
  };
}
