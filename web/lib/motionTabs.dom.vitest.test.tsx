// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import MotionTabs from "../components/motion/MotionTabs";

afterEach(() => cleanup());

describe("MotionTabs", () => {
  it("活动指示条相对当前页签按钮定位，而不是落到页面定位上下文", () => {
    const styles = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
    const tabRule = styles.match(/\.tabs button\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const activeTabRule = styles.match(/\.tabs button\.active\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(tabRule).toMatch(/\bposition:\s*relative\s*;/);
    expect(activeTabRule).not.toMatch(/border-bottom-color\s*:/);

    render(
      <MotionTabs
        items={[{ id: "用户", label: "用户" }, { id: "角色", label: "角色" }]}
        active="用户"
        onChange={() => {}}
      >
        <div />
      </MotionTabs>,
    );

    const activeTab = document.querySelector<HTMLButtonElement>('button[aria-selected="true"]');
    const indicator = activeTab?.querySelector("span");
    expect(indicator).not.toBeNull();
    expect(indicator?.style.position).toBe("absolute");
  });
});

/*
 * 移动端下拉与桌面页签必须互斥。
 *
 * jsdom 没有级联/媒体查询，写多少 render 用例都测不出「767px 以下才显示」，
 * 所以把互斥契约钉在 CSS 文本上（照 datePicker.dom.vitest.test.tsx 的做法）。
 */
describe("移动下拉与桌面页签互斥", () => {
  const css = readFileSync(
    resolve(__dirname, "../components/motion/MotionTabs.module.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const mobileRule = css.match(/\.mobileSelect\s*\{([^}]*)\}/)?.[1] ?? "";
  const media = css.match(/@media\s*\(max-width:\s*767px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const mediaMobile = media.match(/\.mobileSelect\s*\{([^}]*)\}/)?.[1] ?? "";
  const mediaTabList = media.match(/\.tabList\s*\{([^}]*)\}/)?.[1] ?? "";

  it("默认隐藏下拉，且用 !important 顶住同优先级的 .root", () => {
    expect(mobileRule).toMatch(/display:\s*none\s*!important/);
  });

  it("≤767px 时显示下拉、隐藏页签", () => {
    expect(mediaMobile).toMatch(/display:\s*block\s*!important/);
    expect(mediaTabList).toMatch(/display:\s*none\s*!important/);
  });

  it("渲染出 combobox 与 tablist，且 combobox 被 mobileSelect 包裹", () => {
    render(
      <MotionTabs
        items={[{ id: "用户", label: "用户" }, { id: "角色", label: "角色" }]}
        active="用户"
        onChange={() => {}}
      >
        <div />
      </MotionTabs>,
    );

    // 两者都在 DOM 里，显示与否交给上面的媒体查询；关键是下拉有自己的外壳，
    // 不再把 module 类直接压在共享 Select 的 root 上被 .root 覆盖。
    const combo = screen.getByRole("combobox");
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(combo.closest("div")?.className).toContain("mobileSelect");
  });
});

describe("页签键盘导航", () => {
  it("ArrowRight 把焦点和选中项一起移到下一个分区", () => {
    const onChange = vi.fn();
    render(
      <MotionTabs
        items={[{ id: "用户", label: "用户" }, { id: "角色", label: "角色" }]}
        active="用户"
        onChange={onChange}
      >
        <div />
      </MotionTabs>,
    );

    fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("角色");
  });
});
