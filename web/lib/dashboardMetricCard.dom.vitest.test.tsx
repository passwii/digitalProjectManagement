// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashboardMetricCard from "../components/dashboard/DashboardMetricCard";

afterEach(() => cleanup());

describe("DashboardMetricCard", () => {
  it("渲染标签、数值、辅助说明和语义 tone", () => {
    render(
      <DashboardMetricCard
        label="逾期任务"
        value={3}
        detail={<>我负责 <span className="mono">1</span></>}
        tone="danger"
      />,
    );

    const card = screen.getByTestId("dashboard-metric");
    expect(card.getAttribute("data-tone")).toBe("danger");
    expect(card.textContent).toContain("逾期任务");
    expect(card.textContent).toContain("我负责");
    expect(card.querySelector('[data-metric-value="3"]')).not.toBeNull();
  });

  it("默认使用中性 tone，并允许格式化金额", () => {
    render(
      <DashboardMetricCard
        label="本月支出"
        value={12800}
        format={(value) => `¥${Math.round(value).toLocaleString("zh-CN")}`}
        detail="按已通过支出统计"
      />,
    );

    const card = screen.getByTestId("dashboard-metric");
    expect(card.getAttribute("data-tone")).toBe("neutral");
    expect(card.getAttribute("aria-label")).toBe("本月支出");
    expect(card.textContent).toContain("按已通过支出统计");
  });
});
