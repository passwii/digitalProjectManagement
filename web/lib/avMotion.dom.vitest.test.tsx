// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import AvMotionProvider, { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import { AvPageTransition } from "@/components/av/motion/AvMotion";
import AvCounter from "@/components/av/motion/AvCounter";
import { AV_MOTION_ATTRIBUTE } from "@/lib/av/motion";

/**
 * 动效开关的 DOM 侧契约（BLF-1375 / AC2 · AC3）。
 *
 * 三件事必须真的在 DOM 上成立，否则截图 / 录屏 / 减少动效全是空话：
 *   1. `?static=1` 时 `<html data-av-motion="off">` 被挂上，`enabled === false`，
 *      所有时长读到 0；
 *   2. 降级后组件**不渲染动画包装**（不是把时长改小），静态页与截图逐字节一致；
 *   3. `prefers-reduced-motion: reduce` 同样让 enabled 变 false（改用自己读
 *      matchMedia 的实现后，可以和正常态在同一个文件里测 —— framer 的
 *      `useReducedMotion` 会把偏好缓存在模块级，互相污染）。
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/av/overview",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function StateProbe() {
  const { enabled, duration, frozen } = useAvMotion();
  return (
    <div>
      <span data-testid="enabled">{String(enabled)}</span>
      <span data-testid="frozen">{String(frozen)}</span>
      <span data-testid="duration">{String(duration("base"))}</span>
    </div>
  );
}

describe("动效开关（AC2 / AC3）", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    window.history.pushState({}, "", "/av/overview");
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(AV_MOTION_ATTRIBUTE);
  });

  it("正常访问：动效开启，时长非零", async () => {
    render(
      <AvMotionProvider>
        <StateProbe />
      </AvMotionProvider>,
    );
    expect(screen.getByTestId("enabled").textContent).toBe("true");
    expect(Number(screen.getByTestId("duration").textContent)).toBeGreaterThan(0);
  });

  it("?static=1：<html> 挂 off、enabled=false、时长归零", async () => {
    window.history.pushState({}, "", "/av/overview?static=1");
    render(
      <AvMotionProvider>
        <StateProbe />
      </AvMotionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("frozen").textContent).toBe("true"));
    expect(document.documentElement.getAttribute(AV_MOTION_ATTRIBUTE)).toBe("off");
    expect(screen.getByTestId("enabled").textContent).toBe("false");
    expect(screen.getByTestId("duration").textContent).toBe("0");
  });

  it("?static=0 不冻结（显式关闭截图模式）", async () => {
    window.history.pushState({}, "", "/av/overview?static=0");
    render(
      <AvMotionProvider>
        <StateProbe />
      </AvMotionProvider>,
    );
    expect(screen.getByTestId("frozen").textContent).toBe("false");
  });

  it("prefers-reduced-motion: reduce 下不产生动效", async () => {
    mockMatchMedia(true);
    render(
      <AvMotionProvider>
        <StateProbe />
      </AvMotionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("enabled").textContent).toBe("false"));
    expect(document.documentElement.getAttribute(AV_MOTION_ATTRIBUTE)).not.toBe("off");
  });

  it("减少动效时页面切换与数字滚动同样走静态分支", async () => {
    mockMatchMedia(true);
    const { container } = render(
      <AvMotionProvider>
        <AvPageTransition>
          <AvCounter value="99.8" />
        </AvPageTransition>
      </AvMotionProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-motion="page"]')).toBeNull());
    expect(screen.getByText("99.8")).toBeTruthy();
  });

  it("降级后页面切换不再包动画层（静态页与截图一致）", () => {
    window.history.pushState({}, "", "/av/overview?static=1");
    const { container } = render(
      <AvMotionProvider>
        <AvPageTransition>
          <p>内容</p>
        </AvPageTransition>
      </AvMotionProvider>,
    );
    expect(container.querySelector('[data-motion="page"]')).toBeNull();
    expect(screen.getByText("内容")).toBeTruthy();
  });

  it("KPI 数字真的从 0 滚到终值（不是闪一下就定住）", async () => {
    /*
     * 回归用例：`parseCountValue` 每次渲染返回**新对象**，一旦直接进 effect 依赖，
     * 滚动过程中的每帧 setDisplay 都会让 effect 重跑，起点被重置、最终停在终值 ——
     * 肉眼就是「数字闪一下就定住」。
     *
     * jsdom 没有 IntersectionObserver，这里装一个「立刻可见」的替身，
     * 让组件真的进入 animate 分支，并采样中途读数。
     */
    const observed: string[] = [];
    const observers: Array<() => void> = [];
    class ImmediateObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        const run = () =>
          this.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        observers.push(run);
        // 下一个宏任务触发，模拟真实 IO 的首个回调
        window.setTimeout(run, 0);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    // @ts-expect-error jsdom 没有 IntersectionObserver
    window.IntersectionObserver = ImmediateObserver;

    try {
      render(
        <AvMotionProvider>
          <AvCounter value="14,366" />
        </AvMotionProvider>,
      );
      const node = screen.getByText("14,366");
      const from = node.textContent;
      // 采样 300ms：动画时长 420ms，中间必然出现「不是终值」的读数
      const start = Date.now();
      while (Date.now() - start < 300) {
        observed.push(node.textContent ?? "");
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(from).toBe("14,366");
      expect(observed.some((text) => text !== "14,366"), `observed=${[...new Set(observed)].join(",")}`).toBe(true);
      await waitFor(() => expect(node.textContent).toBe("14,366"), { timeout: 2000 });
    } finally {
      // @ts-expect-error 清理替身
      delete window.IntersectionObserver;
    }
  });

  it("KPI 数字在降级时直接给终值（不滚、不闪）", () => {
    window.history.pushState({}, "", "/av/overview?static=1");
    render(
      <AvMotionProvider>
        <AvCounter value="14,366" />
      </AvMotionProvider>,
    );
    expect(screen.getByText("14,366")).toBeTruthy();
  });
});
