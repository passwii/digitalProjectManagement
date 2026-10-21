// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * 图表「0 高不渲染」的回归守卫（BLF-1423 · Stage 1 P0）。
 *
 * 缺陷长什么样：`ChartFrame`（AvCharts.tsx）把图表包进 `AvSkeletonSwap`，而
 * `.skeletonSwap`（AvMotion.module.css）只声明了 `animation`、没有高度。recharts 的
 * `ResponsiveContainer` 以 `height: 100%` 向上找一个「有确定高度的父节点」，父节点
 * 高度是 auto、子节点又是百分比 → 解析成 0，量到 0×0 后整张图不画。
 * 现象是 `/overview` 的告警趋势、7 日柱状、`/device` 抽屉的信号曲线全部空白，
 * 而 AvDonut 因为自带 inline height 仍然可见 —— 这正是「只有肉眼能发现」的那类缺陷。
 *
 * jsdom 没有布局引擎（`getBoundingClientRect()` 恒为 0），所以这里分两层守：
 *   1. **结构层（真实渲染）**：`.frame` 带 inline 高度 → 包裹层 → ResponsiveContainer
 *      的祖先链必须是完整的，`?static=1` 分支（`AvSkeletonSwap` 直接返回 children）
 *      也要成立；
 *   2. **样式层（源码）**：`.skeletonSwap` 必须声明 `height: 100%`（以及宽度）。
 *      把这条删掉，本文件立刻变红 —— 不依赖肉眼、也不依赖浏览器。
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/stream-monitor/overview",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `useTheme` 只为「主题变了重读令牌」服务；这个用例关心的是容器尺寸，不关心配色，
 * 所以直接给一个固定主题（同时也避免把 ThemeProvider 的 localStorage 逻辑拖进来）。
 */
vi.mock("@/components/theme/ThemeProvider", () => ({
  useTheme: () => ({ appliedTheme: "dark", resolvedTheme: "dark", mode: "dark" }),
}));

import AvMotionProvider from "@/components/av/motion/AvMotionProvider";
import { AV_MOTION_ATTRIBUTE } from "@/lib/av/motion";
import { AV_CHART_HEIGHT } from "@/lib/av/chartHeights";
import { AvTrendChart } from "@/components/av/AvCharts";

function motionCss(): string {
  return readFileSync(resolve(process.cwd(), "components/av/motion/AvMotion.module.css"), "utf8");
}

/** 取一个选择器的声明块（注释里出现同名类名不会误命中：注释里的写法后面不跟 `{`）。 */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  return match?.[1] ?? "";
}

const DATA = [
  { label: "00:00", alarms: 18, handled: 11 },
  { label: "01:00", alarms: 12, handled: 9 },
  { label: "02:00", alarms: 21, handled: 15 },
];

function renderTrend() {
  return render(
    <AvMotionProvider>
      <AvTrendChart
        data={DATA}
        dataKeys={["alarms", "handled"]}
        labels={["告警数", "已处置"]}
        tones={["series-1", "series-8"]}
        height={AV_CHART_HEIGHT.lg}
        label="告警趋势折线图"
      />
    </AvMotionProvider>,
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/stream-monitor/overview");
  // jsdom 没有实现 ResizeObserver，补一个空实现
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(AV_MOTION_ATTRIBUTE);
});

describe("图表容器高度：样式层守卫", () => {
  it("`.skeletonSwap` 声明了 100% 宽高（删掉就等于把图表变回 0 高）", () => {
    const body = ruleBody(motionCss(), ".skeletonSwap");
    expect(body, "AvMotion.module.css 里找不到 .skeletonSwap").not.toBe("");
    expect(body, "图表包裹层必须传递父节点高度，否则 ResponsiveContainer 量到 0").toMatch(
      /height:\s*100%/,
    );
    expect(body, "宽度也要 100%，否则响应式容器量不到横向尺寸").toMatch(/width:\s*100%/);
  });

  it("`.frame` 只负责宽度，高度由调用方以 inline style 注入（不写死）", () => {
    const css = readFileSync(resolve(process.cwd(), "components/av/AvCharts.module.css"), "utf8");
    const body = ruleBody(css, ".frame");
    expect(body).toMatch(/width:\s*100%/);
    // 高度是档位（AV_CHART_HEIGHT），不属于 CSS 的固定值；写死会绕过三档令牌
    expect(body).not.toMatch(/(^|[^-\w])height:\s*\d+px/);
  });
});

describe("图表容器高度：结构层守卫（真实渲染）", () => {
  it("动态档：frame(inline 高度) → skeletonSwap(100%) → ResponsiveContainer", async () => {
    const { container } = renderTrend();

    const frame = container.querySelector('[data-motion="chart"]');
    expect(frame, "图表面板外层 .frame 不存在").not.toBeNull();
    expect(frame!.getAttribute("style"), "档位高度必须以 inline style 落到 .frame").toContain(
      `height: ${AV_CHART_HEIGHT.lg}px`,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[class*="skeletonSwap"]'),
        "AvSkeletonSwap 的包裹层没有渲染出来",
      ).not.toBeNull();
    });

    const swap = container.querySelector('[class*="skeletonSwap"]');
    expect(frame!.contains(swap)).toBe(true);
    const responsive = swap!.querySelector('[class*="recharts-responsive-container"]');
    expect(responsive, "recharts 没有挂载到包裹层里").not.toBeNull();
    // recharts 自己也是 100% 高，靠的就是上面那层 100%
    expect(responsive!.getAttribute("style") ?? "").toMatch(/height:\s*100%/);
  });

  it("?static=1 静态档：不套包裹层，图表直接挂在带 inline 高度的 .frame 上", async () => {
    window.history.pushState({}, "", "/stream-monitor/overview?static=1");
    const { container } = renderTrend();

    await waitFor(() => {
      expect(document.documentElement.getAttribute(AV_MOTION_ATTRIBUTE)).toBe("off");
    });

    await waitFor(() => {
      expect(
        container.querySelector('[class*="recharts-responsive-container"]'),
        "静态档下 recharts 没有挂载",
      ).not.toBeNull();
    });

    // 这条分支 AvSkeletonSwap 直接返回 children —— 没有包裹层可依赖，
    // 高度必须来自 .frame 的 inline style（这就是「两处不要一起打补丁」的另一半）。
    expect(
      container.querySelector('[class*="skeletonSwap"]'),
      "静态档不应渲染动画包裹层",
    ).toBeNull();

    const frame = container.querySelector('[data-motion="chart"]');
    const responsive = container.querySelector('[class*="recharts-responsive-container"]');
    expect(responsive!.parentElement).toBe(frame);
    expect(frame!.getAttribute("style")).toContain(`height: ${AV_CHART_HEIGHT.lg}px`);
  });
});
