// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AvLevelBadge, AvMetric, AvStatusBadge } from "@/components/av/AvUI";

/**
 * AC5：深色 / 浅色主题切换下 AV 页面无错色（DOM 覆盖）。
 *
 * 断言方式：AV 的语义色在 DOM 上只以 `var(--av-*)` 形式出现 —— 主题切换时由
 * `app/globals.css` 的 `:root[data-theme="light"]` 替换底层值，组件本身不换样式。
 * 因此只要：
 *   1. 两级主题下徽标都渲染同一结构（色块 + 文字），
 *   2. 所有颜色相关的 style / 属性都指向变量而不是字面量，
 * 就不会出现“切到浅色后某块颜色没跟着变”的错色。
 */
describe("AV 主题与语义色（AC5）", () => {
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.theme;
  });

  function badgeIn(theme: "dark" | "light") {
    document.documentElement.dataset.theme = theme;
    const view = render(
      <div>
        <AvLevelBadge level={1} label="一级·严重" />
        <AvLevelBadge level={3} label="三级·一般" />
        <AvStatusBadge tone="success">已闭环</AvStatusBadge>
        <AvMetric label="今日告警" value="50" unit="条" detail="未处置 59 条" tone="danger" />
      </div>,
    );
    return view;
  }

  it("深色主题：色块 + 文字双通道，颜色只引用令牌", () => {
    badgeIn("dark");

    const first = screen.getByTitle("告警级别：一级·严重");
    expect(first.getAttribute("data-level")).toBe("1");
    expect(first.textContent).toContain("一级·严重");
    expect(first.querySelector("i")).not.toBeNull();
    expect(first.getAttribute("style")).toContain("var(--av-level-1)");
    expect(first.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}/i);

    const third = screen.getByTitle("告警级别：三级·一般");
    expect(third.getAttribute("style")).toContain("var(--av-level-3)");

    const metric = screen.getByText("今日告警").closest("article");
    expect(metric?.getAttribute("style")).toContain("var(--av-tone-danger)");
    expect(metric?.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("浅色主题：同一结构、同一令牌，不换一套写死的颜色", () => {
    badgeIn("light");

    const first = screen.getByTitle("告警级别：一级·严重");
    expect(first.textContent).toContain("一级·严重");
    expect(first.querySelector("i")).not.toBeNull();
    expect(first.getAttribute("style")).toContain("var(--av-level-1)");
    expect(first.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}/i);

    const status = screen.getByText("已闭环").closest("span");
    expect(status?.getAttribute("style")).toContain("var(--av-tone-success)");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
