// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChangelogPage from "../app/(dashboard)/changelog/page";
import { CHANGELOG_CSS, s } from "../app/(dashboard)/changelog/changelogStyles";
import { CHANGELOG_CURRENT_VERSION } from "./changelog";

// vitest 没开 globals，testing-library 的自动清理不会注册：一个文件里 render 多次
// 会把上一份 DOM 留在 document 上，查询会命中重复元素。
afterEach(() => cleanup());

describe("功能更新页面", () => {
  it("默认展示 V3，并能切换到 V2 与 V1", () => {
    render(<ChangelogPage />);

    expect(screen.getByRole("tabpanel").textContent).toContain("V3 · Go 架构");
    expect(screen.getByText("后端整体迁移为 Go 模块化单体")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /V3/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("V3 当前版本")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /V2/ }));
    expect(screen.getByRole("tabpanel").textContent).toContain("V2 · 扩展能力");
    expect(screen.getByText("财务凭证与核实流程")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /V2/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /V3/ }).getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: /V1/ }));
    expect(screen.getByRole("tabpanel").textContent).toContain("V1 · 基础项目管理");
    expect(screen.getByText("工作台")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /V1/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /V2/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("当前版本标记跟着最新版本数据走，不再写死 V2", () => {
    expect(CHANGELOG_CURRENT_VERSION.label).toBe("V3");
    render(<ChangelogPage />);
    const mark = screen.getByLabelText(`${CHANGELOG_CURRENT_VERSION.label} 当前版本`);
    expect(mark.textContent).toContain("当前版本");
    expect(mark.textContent).toContain(CHANGELOG_CURRENT_VERSION.label);
    expect(mark.textContent).not.toContain("V2");
  });

  it("把页面样式内联下发，首帧不依赖异步 CSS chunk", () => {
    const { container } = render(<ChangelogPage />);
    const style = container.querySelector("style");
    expect(style).toBeTruthy();
    expect(style?.textContent).toBe(CHANGELOG_CSS);
    expect(style?.textContent).toContain(".changelog-page");
    expect(style?.textContent).toContain(".changelog-kindArch");

    // 页面上出现的每个 changelog-* 类名都必须在本页下发的 CSS 里有规则：
    // 谁把样式挪回独立 CSS 文件（客户端切换路由时异步到达），这里就会变红。
    const used = new Set<string>();
    for (const element of Array.from(container.querySelectorAll("[class]"))) {
      for (const cls of Array.from(element.classList)) {
        if (cls.startsWith("changelog-")) used.add(cls);
      }
    }
    expect(used.size).toBeGreaterThan(10);
    for (const cls of used) {
      expect(style?.textContent, `缺少 .${cls} 的规则`).toContain(`.${cls}`);
    }
    for (const cls of Object.values(s)) {
      expect(style?.textContent, `缺少 .${cls} 的规则`).toContain(`.${cls}`);
    }
  });

  it("页面源码不再导入独立 CSS Module（冷加载闪无样式的根因）", () => {
    const source = readFileSync(resolve(process.cwd(), "app/(dashboard)/changelog/page.tsx"), "utf8");
    expect(source).not.toMatch(/\.module\.css/);
    expect(source).toMatch(/<style/);
  });
});
