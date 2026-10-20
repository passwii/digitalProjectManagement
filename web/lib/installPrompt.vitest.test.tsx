// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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
