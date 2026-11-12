// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ThemeProvider from "../components/theme/ThemeProvider";
import DashboardLayout from "../app/(dashboard)/layout";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  logout: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  authApi: { logout: () => mocks.logout() },
  clearSession: vi.fn(),
  notificationsApi: {
    count: () => Promise.resolve({ unread: 0 }),
    list: () => Promise.resolve({ total: 0, unread: 0, page: 1, size: 12, items: [] }),
    read: vi.fn(),
    readAll: vi.fn(),
  },
}));

vi.mock("@/lib/useMeta", () => ({
  clearMetaCache: vi.fn(),
  loadMe: () => Promise.resolve({ must_change_pwd: false }),
  useMe: () => ({
    me: {
      id: 7,
      username: "13800000007",
      real_name: "张伟",
      status: "active",
      dept_id: null,
      roles: [{ code: "member", name: "项目成员" }],
      must_change_pwd: false,
    },
    error: null,
  }),
  useMenus: () => ({
    menus: [{ href: "/projects", label: "项目台账" }],
    isAdmin: false,
    ready: true,
    loading: false,
    error: null,
    reload: vi.fn(),
    canApprove: false,
  }),
}));

vi.mock("@/components/motion/ActivityBar", () => ({ default: () => null }));
vi.mock("@/components/mobile/MobileDock", () => ({ default: () => null }));
vi.mock("@/components/mobile/PullToRefresh", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/motion/MotionProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

function mount() {
  return render(
    <ThemeProvider>
      <DashboardLayout>
        <div>页面内容</div>
      </DashboardLayout>
    </ThemeProvider>,
  );
}

describe("用户菜单主题选择", () => {
  it("保留账号动作并增加三档主题选项", async () => {
    mount();
    const chip = await screen.findByRole("button", { name: "账号菜单：张伟" });
    fireEvent.click(chip);

    expect(screen.getByRole("link", { name: "功能更新" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "修改密码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(screen.getByText("显示模式")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    // 无存储值时默认「跟随系统」，深色不再是隐式默认
    expect(screen.getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("false");
  });

  it("选择浅色后菜单保持打开并更新当前项", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "账号菜单：张伟" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "浅色" }));
    });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(screen.getByRole("dialog", { name: "我的" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "浅色" }).getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("shuzhi-theme-mode")).toBe("light");
  });

  it("「我的」面板是 dialog：通知、账号动作与主题单选同处一个面板", async () => {
    mount();
    const chip = await screen.findByRole("button", { name: "账号菜单：张伟" });
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "我的" });

    // 通知并入「我的」后，面板不再是纯 menuitem 集合，而是可容纳列表的非模态 dialog
    expect(within(dialog).getByRole("heading", { name: "通知" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "功能更新" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "修改密码" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(within(dialog).getByRole("radiogroup", { name: "显示模式" })).toBeTruthy();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
  });
});
