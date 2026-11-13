// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import CenteredNavbar from "@/components/shell/CenteredNavbar";
import type { ShellNavItem } from "@/lib/globalNav";

/**
 * 居中药丸导航（task-1）的组件级契约。
 *
 * 重点不是像素，而是三件会被误改坏的事：
 *   1. 五个主入口固定顺序 + 溢出层进「更多」，独立站点不补位；
 *   2. Esc / 外部点击关闭并还焦；
 *   3. jsdom（无 WebGL / 无 ResizeObserver / reduce）下必须能回退，不崩。
 */
const ITEMS: ShellNavItem[] = [
  { href: "/projects", label: "项目台账" },
  { href: "/dashboard", label: "工作台" },
  { href: "/progress", label: "进度跟踪" },
  { href: "/costs", label: "支出记录" },
  { href: "/approvals", label: "审批中心" },
  { href: "/contacts", label: "通讯录" },
  { href: "/spark", label: "云电竞管理平台", external: true, target: "spark-platform" },
  { href: "/stream-monitor", label: "智能音视频平台", external: true, target: "_blank" },
];

const navCss = readFileSync(
  resolve(process.cwd(), "components/shell/CenteredNavbar.module.css"),
  "utf8",
);
const liquidSrc = readFileSync(
  resolve(process.cwd(), "components/ui/liquid-navbar.tsx"),
  "utf8",
);

function navHrefs(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll("[data-centered-nav] a")).map((anchor) =>
    anchor.getAttribute("href"),
  );
}

function moreButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "更多" }) as HTMLButtonElement;
}

/** 手动驱动的 rAF：jsdom 默认实现不可控，这里只收集回调，测试里按需 flush。 */
let frameQueue: FrameRequestCallback[] = [];
let originalRaf: typeof window.requestAnimationFrame;
let originalCancelRaf: typeof window.cancelAnimationFrame;
let originalMatchMedia: typeof window.matchMedia | undefined;

function flushAnimationFrame() {
  const pending = frameQueue;
  frameQueue = [];
  act(() => {
    for (const callback of pending) callback(performance.now());
  });
}

/** canvas 取上下文：默认 null（jsdom 不实现 canvas / WebGL），用例按需替换。 */
const canvasContext = vi.fn((): CanvasRenderingContext2D | null => null);

function mediaQuery(query: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  } as unknown as MediaQueryList;
}

function fakeWebgl(): WebGLRenderingContext {
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    COLOR_BUFFER_BIT: 9,
    drawingBufferWidth: 28,
    drawingBufferHeight: 28,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    useProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    viewport: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    uniform4f: vi.fn(),
    uniform4fv: vi.fn(),
    uniform1fv: vi.fn(),
    uniform3f: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawArrays: vi.fn(),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
  };
  return gl as unknown as WebGLRenderingContext;
}

beforeEach(() => {
  frameQueue = [];
  originalRaf = window.requestAnimationFrame;
  originalCancelRaf = window.cancelAnimationFrame;
  originalMatchMedia = window.matchMedia;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    frameQueue = frameQueue.filter((_, index) => index + 1 !== id);
  }) as typeof window.cancelAnimationFrame;

  // jsdom 没有 matchMedia（或只实现了一部分）：默认给「不减少动效」的替身。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => mediaQuery(query, false),
  });

  // jsdom 的 getContext 会打日志并返回 null，这里直接接管（默认仍是 null = 无 WebGL）。
  canvasContext.mockReset();
  canvasContext.mockImplementation(() => null);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    canvasContext as unknown as HTMLCanvasElement["getContext"],
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCancelRaf;
  if (originalMatchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
  document.documentElement.removeAttribute("data-theme");
});

