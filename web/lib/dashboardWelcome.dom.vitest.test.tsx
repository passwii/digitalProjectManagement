// @vitest-environment jsdom
/**
 * 工作台欢迎页（BLF 前端重构）。
 *
 * 旧数据看板的刷新/展开/失败重试用例已随页面一起移除；这里只钉新契约：
 * 不再请求看板数据、九张能力卡片、唯一的问候 h1、终点文案与 /projects 入口。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/useMeta", () => ({
  useMe: () => ({
    displayName: "张伟",
    me: { real_name: "张伟" },
  }),
}));

vi.mock("@/lib/useIsMobile", () => ({
  useIsMobile: () => false,
}));

import DashboardPage from "../app/(dashboard)/dashboard/page";

afterEach(cleanup);

describe("Dashboard 欢迎页", () => {
  it("渲染欢迎隧道，不再输出任何数据看板区块", () => {
    const { container } = render(<DashboardPage />);

    expect(container.querySelector('[data-dashboard-page="true"]')).not.toBeNull();
    expect(container.querySelector('[data-welcome-tunnel="true"]')).not.toBeNull();

    const text = container.textContent ?? "";
    expect(text).not.toContain("项目航迹");
    expect(text).not.toContain("当前工作态势");
    expect(text).not.toContain("工作台关键指标");
    expect(text).not.toContain("需要介入");
  });

  it("问候语使用当前用户名，全页只有一个 h1", () => {
    const { container } = render(<DashboardPage />);
    const headings = container.querySelectorAll("h1");

    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain("你好");
    expect(headings[0].textContent).toContain("张伟");
  });

  it("九张能力卡片与草稿文案一致", () => {
    const { container } = render(<DashboardPage />);
    const cards = container.querySelectorAll("[data-welcome-card]");

    expect(cards).toHaveLength(9);
    expect(container.textContent).toContain("统一台账");
    expect(container.textContent).toContain("进度留痕");
    expect(container.textContent).toContain("支出归集");
    expect(container.textContent).toContain("审批协同");
    expect(container.textContent).toContain("交付复盘");
    expect(container.textContent).toContain("通讯录");
    expect(container.textContent).toContain("项目报表");
    expect(container.textContent).toContain("云电竞平台");
    expect(container.textContent).toContain("智能音视频");
  });

  it("页面源码不再请求看板接口，终点入口指向项目台账", () => {
    const page = readFileSync(resolve(__dirname, "../app/(dashboard)/dashboard/page.tsx"), "utf8");
    const welcome = readFileSync(
      resolve(__dirname, "../components/dashboard/welcome/WelcomeTunnel.tsx"),
      "utf8",
    );

    expect(page).not.toContain("dashboardApi");
    expect(page).not.toContain("recharts");
    expect(welcome).toContain("从这里开始。");
    expect(welcome).toContain('href="/projects"');
    expect(welcome).toContain("data-end-primary");
  });

  it("隧道使用自定义纵向手势，避免移动端被原生 pan-y 取消", () => {
    const css = readFileSync(
      resolve(__dirname, "../components/dashboard/welcome/WelcomeTunnel.module.css"),
      "utf8",
    );
    expect(css).toContain("touch-action: none");
    expect(css).not.toContain("touch-action: pan-y");
  });
});
