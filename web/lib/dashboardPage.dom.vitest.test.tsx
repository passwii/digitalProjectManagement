// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DashboardSummary, Weekly } from "./api";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  weekly: vi.fn(),
  beginActivity: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/useMeta", () => ({
  useMeta: () => ({ userName: () => "张伟", deptName: () => "产品部" }),
  useMe: () => ({ me: { dept_id: 3 } }),
  useMenus: () => ({ canApprove: true }),
}));

vi.mock("@/lib/useActivity", () => ({
  useActivity: () => ({ beginActivity: mocks.beginActivity }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    dashboardApi: { summary: () => mocks.summary(), weekly: () => mocks.weekly() },
  };
});

vi.mock("recharts", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Svg = ({ children }: { children?: ReactNode }) => <svg>{children}</svg>;
  const SvgGroup = ({ children }: { children?: ReactNode }) => <g>{children}</g>;
  return {
    Area: SvgGroup,
    AreaChart: Svg,
    CartesianGrid: SvgGroup,
    Cell: Box,
    Legend: Box,
    Line: SvgGroup,
    LineChart: Svg,
    Pie: Box,
    PieChart: Box,
    ResponsiveContainer: Box,
    Tooltip: SvgGroup,
    XAxis: SvgGroup,
    YAxis: SvgGroup,
  };
});

import DashboardPage from "../app/(dashboard)/dashboard/page";

function summary(overrides: Partial<DashboardSummary["kpi"]> = {}): DashboardSummary {
  return {
    kpi: {
      my_projects: 6,
      active_projects: 4,
      overdue_tasks: 2,
      my_overdue_tasks: 1,
      near_milestones: 1,
      stagnant_projects: 0,
      total_budget: 100000,
      total_spent: 42000,
      total_rate: 0.42,
      month_spent: 12800,
      month: "2026-09",
      pending_approvals: 2,
      unread_notifications: 3,
      ...overrides,
    },
    trend: [{ month: "2026-09", spent: 12800 }],
    by_subject: [{ subject: "张伟", budget: 40000, spent: 12800 }],
    health: [{
      id: 12,
      code: "PJ-2026-001",
      name: "智慧展厅交付",
      status: "doing",
      priority: "高",
      owner_id: 1,
      progress: 68,
      plan_end: "2026-10-01",
      budget: 100000,
      spent: 42000,
      rate: 0.42,
      overdue_tasks: 1,
      stagnant_days: 0,
      health: "risk",
    }],
  };
}

const weekly: Weekly = {
  range: { from: "2026-09-15", to: "2026-09-22" },
  project_id: null,
  progress_logs: [{
    task_id: 7,
    project_id: 12,
    user_id: 1,
    progress: 68,
    note: "已完成联调",
    created_at: "2026-09-22T09:30:00",
  }],
  log_count: 1,
  overdue: [{
    id: 7,
    name: "上线联调",
    project_id: 12,
    plan_end: "2026-09-20",
    progress: 68,
    owner_id: 1,
  }],
  due_soon: [{
    id: 8,
    name: "验收材料",
    project_id: 12,
    plan_end: "2026-09-28",
    progress: 40,
    owner_id: 1,
  }],
  projects: [{ id: 12, code: "PJ-2026-001", name: "智慧展厅交付", status: "doing", progress: 68 }],
};

beforeEach(() => {
  mocks.summary.mockReset();
  mocks.weekly.mockReset();
  mocks.finish.mockReset();
  mocks.beginActivity.mockReset().mockReturnValue(mocks.finish);
  mocks.weekly.mockResolvedValue(weekly);
});

afterEach(() => cleanup());

