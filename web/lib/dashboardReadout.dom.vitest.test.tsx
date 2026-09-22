// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import DashboardReadout from "../components/dashboard/DashboardReadout";

afterEach(() => cleanup());

describe("DashboardReadout", () => {
  it("渲染标签、读数、辅助说明和语义 tone", () => {
    render(
      <DashboardReadout
        label="逾期任务"
        value={3}
        detail="我负责 1 项"
        tone="danger"
      />,
    );

    const readout = screen.getByTestId("dashboard-readout");
    expect(readout.getAttribute("data-tone")).toBe("danger");
    expect(readout.getAttribute("aria-label")).toBe("逾期任务");
    expect(readout.textContent).toContain("逾期任务");
    expect(readout.textContent).toContain("我负责 1 项");
    expect(readout.querySelector('[data-readout-value="3"]')).not.toBeNull();
  });

  it("允许金额格式化并默认使用中性状态", async () => {
    render(
      <DashboardReadout
        label="本月支出"
        value={12800}
        format={(value) => `¥${Math.round(value).toLocaleString("zh-CN")}`}
        detail="按已通过支出统计"
      />,
    );

    const readout = screen.getByTestId("dashboard-readout");
    expect(readout.getAttribute("data-tone")).toBe("neutral");
    await waitFor(() => expect(readout.textContent).toContain("¥12,800"));
  });
});
