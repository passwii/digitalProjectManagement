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
import { linkAbortSignal, refreshAbortMessage, useRegisterPageRefresh } from "./pageRefresh";

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

  const seqRef = useRef(0);
  const lastDepRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const finishRef = useRef<(() => void) | null>(null);

  const depKey = JSON.stringify(deps);

  const cancelCurrent = useCallback(() => {
    ++seqRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    finishRef.current?.();
    finishRef.current = null;
  }, []);

  /** 同一条请求通道供依赖变化、手动重试和页面下拉刷新使用。 */
  const run = useCallback(async (externalSignal?: AbortSignal): Promise<void> => {
    if (!enabled) return;
    controllerRef.current?.abort();
    finishRef.current?.();
    const id = ++seqRef.current;
    const finishActivity = beginActivity({
      label: "更新中",
      scope: "content",
    });
    let finishedActivity = false;
    const finishOnce = () => {
      if (finishedActivity) return;
      finishedActivity = true;
      finishActivity();
    };
    finishRef.current = finishOnce;
    setLoading(true);
    setError("");

    const controller = new AbortController();
    controllerRef.current = controller;
    const detach = linkAbortSignal(externalSignal, controller);
    let detachControllerAbort = () => {};
    try {
      if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
      const request = loaderRef.current(controller.signal);
      const cancelled = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new DOMException("请求已取消", "AbortError"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        detachControllerAbort = () => controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) onAbort();
      });
      const value = await Promise.race([request, cancelled]);
      if (controller.signal.aborted || seqRef.current !== id) return;
      setData(value);
      setError("");
      setLoading(false);
    } catch (e) {
      if (seqRef.current !== id) return;
      if (controller.signal.aborted || isAbortError(e)) {
        const aborted = refreshAbortMessage(externalSignal);
        if (aborted) setError(aborted);
        setLoading(false);
        return;
      }
      const message = errText(e);
      setError(message);
      setData(null);
      setLoading(false);
      throw new Error(message);
    } finally {
      detach();
      detachControllerAbort();
      finishOnce();
      if (finishRef.current === finishOnce) finishRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [beginActivity, enabled]);

  useEffect(() => {
    if (!enabled) {
      cancelCurrent();
      setLoading(false);
      setError("");
      lastDepRef.current = depKey;
      return;
    }
    // 只有依赖切换清空旧数据；手动刷新保留页面筛选和当前视图。
    if (resetOnDepChange && lastDepRef.current !== depKey) setData(null);
    lastDepRef.current = depKey;
    void run().catch(() => {});
    return cancelCurrent;
  }, [enabled, depKey, resetOnDepChange, run, cancelCurrent]);

  useRegisterPageRefresh(run, enabled);

  const reload = useCallback(() => {
    void run().catch(() => {});
  }, [run]);
  const setDataDirect = useCallback((next: T | null) => setData(next), []);

  return { data, loading, firstLoad: loading && data === null, error, reload, setData: setDataDirect };
}
