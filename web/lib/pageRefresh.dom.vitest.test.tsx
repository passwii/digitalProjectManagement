// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { refreshRoute } = vi.hoisted(() => ({ refreshRoute: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshRoute }) }));

import { PageRefreshProvider, usePageRefresh, useRegisterPageRefresh } from "./pageRefresh";
import { useAsyncData } from "./useAsyncData";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe({ loader }: { loader: (signal: AbortSignal) => Promise<number> }) {
  const [filter, setFilter] = useState("全部");
  const [refreshError, setRefreshError] = useState("");
  const { data, error, loading } = useAsyncData(loader, []);
  const refresh = usePageRefresh();
  return (
    <>
      <span data-testid="data">{data ?? "加载中"}</span>
      <span data-testid="filter">{filter}</span>
      <span data-testid="refresh-error">{refreshError}</span>
      <span data-testid="hook-error">{error}</span>
      <span data-testid="loading">{String(loading)}</span>
      <button onClick={() => setFilter("进行中")}>切筛选</button>
      <button onClick={() => void refresh().catch((e) => setRefreshError(e.message))}>下拉刷新</button>
    </>
  );
}

function StalledProbe() {
  const [message, setMessage] = useState("");
  const refresh = usePageRefresh();
  useRegisterPageRefresh(() => new Promise(() => {}));
  return (
    <>
      <button onClick={() => void refresh().catch((e) => setMessage(e.message))}>刷新</button>
      <span data-testid="timeout-message">{message}</span>
    </>
  );
}

describe("页面下拉刷新协调", () => {
  it("重新请求客户端数据并保留页面本地状态", async () => {
    refreshRoute.mockClear();
    let count = 0;
    const loader = vi.fn(async () => ++count);
    render(<PageRefreshProvider><Probe loader={loader} /></PageRefreshProvider>);
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("1"));
    fireEvent.click(screen.getByText("切筛选"));
    fireEvent.click(screen.getByText("下拉刷新"));
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("2"));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("filter").textContent).toBe("进行中");
    expect(refreshRoute).toHaveBeenCalledTimes(1);
  });

  it("当前页请求失败时把错误交给刷新指示器", async () => {
    refreshRoute.mockClear();
    let count = 0;
    const loader = vi.fn(async () => {
      count += 1;
      if (count === 2) throw new Error("网络暂不可用");
      return count;
    });
    render(<PageRefreshProvider><Probe loader={loader} /></PageRefreshProvider>);
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("1"));
    fireEvent.click(screen.getByText("下拉刷新"));
    await waitFor(() => expect(screen.getByTestId("refresh-error").textContent).toBe("网络暂不可用"));
    expect(refreshRoute).not.toHaveBeenCalled();
  });

  it("持续重试的请求在 10 秒后中止并提示重试", async () => {
    vi.useFakeTimers();
    render(<PageRefreshProvider><StalledProbe /></PageRefreshProvider>);
    fireEvent.click(screen.getByText("刷新"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByTestId("timeout-message").textContent).toBe("刷新超时，请检查网络连接");
  });

  it("超时取消后页面加载态结束并显示错误", async () => {
    let count = 0;
    const loader = vi.fn((signal: AbortSignal): Promise<number> => {
      count += 1;
      if (count === 1) return Promise.resolve(1);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("取消", "AbortError")), { once: true });
      });
    });
    render(<PageRefreshProvider><Probe loader={loader} /></PageRefreshProvider>);
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("1"));
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("下拉刷新"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("hook-error").textContent).toBe("刷新超时，请检查网络连接");
  });
});
