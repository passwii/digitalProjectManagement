// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `usePathname` 的可编程替身（BLF-1389）。
 *
 * 安装提示现在按**当前所在站点**取名字（云电竞管理平台 / 智能音视频平台 /
 * 数科云办公），所以测试要能控制「当前在哪个路由」。
 *
 * 用 `vi.hoisted` 而不是普通变量：`vi.mock` 的工厂函数会被提升到
 * 模块顶部，那时普通的 `const` 还没初始化（TDZ 报错）。
 */
const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn((): string => "/dashboard"),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

import InstallPrompt from "../components/pwa/InstallPrompt";

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;
const originalMaxTouchPoints = navigator.maxTouchPoints;

function setDevice({
  userAgent,
  platform = "Linux x86_64",
  maxTouchPoints = 0,
}: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
}

function installEvent() {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome: "dismissed" as const, platform: "web" }),
  });
}

function installMemoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  pathnameMock.mockReturnValue("/dashboard");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(display-mode: standalone)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => {}) },
  });
  installMemoryStorage();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setDevice({
    userAgent: originalUserAgent,
    platform: originalPlatform,
    maxTouchPoints: originalMaxTouchPoints,
  });
  vi.restoreAllMocks();
});

describe("InstallPrompt 的设备范围", () => {
  it("桌面浏览器收到 beforeinstallprompt 时不显示，也不初始化 PWA 安装流程", async () => {
    setDevice({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    });
    render(<InstallPrompt />);

    await act(async () => {
      window.dispatchEvent(installEvent());
    });

    expect(screen.queryByRole("dialog", { name: "安装数科云办公" })).toBeNull();
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
  });

  it("Android 手机收到 beforeinstallprompt 时显示安装提示", async () => {
    setDevice({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    });
    render(<InstallPrompt />);

    await act(async () => {
      window.dispatchEvent(installEvent());
    });

    expect(screen.getByRole("dialog", { name: "安装数科云办公" })).toBeTruthy();
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
    });
  });

  it("iPhone 没有 beforeinstallprompt 时仍显示 iOS 安装引导", () => {
    setDevice({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    render(<InstallPrompt />);

    expect(screen.getByRole("dialog", { name: "安装数科云办公" })).toBeTruthy();
  });
});

describe("InstallPrompt 的站点文案（BLF-1389）", () => {
  it("在独立站点的路由上显示该站点的名字（不是「数科云办公」）", async () => {
    pathnameMock.mockReturnValue("/spark/dashboard");
    setDevice({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    });
    render(<InstallPrompt />);

    await act(async () => {
      window.dispatchEvent(installEvent());
    });

    // 在云电竞管理平台上不能提示「安装数科云办公」——
    // 浏览器装的是 manifest 里那个应用，名字对不上会装错。
    expect(screen.getByRole("dialog", { name: "安装云电竞管理平台" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "安装数科云办公" })).toBeNull();
    expect(screen.getByText("将云电竞管理平台安装到手机。")).toBeTruthy();
  });

  it("智能音视频平台也用自己的名字", async () => {
    pathnameMock.mockReturnValue("/stream-monitor/overview");
    setDevice({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    });
    render(<InstallPrompt />);

    await act(async () => {
      window.dispatchEvent(installEvent());
    });

    expect(screen.getByRole("dialog", { name: "安装智能音视频平台" })).toBeTruthy();
  });

  it("主工作台仍然是原来的名字", async () => {
    pathnameMock.mockReturnValue("/dashboard");
    setDevice({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    });
    render(<InstallPrompt />);

    await act(async () => {
      window.dispatchEvent(installEvent());
    });

    expect(screen.getByRole("dialog", { name: "安装数科云办公" })).toBeTruthy();
  });
});

/**
 * 跨站点导航后的安装归属（BLF-1389 复核 P1）。
 *
 * 背景：`beforeinstallprompt` 是**一次性**的页面级事件，而弹层文案按当前
 * 路由每次渲染重算 —— 两者生命周期不同步。跨站点导航后若不处理，就会出现
 * 「弹层写着安装云电竞管理平台、按下去装进去的却是数科云办公」。
 *
 * 这里钉住三条：
 *   1. 旧站点的���件在跨站导航后**立即作废**（不再拿它装任何东西）；
 *   2. 新站点的事件到达后，弹层按新站点出现，装的是新站点的应用；
 *   3. 装机前还有一道兜底：事件归属的 manifest 与当前页面声明的不一致时，
 *      拒绝装机（宁可这次不装，也不装错应用）。
 */