describe("CenteredNavbar：主入口与「更多」", () => {
  it("五个主入口按固定顺序渲染，溢出入口不进入药丸", () => {
    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);

    expect(navHrefs(container)).toEqual([
      "/dashboard",
      "/projects",
      "/progress",
      "/costs",
      "/approvals",
    ]);
    expect(container.querySelectorAll("[data-centered-nav] a")).toHaveLength(5);
  });

  it("主入口缺位时用药丸外补位，不做成空位", () => {
    const itemsWithoutCosts = ITEMS.filter((item) => item.href !== "/costs");
    const { container } = render(
      <CenteredNavbar items={itemsWithoutCosts} activeHref="/dashboard" />,
    );

    expect(navHrefs(container)).toEqual([
      "/dashboard",
      "/projects",
      "/progress",
      "/approvals",
      "/contacts",
    ]);
  });

  it("当前路径在主入口时高亮该项，不高亮「更多」", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/projects/42" />);

    const activeLink = screen.getByRole("link", { name: "项目台账" });
    expect(activeLink.getAttribute("aria-current")).toBe("page");
    expect(activeLink.getAttribute("data-liquid-active")).toBe("true");
    expect(moreButton().getAttribute("aria-current")).toBeNull();
  });

  it("当前路径在溢出层时高亮「更多」，药丸项都不算当前页", () => {
    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/contacts" />);

    expect(moreButton().getAttribute("aria-current")).toBe("page");
    expect(moreButton().getAttribute("data-liquid-active")).toBe("true");
    expect(
      Array.from(container.querySelectorAll("[data-centered-nav] a[aria-current]")),
    ).toHaveLength(0);
  });

  it("「更多」浮层列出溢出入口，外链按其 target 打开且 _blank 带 rel", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    fireEvent.click(moreButton());

    const panel = screen.getByLabelText("更多导航");
    expect(panel).not.toBeNull();
    expect(Array.from(panel.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "/contacts",
      "/spark",
      "/stream-monitor",
    ]);

    const contacts = screen.getByRole("link", { name: "通讯录" });
    expect(contacts.getAttribute("target")).toBeNull();

    const spark = screen.getByRole("link", { name: "云电竞管理平台" });
    expect(spark.getAttribute("target")).toBe("spark-platform");

    const monitor = screen.getByRole("link", { name: "智能音视频平台" });
    expect(monitor.getAttribute("target")).toBe("_blank");
    expect(monitor.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("打开「更多」时液滴跟到按钮上，收起后回到主入口", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    const activeLink = screen.getByRole("link", { name: "工作台" });
    expect(activeLink.getAttribute("data-liquid-active")).toBe("true");

    fireEvent.click(moreButton());
    expect(moreButton().getAttribute("data-liquid-active")).toBe("true");
    // 液滴只有一个落点：主入口不再标记，aria-current 仍留在页面对应的入口
    expect(activeLink.getAttribute("data-liquid-active")).toBeNull();
    expect(activeLink.getAttribute("aria-current")).toBe("page");

    fireEvent.click(moreButton());
    expect(activeLink.getAttribute("data-liquid-active")).toBe("true");
    expect(moreButton().getAttribute("data-liquid-active")).toBeNull();
  });

  it("再次点击「更多」收起浮层", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    fireEvent.click(moreButton());
    expect(screen.queryByLabelText("更多导航")).not.toBeNull();

    fireEvent.click(moreButton());
    expect(screen.queryByLabelText("更多导航")).toBeNull();
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("全部入口都是主入口时不渲染「更多」（没有可展示的二级项）", () => {
    const primaryOnly = ITEMS.filter((item) => item.href !== "/contacts" && !item.external);
    render(<CenteredNavbar items={primaryOnly} activeHref="/dashboard" />);

    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
  });

  it("不渲染品牌与账号（这两块归 layout 的锚点区）", () => {
    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);

    expect(screen.queryByText("数科云办公")).toBeNull();
    expect(container.querySelector("[data-account], [data-brand]")).toBeNull();
  });
});

describe("CenteredNavbar：关闭与焦点", () => {
  it("Esc 关闭浮层并把焦点还给「更多」", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    fireEvent.click(moreButton());
    expect(screen.queryByLabelText("更多导航")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByLabelText("更多导航")).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it("点击浮层外部关闭", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    fireEvent.click(moreButton());
    expect(screen.queryByLabelText("更多导航")).not.toBeNull();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByLabelText("更多导航")).toBeNull();
  });

  it("点击浮层内部不关闭（由链接自身负责跳转）", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    fireEvent.click(moreButton());
    const panel = screen.getByLabelText("更多导航");

    fireEvent.mouseDown(panel);

    expect(screen.queryByLabelText("更多导航")).not.toBeNull();
  });

  it("键盘打开浮层时焦点进入第一项", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);

    fireEvent.click(moreButton(), { detail: 0 });
    flushAnimationFrame();

    expect(document.activeElement).toBe(screen.getByRole("link", { name: "通讯录" }));
  });

  it("路由变化后浮层自动收起", () => {
    const { rerender } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    fireEvent.click(moreButton());
    expect(screen.queryByLabelText("更多导航")).not.toBeNull();

    rerender(<CenteredNavbar items={ITEMS} activeHref="/projects" />);

    expect(screen.queryByLabelText("更多导航")).toBeNull();
  });
});

