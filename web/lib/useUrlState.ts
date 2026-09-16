"use client";
/**
 * URL 查询参数 = 筛选 / 分页 / 当前项目 / 视图模式的单一数据源（BLF-1095）。
 *
 * 读取：状态直接来自 useSearchParams，组件不额外维护一份副本。
 * 写入：router.replace（默认，连续变化不污染历史）/ router.push（离散动作，可后退）。
 * 因此刷新、复制链接、浏览器前进后退都会回到同一视图。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type UrlPatch = Record<string, string | number | null | undefined>;

export interface UrlStateOptions {
  /** 写入方式：replace 默认；离散动作（切页签、切视图、选项目）用 push 以便后退 */
  history?: "replace" | "push";
  /** 分页键名：任何未显式包含该键的更新都会把它重置为默认值（回到第一页）。
   *  设为 false 关闭该统一边界行为。 */
  pageKey?: string | false;
}

export type UpdateUrl = (patch: UrlPatch, opts?: UrlStateOptions) => void;

/**
 * @param defaults 默认值（默认值不写入 URL，链接保持简洁）
 * @param options  history / pageKey
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
  options: UrlStateOptions = {},
) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // 默认值只取首次渲染，避免调用方每次渲染新建对象导致引用抖动
  const defaultsRef = useRef(defaults);
  const keysRef = useRef(Object.keys(defaults));
  const optsRef = useRef(options);
  optsRef.current = options;

  const state = useMemo(() => {
    const out: Record<string, string> = { ...defaultsRef.current };
    for (const key of keysRef.current) {
      const v = sp.get(key);
      if (v !== null && v !== "") out[key] = v;
    }
    return out as T;
  }, [sp]);

  const update = useCallback<UpdateUrl>(
    (patch, opts) => {
      const base = defaultsRef.current as Record<string, string>;
      const pageKey = (opts?.pageKey ?? optsRef.current.pageKey) || false;
      const next: UrlPatch = { ...patch };
      if (pageKey && !(pageKey in next)) next[pageKey] = base[pageKey] ?? "1";

      const params = new URLSearchParams(sp.toString());
      for (const [key, value] of Object.entries(next)) {
        const isDefault = value === undefined || value === null || value === "" || String(value) === base[key];
        if (isDefault) params.delete(key);
        else params.set(key, String(value));
      }
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      const history = opts?.history ?? optsRef.current.history ?? "replace";
      if (history === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [pathname, router, sp],
  );

  return [state, update] as const;
}

/**
 * 文本输入的 URL 同步：输入即时回显（本地 draft），停止输入后延迟写入 URL。
 * URL 被外部改变（刷新 / 后退 / 粘贴链接）时，draft 会重新对齐 URL。
 */
export function useUrlText(value: string, commit: (next: string) => void, delay = 300) {
  const [draft, setDraft] = useState(value);
  const committedRef = useRef(value);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (value !== committedRef.current) {
      committedRef.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => {
      committedRef.current = draft;
      commitRef.current(draft);
    }, delay);
    return () => clearTimeout(timer);
  }, [draft, value, delay]);

  return [draft, setDraft] as const;
}

/** 解析 URL 中的正整数（越界时回退默认值） */
export function urlInt(value: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}
