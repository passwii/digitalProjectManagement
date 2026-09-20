// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, NetworkError } from "./api";
import { useAsyncData } from "./useAsyncData";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useAsyncData 后台读取恢复", () => {
  it("网络失败后静默 retry，并在恢复时更新数据", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new NetworkError("断联");
      return "ready";
    });
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    expect(result.current.error).toBe("");
    expect(result.current.data).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("ready");
    expect(result.current.loading).toBe(false);
  });

  it("已有数据遇到网络失败时保留旧数据", async () => {
    vi.useFakeTimers();
    let mode: "ok" | "down" = "ok";
    const loader = vi.fn(async () => {
      if (mode === "down") throw new NetworkError("断联");
      return "latest";
    });
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    expect(result.current.data).toBe("latest");
    mode = "down";
    act(() => result.current.reload());
    await act(async () => {});
    expect(result.current.data).toBe("latest");
    expect(result.current.error).toBe("");
  });

  it("不可恢复错误不进入无限 retry", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => { throw new HttpError(400, "参数错误"); });
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    expect(result.current.error).toContain("参数错误");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("卸载后不会执行等待中的 retry", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => { throw new NetworkError("断联"); });
    const { unmount } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("online 事件会取消退避并立即恢复读取", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new NetworkError("断联");
      return "online-ready";
    });
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("online-ready");
  });

  it("页面回到前台时会立即恢复读取", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new NetworkError("断联");
      return "visible-ready";
    });
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("visible-ready");
  });

  it("多个恢复事件不会创建并发读取请求", async () => {
    vi.useFakeTimers();
    let resolveRequest: ((value: string) => void) | undefined;
    const loader = vi.fn(() => new Promise<string>((resolve) => {
      resolveRequest = resolve;
    }));
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRequest?.("ready");
    });
    expect(result.current.data).toBe("ready");
  });

  it("成功后 focus 不会无条件重复读取", async () => {
    const loader = vi.fn(async () => "ready");
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe("ready");
  });
});
