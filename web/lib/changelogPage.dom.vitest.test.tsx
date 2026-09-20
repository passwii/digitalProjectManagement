// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChangelogPage from "../app/(dashboard)/changelog/page";

describe("功能更新页面", () => {
  it("默认展示 V2，并能切换到 V1", () => {
    render(<ChangelogPage />);

    expect(screen.getByRole("tabpanel").textContent).toContain("V2 · 扩展能力");
    expect(screen.getByText("财务凭证与核实流程")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /V2/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: /V1/ }));
    expect(screen.getByRole("tabpanel").textContent).toContain("V1 · 基础项目管理");
    expect(screen.getByText("工作台")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /V1/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /V2/ }).getAttribute("aria-selected")).toBe("false");
  });
});
