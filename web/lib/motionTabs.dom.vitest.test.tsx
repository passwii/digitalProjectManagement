// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import MotionTabs from "../components/motion/MotionTabs";

afterEach(() => cleanup());

describe("MotionTabs", () => {
  it("活动指示条相对当前页签按钮定位，而不是落到页面定位上下文", () => {
    const styles = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
    const tabRule = styles.match(/\.tabs button\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(tabRule).toMatch(/\bposition:\s*relative\s*;/);

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
