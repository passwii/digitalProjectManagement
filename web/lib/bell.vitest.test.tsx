// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    notificationsApi: {
      ...actual.notificationsApi,
      count: mocks.count,
      list: mocks.list,
    },
  };
});

vi.mock("@/lib/useMeta", () => ({
  useMenus: () => ({ isAdmin: false }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ info: vi.fn(), err: vi.fn(), ok: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import Bell from "../components/ui/Bell";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.count.mockReset();
  mocks.list.mockReset();
  mocks.count.mockImplementation(() => new Promise(() => {}));
  mocks.list.mockResolvedValue({ total: 0, unread: 0, page: 1, size: 12, items: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Bell 读取生命周期", () => {
  it("未读数请求仍 pending 时，定时器不会创建第二个并发读取", async () => {
    render(<Bell />);
    await act(async () => {});
    expect(mocks.count).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it("关闭通知面板会 abort 在途列表读取", async () => {
    let listSignal: AbortSignal | undefined;
    mocks.list.mockImplementation((_query: string, signal: AbortSignal) => {
      listSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("读取已取消");
          error.name = "AbortError";
          reject(error);
        });
      });
    });

    render(<Bell />);
    await act(async () => {});
    const trigger = screen.getByRole("button", { name: "通知，无未读" });
    fireEvent.click(trigger);
    await act(async () => {});
    expect(mocks.list).toHaveBeenCalledWith("?size=12", expect.any(AbortSignal));

    fireEvent.click(trigger);
    expect(listSignal?.aborted).toBe(true);
  });
});
