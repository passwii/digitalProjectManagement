// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReadWithRetry } from "./readClient";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("runReadWithRetry", () => {
  it("连续五次失败后仍按约一秒重试并在恢复时返回", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      if (calls <= 5) throw { name: "NetworkError" };
      return "ready";
    });

    const result = runReadWithRetry(loader);
    await act(async () => {});
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    await expect(result).resolves.toBe("ready");
    expect(loader).toHaveBeenCalledTimes(6);
  });

  it("明确业务错误立即结束，不进入 retry", async () => {
    const loader = vi.fn(async () => {
      throw { status: 404, name: "HttpError" };
    });

    await expect(runReadWithRetry(loader)).rejects.toMatchObject({ status: 404 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("取消等待中的读取后不再发起下一次请求", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const loader = vi.fn(async () => {
      throw { name: "NetworkError" };
    });

    const result = runReadWithRetry(loader, { signal: controller.signal });
    await act(async () => {});
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["online", () => window.dispatchEvent(new Event("online"))],
    ["focus", () => window.dispatchEvent(new Event("focus"))],
    [
      "visibilitychange",
      () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ])("%s 事件会提前唤醒等待中的读取", async (_event, wake) => {
    vi.useFakeTimers();
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { name: "NetworkError" };
      return "ready";
    });

    const result = runReadWithRetry(loader);
    await act(async () => {});
    await act(async () => {
      wake();
    });

    await expect(result).resolves.toBe("ready");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("同一运行器不会因多个恢复事件并发调用 loader", async () => {
    vi.useFakeTimers();
    let resolveSecond: ((value: string) => void) | undefined;
    let calls = 0;
    const loader = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject({ name: "NetworkError" });
      return new Promise<string>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const result = runReadWithRetry(loader);
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(loader).toHaveBeenCalledTimes(2);
    resolveSecond?.("ready");
    await expect(result).resolves.toBe("ready");
  });

  it("429 和 503 的服务端等待值采用但不超过 60 秒", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ name: "HttpError", status: 429, retryAfterMs: 2000 })
      .mockRejectedValueOnce({ name: "HttpError", status: 503, retryAfterMs: 120000 })
      .mockResolvedValue("ready");

    const result = runReadWithRetry(loader, {
      onRetry: ({ delayMs }) => delays.push(delayMs),
    });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59999);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await expect(result).resolves.toBe("ready");
    expect(delays).toEqual([2000, 60000]);
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
