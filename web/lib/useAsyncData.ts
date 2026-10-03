"use client";
/**
 * 列表/详情异步数据：统一处理加载态、错误重试、以及「取消过期请求」。
 *
 * - 每次依赖变化都会 abort 上一个请求，并用序号丢弃迟到的响应，
 *   避免快速切换筛选项/项目时旧响应覆盖新状态（BLF-1095）。
 * - resetOnDepChange=true：筛选条件或当前项目变化时立即清空旧数据，
 *   骨架屏期间不会展示上一个筛选/项目的错误数据（reload() 不受影响）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errText, getToken } from "./api";
import {
  cacheIdentity,
  deleteAsyncDataCache,
  getAsyncDataCacheSnapshot,
  subscribeAsyncDataCache,
  writeAsyncDataCache,
} from "./asyncDataCache";
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
    cacheKey,
    cacheMaxAgeMs = 5 * 60_000,
  }: { enabled?: boolean; resetOnDepChange?: boolean; cacheKey?: string; cacheMaxAgeMs?: number } = {},
): AsyncData<T> {
  const { beginActivity } = useActivity();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const depKey = JSON.stringify(deps);
  const token = cacheKey ? getToken() : null;
  const isCacheable = Boolean(cacheKey) && token !== null;
  const cache = cacheKey ? cacheIdentity(cacheKey, depKey) : null;
  const storageKey = cache?.key;
  const storageDepsKey = cache?.depsKey ?? depKey;
  const subscribeCache = useCallback(
    (listener: () => void) => storageKey && token ? subscribeAsyncDataCache(storageKey, listener) : () => {},
    [storageKey, token],
  );
  const readCacheSnapshot = useCallback(
    () => storageKey && token
      ? getAsyncDataCacheSnapshot<T>(storageKey, storageDepsKey, token, cacheMaxAgeMs)
      : null,
    [storageKey, storageDepsKey, token, cacheMaxAgeMs],
  );
  const cacheSnapshot = useSyncExternalStore(subscribeCache, readCacheSnapshot, () => null);
  const cacheValue = cacheSnapshot?.data;
  const cacheValueRef = useRef(cacheValue);
  cacheValueRef.current = cacheValue;
  const depKeyRef = useRef(depKey);
  depKeyRef.current = depKey;
  const cacheSnapshotRef = useRef(cacheSnapshot);
  cacheSnapshotRef.current = cacheSnapshot;
  const enabledRef = useRef(enabled);
  const resetOnDepChangeRef = useRef(resetOnDepChange);
  const cacheKeyRef = useRef(cacheKey);
  enabledRef.current = enabled;
  resetOnDepChangeRef.current = resetOnDepChange;
  cacheKeyRef.current = cacheKey;
  const currentDataScope = isCacheable ? `${storageKey}\u0000${token}` : "";
  const [data, setData] = useState<T | null>(() => cacheSnapshotRef.current?.data ?? null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const dataScopeRef = useRef(currentDataScope);
  const depsKeyRef = useRef(depKey);
  depsKeyRef.current = depKey;
  const [loading, setLoading] = useState(enabled && data === null);
  const [error, setError] = useState("");

  const seqRef = useRef(0);
  const lastDepRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const finishRef = useRef<(() => void) | null>(null);

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
    ++seqRef.current;
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
    const hasCurrentData =
      (dataScopeRef.current === currentDataScope && depsKeyRef.current === depKey && dataRef.current !== null) ||
      (cacheKey !== undefined && cacheValueRef.current !== undefined);
    setLoading(isCacheable ? !hasCurrentData : true);
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
      dataScopeRef.current = currentDataScope;
      depsKeyRef.current = depKey;
      dataRef.current = value;
      setData(value);
      if (storageKey) writeAsyncDataCache(storageKey, storageDepsKey, token, value);
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
      const candidate = e as { name?: unknown; status?: unknown } | null;
      const canKeepSnapshot =
        candidate?.name === "NetworkError" ||
        (typeof candidate?.status === "number" &&
          ([408, 425, 429].includes(candidate.status) || (candidate.status >= 500 && candidate.status <= 599)));
      const hasCurrentData =
        (dataScopeRef.current === currentDataScope && depsKeyRef.current === depKey && dataRef.current !== null) ||
        (cacheKey !== undefined && cacheValueRef.current !== undefined);
      if (!isCacheable || !canKeepSnapshot || !hasCurrentData) {
        dataScopeRef.current = currentDataScope;
        dataRef.current = null;
        setData(null);
      }
      if (storageKey && (!canKeepSnapshot || !hasCurrentData)) deleteAsyncDataCache(storageKey);
      setLoading(false);
      throw new Error(message);
    } finally {
      detach();
      detachControllerAbort();
      finishOnce();
      if (finishRef.current === finishOnce) finishRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [beginActivity, cacheKey, currentDataScope, depKey, enabled, isCacheable, storageDepsKey, storageKey, token]);

  useEffect(() => {
    if (!enabledRef.current) {
      cancelCurrent();
      setLoading(false);
      setError("");
      lastDepRef.current = depKey;
      return;
    }
    // Restore a matching local snapshot before starting the request. A missing,
    // expired, oversized, or unreadable entry transparently falls back to network.
    const depsChanged = lastDepRef.current !== depKey;
    let restored = false;
    if (storageKey && token && depsChanged) {
      const cached = getAsyncDataCacheSnapshot<T>(storageKey, storageDepsKey, token, cacheMaxAgeMs);
      if (cached) {
        dataScopeRef.current = currentDataScope;
        depsKeyRef.current = depKey;
        dataRef.current = cached.data;
        setData(cached.data);
        setLoading(false);
        restored = true;
      }
    }
    // Only dependency changes clear old data when this caller asks for that behavior.
    if (resetOnDepChangeRef.current && depsChanged && !restored) {
      dataScopeRef.current = currentDataScope;
      dataRef.current = null;
      setData(null);
      setLoading(true);
    } else if (!isCacheable && resetOnDepChangeRef.current && depsChanged) {
      setData(null);
      setLoading(true);
    }
    lastDepRef.current = depKey;
    void run().catch(() => {});
    return cancelCurrent;
  }, [depKey, run, cancelCurrent, storageKey, storageDepsKey, cacheMaxAgeMs, token, currentDataScope, isCacheable]);

  useRegisterPageRefresh(run, enabled);

  const reload = useCallback(() => {
    void run().catch(() => {});
  }, [run]);
  const setDataDirect = useCallback((next: T | null) => {
    dataScopeRef.current = currentDataScope;
    depsKeyRef.current = depKey;
    dataRef.current = next;
    setData(next);
    if (!storageKey || !token) return;
    if (next === null) deleteAsyncDataCache(storageKey);
    else writeAsyncDataCache(storageKey, storageDepsKey, token, next);
  }, [currentDataScope, depKey, storageKey, storageDepsKey, token]);

  const dataScopeChanged = isCacheable && dataScopeRef.current !== currentDataScope;
  const scopedData = !isCacheable || !dataScopeChanged ? data : null;
  const visibleData = scopedData ?? (cacheValue as T | undefined) ?? null;
  const visibleLoading = loading || (enabled && dataScopeChanged && cacheValue === undefined);
  return {
    data: visibleData,
    loading: visibleLoading,
    firstLoad: visibleLoading && visibleData === null,
    error,
    reload,
    setData: setDataDirect,
  };
}
