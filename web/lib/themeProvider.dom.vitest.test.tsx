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

beforeEach(() => {
  installStorage();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("主题 Provider", () => {
  it("默认深色并同步到 html", async () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("选择浅色后持久化并更新解析主题", async () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

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
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "跟随系统" }));
    });

    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(window.localStorage.getItem("shuzhi-theme-mode")).toBe("system");
  });
});
