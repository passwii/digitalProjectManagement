"use client";
// 元数据（用户/部门）全局缓存 + hook，供各页做 id→名称映射。
// 权限单一入口：`/meta/me/menus`（useMenus）返回可见菜单与 is_admin / can_approve，
// 页面不再各自硬编码角色判断（Stage 1 契约：管理员是唯一管理与审批角色）。
import { useCallback, useEffect, useState } from "react";
import { errText, metaApi, authApi, type Dept, type Me, type MenuResp, type UserOption } from "./api";

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

let meCache: Me | null = null;
let meInflight: Promise<Me> | null = null;

/** 当前用户（全局缓存）：仅用于身份展示（姓名/角色名），权限判定请用 useMenus */
export function loadMe(): Promise<Me> {
  if (meCache) return Promise.resolve(meCache);
  if (!meInflight) {
    meInflight = authApi
      .me()
      .then((m) => {
        meCache = m;
        return m;
      })
      .finally(() => {
        meInflight = null;
      });
  }
  return meInflight;
}

export function useMe() {
  const [me, setMe] = useState<Me | null>(meCache);
  useEffect(() => {
    let alive = true;
    loadMe()
      .then((m) => alive && setMe(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const codes = me?.roles.map((r) => r.code) ?? [];
  return {
    me,
    roles: codes,
    roleNames: me?.roles.map((r) => r.name) ?? [],
    displayName: me?.real_name || me?.username || "",
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
}

export interface MenuState {
  /** 后端返回的可见菜单（不含恒可见的工作台） */
  menus: { key: string; label: string; href: string }[];
  roles: string[];
  isAdmin: boolean;
  /** 与列表行内 can_decide / 决策接口同一判定 */
  canApprove: boolean;
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
 * · loading 期间 isAdmin/canApprove 均为 false —— 未确认权限前不展示管理入口；
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
    isAdmin: !!data?.is_admin,
    canApprove: !!data?.can_approve,
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