describe("CenteredNavbar：权限同步失败", () => {
  it("展示提示与重试按钮，点击重试触发回调", () => {
    const onRetry = vi.fn();
    render(
      <CenteredNavbar
        items={ITEMS}
        activeHref="/dashboard"
        permsError
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("权限信息加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("没有重试回调时只提示，不渲染空按钮", () => {
    render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" permsError />);

    expect(screen.getByRole("alert")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});

describe("CenteredNavbar：WebGL / 观测器不可用时的回退", () => {
  it("jsdom 没有 ResizeObserver / IntersectionObserver，挂载不崩", () => {
    expect(typeof window.ResizeObserver).not.toBe("function");
    expect(typeof window.IntersectionObserver).not.toBe("function");

    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);

    expect(container.querySelector("[data-centered-nav]")).not.toBeNull();
  });

  it("getContext 返回 null 时退回 CSS 液滴，画布隐藏且不崩", () => {
    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);

    const nav = container.querySelector("[data-centered-nav]")!;
    const canvas = container.querySelector("canvas")!;
    expect(canvasContext).toHaveBeenCalled();
    expect(nav.hasAttribute("data-liquid-gl")).toBe(false);
    expect((canvas as HTMLCanvasElement).style.display).toBe("none");
    expect(container.querySelector("[data-liquid-drop='true']")).not.toBeNull();

    // 回退后交互仍然可用
    fireEvent.click(moreButton());
    expect(screen.getByLabelText("更多导航")).not.toBeNull();
  });

  it("getContext 抛错时同样回退，不把异常抛到渲染层", () => {
    canvasContext.mockImplementation(() => {
      throw new Error("WebGL is not available");
    });
    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);

    const nav = container.querySelector("[data-centered-nav]")!;
    expect(nav.hasAttribute("data-liquid-gl")).toBe(false);
  });

  it("prefers-reduced-motion 时不创建 WebGL，直接走 CSS 液滴", () => {
    canvasContext.mockReturnValue(fakeWebgl() as unknown as CanvasRenderingContext2D);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => mediaQuery(query, query.includes("prefers-reduced-motion")),
    });

    const { container } = render(<CenteredNavbar items={ITEMS} activeHref="/dashboard" />);
    const nav = container.querySelector("[data-centered-nav]")!;

    expect(canvasContext).not.toHaveBeenCalled();
    expect(nav.hasAttribute("data-liquid-gl")).toBe(false);
    expect(container.querySelector("[data-liquid-drop='true']")).not.toBeNull();
  });

  it("WebGL 可用时进入 shader 路径（正向自检：回退断言不是恒真）", () => {
    const gl = fakeWebgl();
    canvasContext.mockReturnValue(gl as unknown as CanvasRenderingContext2D);
    const { container, unmount } = render(
      <CenteredNavbar items={ITEMS} activeHref="/dashboard" />,
    );

    const nav = container.querySelector("[data-centered-nav]")!;
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(nav.getAttribute("data-liquid-gl")).toBe("on");
    expect(canvas.style.display).toBe("block");
    expect(gl.createShader).toHaveBeenCalledTimes(2);
    expect(gl.linkProgram).toHaveBeenCalledTimes(1);

    unmount();
    expect(nav.hasAttribute("data-liquid-gl")).toBe(false);
  });
});

describe("CenteredNavbar：样式与液态引擎的源码契约", () => {
  it("组件本身不 fixed：定位交给 layout 的 navDock", () => {
    const rootBlock = /\.root\s*\{([\s\S]*?)\n\}/.exec(navCss)?.[1] ?? "";
    expect(rootBlock).toContain("position: relative;");
    expect(rootBlock).not.toContain("position: fixed");
    expect(navCss).not.toMatch(/position:\s*fixed/);
  });

  it("「更多」浮层相对组件定位，宽度按视口 clamp", () => {
    const moreBlock = /\.more\s*\{([\s\S]*?)\n\}/.exec(navCss)?.[1] ?? "";
    expect(moreBlock).toContain("position: absolute;");
    expect(moreBlock).toMatch(/top:\s*calc\(100% \+ 10px\);/);
    expect(moreBlock).toMatch(/width:\s*clamp\(260px, calc\(100vw - 28px\), 520px\);/);
  });

  it("颜色与时长只走令牌，不写裸色值与裸时长", () => {
    expect(navCss).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(navCss).not.toMatch(/\brgba?\s*\(/i);
    expect(navCss).not.toMatch(/\bhsla?\s*\(/i);
    expect(navCss).not.toMatch(/\b\d+(?:ms|s)\b/);
    expect(navCss).toMatch(/var\(--motion-base\)/);
    expect(navCss).toMatch(/var\(--ease-console\)/);
  });

  it("窄屏只留图标与「更多」，标签收成 sr-only", () => {
    const phoneBlock = /@media \(max-width: 767px\)\s*\{([\s\S]*?)\n\}/.exec(navCss)?.[1] ?? "";
    expect(phoneBlock).toContain("height: 38px;");
    const wideBlock = /@media \(max-width: 1120px\)\s*\{([\s\S]*?)\n\}/.exec(navCss)?.[1] ?? "";
    expect(wideBlock).toMatch(/\.label\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/);
  });

  it("切换动效是单体弹簧（方案 B），没有拖尾 / 分裂 / 涟漪", () => {
    expect(liquidSrc).toMatch(/from "@\/lib\/liquidNavMotion"/);
    expect(liquidSrc).toMatch(/stepLiquid\(state\.a, target\.x, dt\)/);
    expect(liquidSrc).toMatch(/while \(state\.acc >= LIQUID_STEP/);
    expect(liquidSrc).not.toMatch(/state\.sats/);
    expect(liquidSrc).not.toMatch(/state\.rips/);
    expect(liquidSrc).not.toMatch(/Satellite/);
  });

  it("液态引擎静止 900ms 停 rAF，reduced-motion 不创建 WebGL", () => {
    expect(liquidSrc).toMatch(/const IDLE_HOLD_MS = 900;/);
    expect(liquidSrc).toMatch(/performance\.now\(\) \+ IDLE_HOLD_MS/);
    expect(liquidSrc).toMatch(/prefers-reduced-motion: reduce/);
    expect(liquidSrc).toMatch(/fallbackToCssDrop/);
    expect(liquidSrc).toMatch(/webglcontextlost/);
  });
});
