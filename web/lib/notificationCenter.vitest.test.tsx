// @vitest-environment jsdom
/**
 * 通知中心（账号「我的」菜单里的通知区域）。
 *
 * 独立铃铛已移除，但通知能力必须原样保留：
 *   · 未读数轮询的「同一时刻只有一个在途请求」生命周期；
 *   · 关闭 / 卸载时 abort 在途列表读取；
 *   · 点击通知的深链规则（BLF-1093）不因为搬家而退化。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    notificationsApi: {
      ...actual.notificationsApi,
      count: mocks.count,
      list: mocks.list,
      read: mocks.read,
      readAll: mocks.readAll,
    },
  };
});

vi.mock("@/lib/useMeta", () => ({
  useMenus: () => ({ canApprove: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

import {
  NotificationProvider,
  NotificationSection,
  hrefOf,
  useNotificationUnread,
} from "../components/ui/NotificationCenter";
import type { Notification } from "../lib/api";

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    type: "task",
    title: "任务逾期",
    body: "请尽快处理",
    ref_type: "task",
    ref_id: 101,
    project_id: 7,
    read: false,
    created_at: "2026-11-11T10:00:00+08:00",
    ...overrides,
  };
}

function UnreadProbe() {
  const { unread } = useNotificationUnread();
  return <output data-testid="unread">{unread}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.count.mockReset();
  mocks.list.mockReset();
  mocks.read.mockReset();
  mocks.readAll.mockReset();
  mocks.push.mockReset();
  mocks.count.mockImplementation(() => new Promise(() => {}));
  mocks.list.mockResolvedValue({ total: 0, unread: 0, page: 1, size: 12, items: [] });
  mocks.read.mockResolvedValue({ ok: true });
  mocks.readAll.mockResolvedValue({ ok: true, read: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("未读数生命周期", () => {
  it("未读数请求仍 pending 时，定时器不会创建第二个并发读取", async () => {
    render(
      <NotificationProvider>
        <UnreadProbe />
      </NotificationProvider>,
    );
    await act(async () => {});
    expect(mocks.count).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it("列表读取在组件卸载时被 abort", async () => {
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

    const { unmount } = render(
      <NotificationProvider>
        <NotificationSection />
      </NotificationProvider>,
    );
    await act(async () => {});
    expect(mocks.list).toHaveBeenCalledWith("?size=12", expect.any(AbortSignal));

    unmount();
    expect(listSignal?.aborted).toBe(true);
  });
});

describe("通知深链（BLF-1093 规则保持不变）", () => {
  it("任务 / 里程碑落到进度页的定位参数", () => {
    expect(hrefOf(notification(), false)).toBe("/progress?project_id=7&task=101");
    expect(hrefOf(notification({ ref_type: "milestone", ref_id: 3 }), false)).toBe(
      "/progress?project_id=7&milestone=3",
    );
  });

  it("支出：审批人落审批中心，申请人落成本页并高亮该行", () => {
    const expense = notification({ ref_type: "expense", ref_id: 9, type: "expense" });
    expect(hrefOf(expense, true)).toBe("/approvals?expense=9");
    expect(hrefOf(expense, false)).toBe("/costs?project_id=7&expense=9");
  });

  it("预算调整：审批人带 adjust 定位，申请人落成本页", () => {
    const adjust = notification({ ref_type: "budget_adjust", ref_id: 2, type: "budget" });
    expect(hrefOf(adjust, true)).toBe("/approvals?adjust=2");
    expect(hrefOf(adjust, false)).toBe("/costs?project_id=7");
  });

  it("跟进提醒与项目级通知落到对应项目", () => {
    expect(hrefOf(notification({ ref_type: "followup", ref_id: 5, type: "followup" }), false)).toBe(
      "/projects/7?tab=跟进&followup=5",
    );
    expect(hrefOf(notification({ ref_type: "project", ref_id: null, type: "stagnant" }), false)).toBe(
      "/projects/7",
    );
  });

  it("立项审批按审批权限落审批中心或项目详情；无项目的非审批通知不跳转", () => {
    const filing = notification({ type: "approval", ref_type: "project", ref_id: 7 });
    expect(hrefOf(filing, true)).toBe("/approvals?filing=7");
    expect(hrefOf(filing, false)).toBe("/projects/7");
    expect(hrefOf(notification({ type: "overdue_task", project_id: null }), true)).toBeNull();
    expect(hrefOf(notification({ type: "approval", project_id: null }), true)).toBe("/approvals");
    expect(hrefOf(notification({ type: "approval", project_id: null }), false)).toBeNull();
  });

  it("ref_id 缺失时不拼空的定位参数", () => {
    expect(hrefOf(notification({ ref_id: null }), false)).toBe("/progress?project_id=7");
    expect(hrefOf(notification({ ref_id: 0 }), false)).toBe("/progress?project_id=7");
  });
});

describe("通知区域", () => {
  it("列表加载后显示通知，点击未读项会标记已读并深链跳转", async () => {
    // findBy* / waitFor 依赖真实计时器；本组不用 fake timers 验证生命周期
    vi.useRealTimers();
    mocks.count.mockResolvedValue({ unread: 1 });
    mocks.list.mockResolvedValue({
      total: 1,
      unread: 1,
      page: 1,
      size: 12,
      items: [notification()],
    });

    render(
      <NotificationProvider>
        <NotificationSection />
      </NotificationProvider>,
    );
    await act(async () => {});

    const item = await screen.findByRole("button", { name: /任务逾期/ });
    await act(async () => {
      fireEvent.click(item);
    });

    expect(mocks.read).toHaveBeenCalledWith(1);
    expect(mocks.push).toHaveBeenCalledWith("/progress?project_id=7&task=101");
  });

  it("「全部已读」调用接口并把未读数清零", async () => {
    vi.useRealTimers();
    mocks.count.mockResolvedValue({ unread: 2 });
    mocks.list.mockResolvedValue({
      total: 1,
      unread: 2,
      page: 1,
      size: 12,
      items: [notification()],
    });

    render(
      <NotificationProvider>
        <NotificationSection />
      </NotificationProvider>,
    );
    await act(async () => {});
    await screen.findByRole("button", { name: /任务逾期/ });
    expect(screen.getByText("2 条未读")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全部已读" }));
    });

    expect(mocks.readAll).toHaveBeenCalledTimes(1);
    expect(screen.getByText("无未读")).toBeTruthy();
  });
});