describe("DashboardPage 刷新状态", () => {
  it("用交付坐标盘结构承载真实项目、介入事项和数据脉冲", async () => {
    mocks.summary.mockResolvedValueOnce(summary());

    render(<DashboardPage />);

    const readouts = await screen.findByTestId("dashboard-zone-readouts");
    expect(readouts.getAttribute("aria-label")).toBe("工作台关键指标");
    expect(within(readouts).queryByRole("heading", { name: "当前工作态势" })).toBeNull();
    expect(readouts.querySelectorAll('[data-testid="dashboard-readout"]')).toHaveLength(4);
    expect(
      Array.from(readouts.querySelectorAll("[data-dashboard-readout]")).map((node) => node.getAttribute("data-accent")),
    ).toEqual(["cyan", "coral", "amber", "blue"]);
    expect(screen.getByTestId("dashboard-zone-routes")).not.toBeNull();
    expect(screen.getByTestId("dashboard-zone-interventions")).not.toBeNull();
    expect(screen.getByTestId("dashboard-zone-pulse")).not.toBeNull();
    expect(screen.getAllByTestId("dashboard-readout")).toHaveLength(4);
    expect(screen.getByTestId("dashboard-route-list")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /展开其余项目/ })).toBeNull();
    expect(screen.getByText("智慧展厅交付")).not.toBeNull();
    expect(screen.getByText("上线联调")).not.toBeNull();
    expect(screen.getByText("待我审批")).not.toBeNull();
  });

  it("项目航迹默认显示三项，展开后可查看其余项目并收起", async () => {
    const base = summary();
    const projects = ["智慧展厅交付", "办公区改造", "数据中台升级", "园区网络迁移"];
    mocks.summary.mockResolvedValueOnce({
      ...base,
      health: projects.map((name, index) => ({
        ...base.health[0],
        id: index + 12,
        code: `PJ-2026-00${index + 1}`,
        name,
      })),
    });

    render(<DashboardPage />);

    const list = await screen.findByTestId("dashboard-route-list");
    expect(list.querySelectorAll("[data-dashboard-route]")).toHaveLength(3);
    expect(screen.queryByText("园区网络迁移")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开其余项目（1）" }));
    expect(list.querySelectorAll("[data-dashboard-route]")).toHaveLength(4);
    expect(screen.getByText("园区网络迁移")).not.toBeNull();
    expect(screen.getByTestId("dashboard-intervention-list").querySelectorAll("li > a")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "展开其余事项（1）" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "收起项目航迹" }));
    expect(list.querySelectorAll("[data-dashboard-route]")).toHaveLength(3);
  });

  it("需要介入默认显示三项，且可独立展开和收起", async () => {
    mocks.summary.mockResolvedValueOnce(summary());

    render(<DashboardPage />);

    const list = await screen.findByTestId("dashboard-intervention-list");
    expect(list.querySelectorAll("li > a")).toHaveLength(3);
    expect(screen.queryByText("任务 #7 已填报 68%")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开其余事项（1）" }));
    expect(list.querySelectorAll("li > a")).toHaveLength(4);
    expect(screen.getByText("任务 #7 已填报 68%")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起介入事项" }));
    expect(list.querySelectorAll("li > a")).toHaveLength(3);
  });

  it("刷新时保留上一份成功数据，并在完成后结束忙碌状态", async () => {
    let resolveRefresh!: (value: DashboardSummary) => void;
    mocks.summary
      .mockResolvedValueOnce(summary({ my_projects: 6 }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

    render(<DashboardPage />);
    const refresh = await screen.findByRole("button", { name: "刷新数据" });
    const page = document.querySelector('[data-dashboard-page="true"]');
    expect(page?.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(refresh);
    const refreshing = screen.getByRole("button", { name: "刷新中" });
    expect(refreshing.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("我的项目")).not.toBeNull();
    expect(page?.getAttribute("aria-busy")).toBe("true");

    await act(async () => resolveRefresh(summary({ my_projects: 7 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新数据" }).hasAttribute("disabled")).toBe(false));
    expect(page?.getAttribute("aria-busy")).toBe("false");
  });

  it("刷新失败时保留已成功数据并显示可重试提示", async () => {
    mocks.summary
      .mockResolvedValueOnce(summary())
      .mockRejectedValueOnce(new Error("服务暂不可用"));

    render(<DashboardPage />);
    const refresh = await screen.findByRole("button", { name: "刷新数据" });

    fireEvent.click(refresh);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("数据刷新失败，以下为上次成功数据。服务暂不可用");
    expect(screen.getByText("我的项目")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).not.toBeNull();
  });
});