describe("InstallPrompt 的跨站点安装归属（BLF-1389 复核 P1）", () => {
  /**
   * 页面上的 `<link rel="manifest">` —— 浏览器判定可安装性读的就是它，
   * 组件的归属校验也对着它。Next 在客户端导航时会把它换成新站点那份。
   */
  function setManifestLink(href: string) {
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "manifest");
      document.head.appendChild(link);
    }
    link.setAttribute("href", href);
  }

  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36";

  beforeEach(() => {
    setManifestLink("/manifest.webmanifest");
  });

  afterEach(() => {
    document.querySelector('link[rel="manifest"]')?.remove();
  });

  it("在 /dashboard 拿到事件 → 导航到 /spark → 旧事件立即作废，新事件按新站点出现", async () => {
    pathnameMock.mockReturnValue("/dashboard");
    setDevice({ userAgent: ANDROID_UA });
    const { rerender } = render(<InstallPrompt />);

    const rootEvent = installEvent();
    await act(async () => {
      window.dispatchEvent(rootEvent);
    });
    expect(screen.getByRole("dialog", { name: "安装数科云办公" })).toBeTruthy();

    // 跨站点导航：Next 把 <link rel="manifest"> 换成站点那份，路由也变了。
    setManifestLink("/spark/manifest.webmanifest");
    pathnameMock.mockReturnValue("/spark/dashboard");
    await act(async () => {
      rerender(<InstallPrompt />);
    });

    // 旧事件当场作废：弹层不再拿「主工作台」的名字承诺任何安装。
    expect(screen.queryByRole("dialog", { name: "安装数科云办公" })).toBeNull();
    // ⚠️ 这条是**旧实现会挂**的那一条：旧实现里弹层文案跟着路由翻成
    // 「安装云电竞管理平台」，而按钮底下绑的还是根站点的旧事件 ——
    // 用户看到装 A，按下去装出来的是 B。所以跨站导航后弹层必须**整个消失**，
    // 直到新站点的事件到达。
    expect(screen.queryByRole("dialog", { name: "安装云电竞管理平台" })).toBeNull();

    // Chrome 在软导航后为新站点的 manifest 重新派发事件（实测 ~120ms）。
    const sparkEvent = installEvent();
    await act(async () => {
      window.dispatchEvent(sparkEvent);
    });

    expect(screen.getByRole("dialog", { name: "安装云电竞管理平台" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "安装数科云办公" })).toBeNull();

    // 按「安装」：调的是**新**事件，旧事件一次都没被调用过。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "安装" }));
    });
    expect(sparkEvent.prompt).toHaveBeenCalled();
    expect(rootEvent.prompt).not.toHaveBeenCalled();
  });

  it("装机前兜底：事件归属的 manifest 与当前页面声明的不一致时拒绝装机", async () => {
    pathnameMock.mockReturnValue("/dashboard");
    setDevice({ userAgent: ANDROID_UA });
    render(<InstallPrompt />);

    const event = installEvent();
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(screen.getByRole("dialog", { name: "安装数科云办公" })).toBeTruthy();

    // 装机前页面上的 manifest 变了（导航已提交、事件还攥在手里）——
    // 这时按下「安装」会装错应用，必须拒绝。
    setManifestLink("/spark/manifest.webmanifest");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "安装" }));
    });

    expect(event.prompt).not.toHaveBeenCalled();
  });

  it("iOS 引导跨站点导航后仍然在，并按新站点显示名字", async () => {
    pathnameMock.mockReturnValue("/dashboard");
    setDevice({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const { rerender } = render(<InstallPrompt />);

    expect(screen.getByRole("dialog", { name: "安装数科云办公" })).toBeTruthy();

    setManifestLink("/spark/manifest.webmanifest");
    pathnameMock.mockReturnValue("/spark/dashboard");
    await act(async () => {
      rerender(<InstallPrompt />);
    });

    // iOS 不派发 beforeinstallprompt（走系统分享菜单），没有「装错应用」的风险，
    // 引导要留着，并按新站点改名。
    expect(screen.getByRole("dialog", { name: "安装云电竞管理平台" })).toBeTruthy();
  });
});
