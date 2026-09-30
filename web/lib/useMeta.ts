"use client";
// 元数据（用户/部门）全局缓存 + hook，供各页做 id→名称映射。
// 权限单一入口：`/meta/me/menus`（useMenus）返回可见菜单与 is_super_admin / can_approve，
// 页面不再各自硬编码角色判断；菜单模块及审批权限均由服务端判定。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  authApi,
  errText,
  getToken,
  metaApi,
  readIdentityRaw,
  writeIdentityCache,
  type Dept,
  type Me,
  type MenuResp,
  type UserOption,
} from "./api";
import { parseIdentitySnapshot } from "./identityCore";

interface Meta {
  users: UserOption[];
  depts: Dept[];
}

let cache: Meta | null = null;
let inflight: Promise<Meta> | null = null;

export function loadMeta(): Promise<Meta> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = Promise.all([metaApi.users(), metaApi.depts()])
      .then(([users, depts]) => {
        cache = { users, depts };
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

// ---------------- 当前用户身份：带 localStorage 快照的 external store ----------------
//
// 为什么是 external store 而不是 useState（BLF-1125）：
//   · 页面是**静态预渲染**的（`next build` 输出中 dashboard 等均为 ○ Static），
//     服务端 HTML 里没有、也不可能有用户姓名，首帧只能渲染中性的骨架；
//   · 刷新后内存缓存必然为空，若首帧读不到任何数据，旧实现在渲染时用
//     `|| "当前用户"` 顶上，于是出现「先显示当前用户、再变成真名」的闪烁。
//   · `useSyncExternalStore` 允许在水合后**立即**用客户端快照重渲染
//     （而不是等 `/auth/me` 网络返回），把"未知"的时长压缩到一个 effect 内，
//     且 localStorage 读取同步完成，不会先画一帧假名字。

interface IdentitySnapshot {
  me: Me | null;
  /** 快照绑定的 token；换账号/登出后 token 变化，旧快照自动失效 */
  token: string | null;
}

/** 服务端渲染 / 水合首帧：无用户数据（渲染骨架），与静态 HTML 一致 */
const SERVER_SNAPSHOT: IdentitySnapshot = { me: null, token: null };

/** 当前快照。必须**引用稳定**：useSyncExternalStore 靠 `Object.is` 判断是否需要重渲染。 */
let identitySnapshot: IdentitySnapshot = SERVER_SNAPSHOT;
let snapRaw: string | null | undefined;
let snapToken: string | null | undefined;

const identityListeners = new Set<() => void>();

function emitIdentity(): void {
  identityListeners.forEach((fn) => fn());
}

/**
 * 读取当前身份快照。只在 localStorage 内容或 token 真的变了时才重建对象，
 * 保证同一快照多次调用返回同一引用（否则 useSyncExternalStore 会无限重渲染）。
 */
function getIdentitySnapshot(): IdentitySnapshot {
  let raw: string | null;
  let token: string | null;
  try {
    raw = readIdentityRaw();
    token = getToken();
  } catch {
    // 隐私模式等 Storage 异常：等同于"没有快照"
    raw = null;
    token = null;
  }
  if (raw === snapRaw && token === snapToken) return identitySnapshot;
  snapRaw = raw;
  snapToken = token;
  identitySnapshot = { me: parseIdentitySnapshot<Me>(raw, token), token };
  return identitySnapshot;
}

/** 服务端/水合首帧快照：常量引用，永远不含用户数据 */
function getServerIdentitySnapshot(): IdentitySnapshot {
  return SERVER_SNAPSHOT;
}

function subscribeIdentity(fn: () => void): () => void {
  identityListeners.add(fn);
  // 跨标签页：另一个标签登出后会清掉快照，本页同步跟上
  const onStorage = () => {
    snapRaw = undefined;
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    identityListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

let meCache: Me | null = null;
let meInflight: Promise<Me> | null = null;

/**
 * 当前用户：仅用于身份展示（姓名/角色名），权限判定请用 useMenus。
 *
 * 缓存分两层：
 *   · 内存 `meCache` —— 同一会话内的跨组件复用；
 *   · localStorage 身份快照 —— 跨刷新的首帧数据源（见 `lib/identityCore`）。
 */
export function loadMe(): Promise<Me> {
  if (meCache) return Promise.resolve(meCache);
  if (!meInflight) {
    meInflight = authApi
      .me()
      .then((m) => {
        meCache = m;
        const token = getToken();
        // 快照与 token 绑定：换账号（token 变）后旧快照自动失效，不会显示错人
        if (token) writeIdentityCache(m, token);
        emitIdentity();
        return m;
      })
      .finally(() => {
        meInflight = null;
      });
  }
  return meInflight;
}

export interface MeState {
  me: Me | null;
  roles: string[];
  roleNames: string[];
  /** 已确认的展示名（`real_name` → `username`）；未确认/无快照时为空串 */
  displayName: string;
  /** 身份接口失败且无可展示的快照：UI 应如实告知，而不是永远转骨架 */
  error: string;
}

export function useMe(): MeState {
  const snapshot = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getServerIdentitySnapshot,
  );
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    loadMe().catch((e) => {
      // 有快照时静默（旧数据仍可展示）；完全没有身份数据才如实报错
      if (!alive || getIdentitySnapshot().me) return;
      setError(errText(e));
    });
    return () => {
      alive = false;
    };
  }, []);

  const me = snapshot.me;
  return {
    me,
    roles: me?.roles.map((r) => r.code) ?? [],
    roleNames: me?.roles.map((r) => r.name) ?? [],
    displayName: me?.real_name || me?.username || "",
    error,
  };
}

// ---------------- 权限单一入口：/meta/me/menus ----------------

let menusCache: MenuResp | null = null;
let menusInflight: Promise<MenuResp> | null = null;

/** 可见菜单 + 管理/审批资格（全局缓存，登录会话内只请求一次） */
export function loadMenus(): Promise<MenuResp> {
  if (menusCache) return Promise.resolve(menusCache);
  if (!menusInflight) {
    menusInflight = metaApi
      .menus()
      .then((m) => {
        menusCache = m;
        return m;
      })
      .finally(() => {
        menusInflight = null;
      });
  }
  return menusInflight;
}

/** 退出登录时清空缓存，避免换账号后残留上一用户的菜单与权限 */
export function clearMetaCache() {
  cache = null;
  inflight = null;
  meCache = null;
  meInflight = null;
  menusCache = null;
  menusInflight = null;
  // 身份快照同样要从内存失效，否则换账号后首帧会闪上一个人的名字
  snapRaw = undefined;
  snapToken = undefined;
  identitySnapshot = SERVER_SNAPSHOT;
  emitIdentity();
}

export interface MenuState {
  /** 后端返回的可见菜单（不含恒可见的工作台） */
  menus: { key: string; label: string; href: string }[];
  roles: string[];
  isSuperAdmin: boolean;
  /** @deprecated 兼容旧消费者，语义等同 isSuperAdmin。 */
  isAdmin: boolean;
  /**
   * 权限是否**已确认**（`/meta/me/menus` 成功返回）。
   *
   * `isSuperAdmin` 在 loading 期间恒为 false（避免未确认就放行管理入口），
   * 但 false 同时意味着「确认过、确实不是管理员」与「还没问到」，两者在纯身份展示上
   * 不可混同：先渲染「普通用户」再改成「管理员」会是一次可见的错误值闪烁。
   * 需要区分时用本字段（如侧栏/顶栏身份区渲染骨架）。
   */
  ready: boolean;
  /** 与列表行内 can_decide / 决策接口同一判定 */
  canApprove: boolean;
  canFinance: boolean;
  /**
   * 当前用户是否拥有某功能模块（Stage 5：页面可见性按用户手动分配）。
   * 判定来源就是后端返回的可见菜单 key，与接口门禁同源，不新增角色判断。
   */
  hasModule: (key: string) => boolean;
  /** 演示数据开关是否打开（决定列表是否包含演示数据） */
  demoOn: boolean;
  /** 当前用户是否可切换演示开关（仅管理员） */
  canToggleDemo: boolean;
  loading: boolean;
  error: string;
  reload: () => void;
}

/**
 * 权限 hook：所有导航与管理/审批按钮的显示条件都取这里。
 * · loading 期间 isSuperAdmin/canApprove 均为 false —— 未确认权限前不展示管理入口；
 * · error 时页面应展示可重试的加载失败，而不是“无权限”。
 */
export function useMenus(): MenuState {
  const [data, setData] = useState<MenuResp | null>(menusCache);
  const [loading, setLoading] = useState(!menusCache);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    // 已有缓存（同一会话内其他组件先拉到）时不再闪一次骨架；reload() 会清缓存后进入 loading
    if (!menusCache) setLoading(true);
    setError("");
    loadMenus()
      .then((m) => {
        if (alive) setData(m);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  const reload = useCallback(() => {
    menusCache = null;
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  return {
    menus: data?.menus ?? [],
    roles: data?.roles ?? [],
    isSuperAdmin: Boolean(data?.is_super_admin),
    isAdmin: Boolean(data?.is_super_admin),
    ready: data !== null && !error,
    canApprove: !!data?.can_approve,
    canFinance: !!data?.can_finance,
    hasModule: (key: string) => (data?.menus ?? []).some((m) => m.key === key),
    demoOn: !!data?.demo_on,
    canToggleDemo: !!data?.can_toggle_demo,
    loading,
    error,
    reload,
  };
}

export function useMeta() {
  const [meta, setMeta] = useState<Meta>(cache ?? { users: [], depts: [] });
  useEffect(() => {
    let alive = true;
    loadMeta()
      .then((m) => alive && setMeta(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const userName = (id?: number | null) => {
    if (id == null) return "-";
    return meta.users.find((u) => u.id === id)?.real_name ?? `用户#${id}`;
  };
  const deptName = (id?: number | null) => {
    if (id == null) return "-";
    return meta.depts.find((d) => d.id === id)?.name ?? `部门#${id}`;
  };

  return { users: meta.users, depts: meta.depts, userName, deptName };
}
