"use client";
/**
 * 列表/详情异步数据：统一处理加载态、错误重试、以及「取消过期请求」。
 *
 * - 每次依赖变化都会 abort 上一个请求，并用序号丢弃迟到的响应，
 *   避免快速切换筛选项/项目时旧响应覆盖新状态（BLF-1095）。
 * - resetOnDepChange=true：筛选条件或当前项目变化时立即清空旧数据，
 *   骨架屏期间不会展示上一个筛选/项目的错误数据（reload() 不受影响）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "./api";
import { useActivity } from "./useActivity";

export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException) return e.name === "AbortError";
  return (e as { name?: string } | null)?.name === "AbortError";
}

export interface AsyncData<T> {
  data: T | null;
  /** 是否有请求在飞行中（取消/过期请求不计入） */
  loading: boolean;
  /** 首次加载：还没有任何可展示数据 → 显示骨架屏 */
  firstLoad: boolean;
  error: string;
  reload: () => void;
  setData: (next: T | null) => void;
}

export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  {
    enabled = true,
    resetOnDepChange = false,
  }: { enabled?: boolean; resetOnDepChange?: boolean } = {},
): AsyncData<T> {
  const { beginActivity } = useActivity();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const seqRef = useRef(0);
  const lastDepRef = useRef<string | null>(null);
  const resetRef = useRef(resetOnDepChange);
  resetRef.current = resetOnDepChange;

  const depKey = JSON.stringify(deps);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError("");
      lastDepRef.current = depKey;
      return;
    }
    // 依赖变化（非手动 reload）时清空旧数据，骨架期间不展示上一份筛选结果
    if (resetRef.current && lastDepRef.current !== depKey) {
      lastDepRef.current = depKey;
      setData(null);
    }
    const id = ++seqRef.current;
    const ac = new AbortController();
    const finishActivity = beginActivity({
      label: "更新中",
      scope: "content",
    });
    let finished = false;
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      finishActivity();
    };
    setLoading(true);
    setError("");

    loaderRef.current(ac.signal)
      .then((value) => {
        if (seqRef.current !== id) return; // 过期响应：丢弃
        setData(value);
      })
      .catch((e) => {
        if (isAbortError(e) || seqRef.current !== id) return; // 主动取消 / 过期：静默
        setError(errText(e));
        setData(null);
      })
      .finally(() => {
        if (seqRef.current === id) setLoading(false);
        finishOnce();
      });

    return () => {
      ac.abort();
      finishOnce();
    };
  }, [beginActivity, enabled, tick, depKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setDataDirect = useCallback((next: T | null) => setData(next), []);

  return { data, loading, firstLoad: loading && data === null, error, reload, setData: setDataDirect };
}
