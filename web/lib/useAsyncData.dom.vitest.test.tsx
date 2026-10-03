// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, NetworkError } from "./api";
import { cacheIdentity, deleteAsyncDataCache, writeAsyncDataCache } from "./asyncDataCache";

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() { return values.size; },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
    },
  });
}
import { useAsyncData } from "./useAsyncData";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useAsyncData 生命周期", () => {
  it("成功读取后不会因缓存写入或重新渲染重复请求", async () => {
    installLocalStorage();
    localStorage.setItem("pm_access_token", "session-a");
    const loader = vi.fn(async () => ({ value: 1 }));
    const { result } = renderHook(() => useAsyncData(loader, [], { cacheKey: "stable-success" }));

    await act(async () => {});
    expect(result.current.data).toEqual({ value: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    localStorage.removeItem("pm_access_token");
  });

  it("不再为直接网络错误创建重复 retry 定时器", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => {
      throw new NetworkError("断联");
    });
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    expect(result.current.error).toContain("无法连接后端");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("已有数据刷新时，读取 promise 未完成也保留旧数据", async () => {
    let resolveNext!: (value: string) => void;
    let next = false;
    const loader = vi.fn(async () => {
      if (!next) return "old";
      return new Promise<string>((resolve) => {
        resolveNext = resolve;
      });
    });
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    expect(result.current.data).toBe("old");
    next = true;
    act(() => result.current.reload());
    await act(async () => {});
    expect(result.current.data).toBe("old");
    expect(result.current.error).toBe("");
    act(() => resolveNext("new"));
    await act(async () => {});
    expect(result.current.data).toBe("new");
  });

  it("不可恢复错误直接结束并清空数据", async () => {
    const loader = vi.fn(async () => {
      throw new HttpError(400, "参数错误");
    });
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    expect(result.current.error).toContain("参数错误");
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("依赖变化会丢弃迟到的旧响应", async () => {
    const pending: Array<(value: string) => void> = [];
    const loader = vi.fn(
      () => new Promise<string>((resolve) => {
        pending.push(resolve);
      }),
    );
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: number }) => useAsyncData(loader, [projectId]),
      { initialProps: { projectId: 1 } },
    );

    await act(async () => {});
    rerender({ projectId: 2 });
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(2);
    act(() => pending[0]("old"));
    await act(async () => {});
    expect(result.current.data).toBeNull();
    act(() => pending[1]("new"));
    await act(async () => {});
    expect(result.current.data).toBe("new");
  });

  it("卸载时会 abort 在途读取并保持静默", async () => {
    let aborted = false;
    const loader = vi.fn(
      (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("读取已取消");
          error.name = "AbortError";
          reject(error);
        });
      }),
    );
    const { unmount } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    unmount();
    expect(aborted).toBe(true);
  });

  it("本地命中时首帧显示快照但保持后台刷新", async () => {
    installLocalStorage();
    const key = "cached-project-list";
    const deps = JSON.stringify([1]);
    const cache = cacheIdentity(key, deps);
    localStorage.setItem("pm_access_token", "session-a");
    writeAsyncDataCache(cache.key, cache.depsKey, "session-a", { items: ["cached"] });
    let resolveNetwork!: (value: { items: string[] }) => void;
    const loader = vi.fn(() => new Promise<{ items: string[] }>((resolve) => { resolveNetwork = resolve; }));
    const { result } = renderHook(() => useAsyncData(loader, [1], { cacheKey: key, resetOnDepChange: true }));

    expect(result.current.data).toEqual({ items: ["cached"] });
    expect(result.current.firstLoad).toBe(false);
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    act(() => resolveNetwork({ items: ["fresh"] }));
    await act(async () => {});
    expect(result.current.data).toEqual({ items: ["fresh"] });
    expect(result.current.loading).toBe(false);
    expect(localStorage.getItem(`pm_async_data_v1:${encodeURIComponent(cache.key)}`)).not.toBeNull();
    deleteAsyncDataCache(cache.key);
    localStorage.removeItem("pm_access_token");
  });

  it("依赖变化切换时同步恢复命中的本地快照，避免先清空再等待", async () => {
    installLocalStorage();
    const key = "cached-project-scope";
    localStorage.setItem("pm_access_token", "session-a");
    const cache = cacheIdentity(key, JSON.stringify([2]));
    writeAsyncDataCache(cache.key, cache.depsKey, "session-a", { total: 8 });
    let resolveNetwork!: (value: { total: number }) => void;
    const loader = vi.fn(() => new Promise<{ total: number }>((resolve) => { resolveNetwork = resolve; }));
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: number }) => useAsyncData(loader, [projectId], { cacheKey: key, resetOnDepChange: true }),
      { initialProps: { projectId: 1 } },
    );
    await act(async () => {});
    rerender({ projectId: 2 });
    expect(result.current.data).toEqual({ total: 8 });
    expect(result.current.firstLoad).toBe(false);
    await act(async () => {});
    expect(result.current.data).toEqual({ total: 8 });
    act(() => resolveNetwork({ total: 9 }));
    await act(async () => {});
    expect(result.current.data).toEqual({ total: 9 });
    deleteAsyncDataCache(cache.key);
    localStorage.removeItem("pm_access_token");
  });

  it("账号或会话切换时不短暂展示旧会话的本地数据", async () => {
    installLocalStorage();
    const key = "session-scoped-list";
    localStorage.setItem("pm_access_token", "session-a");
    const cache = cacheIdentity(key, JSON.stringify([]));
    writeAsyncDataCache(cache.key, cache.depsKey, "session-a", { items: ["session-a"] });
    const loader = vi.fn(() => new Promise<{ items: string[] }>(() => {}));
    const { result, rerender } = renderHook(
      ({ activeToken }: { activeToken: string }) => useAsyncData(loader, [], { cacheKey: key }),
      { initialProps: { activeToken: "session-a" } },
    );
    expect(result.current.data).toEqual({ items: ["session-a"] });
    localStorage.setItem("pm_access_token", "session-b");
    act(() => window.dispatchEvent(new Event("pm:session-changed")));
    rerender({ activeToken: "session-b" });
    expect(result.current.data).toBeNull();
    expect(result.current.firstLoad).toBe(true);
    deleteAsyncDataCache(cache.key);
    localStorage.removeItem("pm_access_token");
  });

  it("首次读取未完成时保留骨架 loading，成功后结束 loading", async () => {
    let resolveRead!: (value: string) => void;
    const loader = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    expect(result.current.loading).toBe(true);
    expect(result.current.firstLoad).toBe(true);
    act(() => resolveRead("ready"));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.firstLoad).toBe(false);
    expect(result.current.data).toBe("ready");
  });
});
