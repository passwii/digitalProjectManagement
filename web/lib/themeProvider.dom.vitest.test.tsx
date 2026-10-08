// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ThemeModePicker from "../components/theme/ThemeModePicker";
import ThemeProvider, { useTheme } from "../components/theme/ThemeProvider";

function installStorage() {
  const store = new Map<string, string>();
  const api = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: api });
  return api;
}

/** 主题 Provider 会读两个媒体查询（跟随系统 / 减少动效），所以 mock 得按 query 分别答。 */
function installMatchMedia({ dark = false, reduce = false }: { dark?: boolean; reduce?: boolean } = {}) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduce : dark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function Harness() {
  const { mode, resolvedTheme, setMode } = useTheme();
  return (
    <>
      <output data-testid="mode">{mode}</output>
      <output data-testid="resolved">{resolvedTheme}</output>
      <div role="menu">
        <ThemeModePicker mode={mode} onChange={setMode} />
      </div>
    </>
  );
}

function mount() {
  return render(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  installStorage();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-transition");
  document.documentElement.style.colorScheme = "";
  document.documentElement.style.removeProperty("--motion-theme");
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 过场属性是这个组件的「瞬时状态」，读一次就够，别把实现细节写进每个用例。 */
function transitionValue() {
  return document.documentElement.getAttribute("data-theme-transition");
}

describe("主题 Provider", () => {
  it("默认深色并同步到 html", async () => {
    mount();

    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("选择浅色后持久化并更新解析主题", async () => {
    mount();

    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "浅色" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "浅色" }));
    });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(screen.getByTestId("mode").textContent).toBe("light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(window.localStorage.getItem("shuzhi-theme-mode")).toBe("light");
  });

  it("选择跟随系统后保存 system 模式", async () => {
    mount();

    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "跟随系统" }));
    });

    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(window.localStorage.getItem("shuzhi-theme-mode")).toBe("system");
  });
});

describe("主题切换过场（BLF-1292）", () => {
  it("首屏落主题不播过场：bootstrap 写好的浅色不会被默认值盖成深色", async () => {
    window.localStorage.setItem("shuzhi-theme-mode", "light");
    // 模拟 themeBootstrapScript 已经先于 React 把主题写在 <html> 上
    document.documentElement.dataset.theme = "light";

    mount();

    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(transitionValue()).toBeNull();
  });

  it("用户切换时挂上方向性过场，过场结束后属性自动摘掉", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "浅色" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "浅色" }));
    });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(transitionValue()).toBe("to-light");
    expect(document.documentElement.style.getPropertyValue("--motion-theme")).toBe("680ms");

    // 属性只是「过场窗口」，摘掉后全站回到平时的 140ms 交互节奏
    await waitFor(() => expect(transitionValue()).toBeNull(), { timeout: 2000 });
    expect(document.documentElement.style.getPropertyValue("--motion-theme")).toBe("");
  });

  it("切到深色时过场方向相反", async () => {
    window.localStorage.setItem("shuzhi-theme-mode", "light");
    document.documentElement.dataset.theme = "light";
    mount();
    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("light"));

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "深色" }));
    });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(transitionValue()).toBe("to-dark");
  });

  it("减少动效偏好下不挂过场属性，但主题照切换", async () => {
    installMatchMedia({ reduce: true });
    mount();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "浅色" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "浅色" }));
    });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(transitionValue()).toBeNull();
  });

  it("拾取器把当前挡位写进 data-active-index（滑块据此平移）", async () => {
    mount();
    const group = await screen.findByRole("group", { name: "显示模式" });
    expect(group.getAttribute("data-active-index")).toBe("1");

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "浅色" }));
    });
    expect(group.getAttribute("data-active-index")).toBe("0");

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "跟随系统" }));
    });
    expect(group.getAttribute("data-active-index")).toBe("2");
  });
});
