// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AvShell from "@/components/av/AvShell";
import ThemeProvider from "@/components/theme/ThemeProvider";
import AvMotionProvider from "@/components/av/motion/AvMotionProvider";

/**
 * 壳层「数据锚点去重」与「主题切换改图标」的 DOM 契约（BLF-1398 / Stage 6）。
 *
 * 两条都是**视觉层**的诉求，但「同一个时间戳在一屏里出现三次」「一个开关型控件
 * 用纯文字表达」这种缺陷，靠看代码容易放过，靠肉眼看截图又容易漏掉回归 ——
 * 所以让 CI 守在 DOM 上。
 *
 * 守什么：
 *   1. 「数据锚点」在**整个视口**里只出现一次（顶栏状态栏那颗徽标是唯一来源）；
 *      侧栏底部与页头都不再重复它。
 *   2. 主题切换按钮**只渲染图标**，不渲染「浅色」/「深色」文字节点，但**保留**
 *      `aria-label` 与 `title` —— 图标按钮不能只靠图标传达含义。
 *   3. 图标方向与 aria-label **同向**：深色下画太阳（点了去浅色），
 *      浅色下画月亮（点了去深色）。图标与读屏文案相反是这一类控件最常见的失败。
 *
 * 为什么要跑真实组件而不是扫源码：源码扫描分不清「JSX 文本节点」与「属性里的
 * 文案」，而这条契约要守的正是「按钮里**没有**浅色/深色这两个字」——
 * 只有渲染出来才说得清。
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/stream-monitor/overview",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

/** jsdom 没有 matchMedia：主题 Provider 与动效 Provider 都要读它。 */
function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
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

beforeEach(() => {
  mockMatchMedia(false);
  window.history.pushState({}, "", "/stream-monitor/overview");
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
});

function renderShell() {
  return render(
    <ThemeProvider>
      <AvMotionProvider>
        <AvShell
          orgName="智能音视频平台"
          version="v3.9.0"
          onlineRate={98.2}
          deviceOnline={268}
          deviceTotal={272}
        >
          <div>页面内容</div>
        </AvShell>
      </AvMotionProvider>
    </ThemeProvider>,
  );
}

/** 主题切换按钮（按可访问名找，避免依赖 class 名）。 */
function themeButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: /切换到(浅色|深色)主题/ });
  return button as HTMLButtonElement;
}

describe("数据锚点：同一屏只出现一次（BLF-1398）", () => {
  it("顶栏状态栏是唯一的锚点来源，壳层里不再出现第二处", () => {
    const { container } = renderShell();

    // 整棵壳层 DOM 里，「数据锚点」这四个字只允许出现一次。
    const hits = Array.from(container.querySelectorAll("*")).filter((node) =>
      Array.from(node.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.includes("数据锚点"),
      ),
    );
    expect(hits.length).toBe(1);
    expect(hits[0].textContent).toContain("数据锚点");
  });

  it("侧栏底部不再重复时间戳（只剩运行态摘要）", () => {
    renderShell();

    const sidebar = screen.getByLabelText("智能音视频平台侧栏");
    expect(sidebar.textContent).not.toContain("数据锚点");
    expect(sidebar.textContent).not.toContain("2026-10-19");
    // 换成不重复的运行态信息：在线设备数
    expect(sidebar.textContent).toContain("在线设备 268/272");
  });
});

describe("主题切换：只渲染图标，但保留可访问文本（BLF-1398）", () => {
  it("按钮里没有「浅色」/「深色」文字节点", () => {
    renderShell();

    const button = themeButton();
    expect(button.textContent?.trim()).toBe("");
    // 文字不能藏在子节点里（图标按钮只渲染图标）
    expect(button.textContent).not.toContain("浅色");
    expect(button.textContent).not.toContain("深色");
    // 确实渲染了图标（svg）
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("aria-label 与 title 都在，且说清楚动作", () => {
    renderShell();

    const button = themeButton();
    expect(button.getAttribute("aria-label")).toBe("切换到浅色主题");
    expect(button.getAttribute("title")).toBe("切换到浅色主题");
  });

  it("图标方向与 aria-label 同向：深色下是太阳（点了去浅色）", () => {
    renderShell();

    expect(document.documentElement.dataset.theme).toBe("dark");
    const button = themeButton();
    expect(button.getAttribute("aria-label")).toBe("切换到浅色主题");
    // 太阳 = 目标主题是浅色（太阳有圆心，月牙只有一条轮廓）
    expect(button.querySelector("svg circle")).not.toBeNull();
  });

  it("浅色下换成月亮（点了去深色），aria-label 同步", () => {
    renderShell();

    // 按钮读的是 ThemeProvider 的 resolvedTheme，所以走一次真实点击。
    fireEvent.click(themeButton());

    const button = themeButton();
    expect(button.getAttribute("aria-label")).toBe("切换到深色主题");
    expect(button.getAttribute("title")).toBe("切换到深色主题");
    // 月牙 = 目标主题是深色
    expect(button.querySelector("svg circle")).toBeNull();
    expect(button.querySelector("svg path")).not.toBeNull();
  });
});
