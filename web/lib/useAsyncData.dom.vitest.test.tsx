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

describe("useAsyncData 生命周期", () => {
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
