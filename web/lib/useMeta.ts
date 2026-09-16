"use client";
// 元数据（用户/部门）全局缓存 + hook，供各页做 id→名称映射
import { useEffect, useState } from "react";
import { metaApi, authApi, type Dept, type Me, type UserOption } from "./api";

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

/** 当前用户（全局缓存），用于按钮级权限：roles.includes("admin") */
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
    isAdmin: codes.includes("admin"),
    isCostAdmin: codes.includes("cost_admin"),
    isExec: codes.includes("executive"),
    displayName: me?.real_name || me?.username || "",
  };
}

export function useMeta() {  const [meta, setMeta] = useState<Meta>(cache ?? { users: [], depts: [] });
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
