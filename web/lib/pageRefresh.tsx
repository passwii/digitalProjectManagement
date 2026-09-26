"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

type RefreshHandler = (signal: AbortSignal) => Promise<unknown>;
const REFRESH_TIMEOUT_MS = 10_000;

interface PageRefreshContextValue {
  register: (handler: RefreshHandler) => () => void;
  refresh: () => Promise<void>;
}

const PageRefreshContext = createContext<PageRefreshContextValue | null>(null);

/** 只收集当前路由子树里的数据加载器；页面本地筛选和编辑状态不会被重挂载。 */
export function PageRefreshProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const handlers = useRef(new Set<RefreshHandler>());

  const register = useCallback((handler: RefreshHandler) => {
    handlers.current.add(handler);
    return () => handlers.current.delete(handler);
  }, []);

  const refresh = useCallback(async () => {
    const current = Array.from(handlers.current);
    if (current.length === 0) {
      router.refresh();
      return;
    }

    const controller = new AbortController();
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        const timeoutError = new Error("刷新超时，请检查网络连接");
        controller.abort(timeoutError);
        reject(timeoutError);
      }, REFRESH_TIMEOUT_MS);
    });
    try {
      // 一项失败就取消其余读取；读取层的自动重试必须被这次刷新显式限时。
      await Promise.race([
        Promise.all(current.map((handler) => Promise.resolve().then(() => handler(controller.signal)))),
        timeout,
      ]);
      router.refresh();
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }, [router]);

  const value = useMemo(() => ({ register, refresh }), [register, refresh]);
  return (
    <PageRefreshContext.Provider value={value}>
      {children}
    </PageRefreshContext.Provider>
  );
}

/** handler 用 ref 保持最新闭包，避免页面每次渲染都重新注册。 */
export function useRegisterPageRefresh(
  handler: RefreshHandler,
  enabled = true,
): void {
  const context = useContext(PageRefreshContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!context || !enabled) return;
    return context.register((signal) => handlerRef.current(signal));
  }, [context, enabled]);
}

export function usePageRefresh(): () => Promise<void> {
  const context = useContext(PageRefreshContext);
  if (!context) throw new Error("PageRefreshProvider 未挂载");
  return context.refresh;
}

/** 将一次刷新自己的取消信号转给页面内已有的请求控制器。 */
export function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const abort = () => target.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export function refreshAbortMessage(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  return reason instanceof Error && reason.message ? reason.message : "刷新已中止";
}
