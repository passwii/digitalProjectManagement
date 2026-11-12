// @vitest-environment jsdom
/**
 * 通知并入账号「我的」菜单（不再有独立铃铛）。
 *
 * 用户在右上角只想看到「账号」一个入口；通知的未读数、列表、已读与深链都搬进
 * 这个菜单。这里用真实 DashboardLayout 渲染，钉住三件事：
 *   1. 顶栏不再出现独立通知按钮，未读数改由账号入口的徽标 + 可读描述承担；
 *   2. 打开菜单即可看到通知区域、列表与「全部已读」；
 *   3. 点击通知仍然标记已读并落到具体业务对象，菜单随之收起。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  logout: vi.fn(() => Promise.resolve({ ok: true })),
  count: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  authApi: { logout: () => mocks.logout() },
  clearSession: vi.fn(),
  errText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  notificationsApi: {
    count: (...args: unknown[]) => mocks.count(...args),
    list: (...args: unknown[]) => mocks.list(...args),
    read: (...args: unknown[]) => mocks.read(...args),
    readAll: () => mocks.readAll(),
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

vi.mock("@/components/motion/MotionProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ThemeProvider from "../components/theme/ThemeProvider";
import DashboardLayout from "../app/(dashboard)/layout";

const NOTIFICATIONS = [
  {
    id: 11,
    type: "task",
    title: "任务逾期提醒",
    body: "「官网改版」有 2 个任务已逾期",
    ref_type: "task",
    ref_id: 101,
    project_id: 7,
    read: false,
    created_at: "2026-11-11T09:30:00+08:00",
  },
  {
    id: 12,
    type: "expense",
    title: "支出待审批",
    body: "差旅报销待审批",
    ref_type: "expense",
    ref_id: 9,
    project_id: 7,
    read: false,
    created_at: "2026-11-11T08:00:00+08:00",
  },
  {
    id: 13,
    type: "project",
    title: "项目已归档",
    body: "",
    ref_type: "project",
    ref_id: 7,
    project_id: 7,
    read: true,
    created_at: "2026-11-10T18:00:00+08:00",
  },
];

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

function mount() {
  return render(
    <ThemeProvider>
      <DashboardLayout>
        <div>页面内容</div>
      </DashboardLayout>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  installStorage();
  document.documentElement.removeAttribute("data-theme");
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
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.count.mockReset();
  mocks.list.mockReset();
  mocks.read.mockReset();
  mocks.readAll.mockReset();
  mocks.count.mockResolvedValue({ unread: 2 });
  mocks.list.mockResolvedValue({
    total: NOTIFICATIONS.length,
    unread: 2,
    page: 1,
    size: 12,
    items: NOTIFICATIONS,
  });
  mocks.read.mockResolvedValue({ ok: true });
  mocks.readAll.mockResolvedValue({ ok: true, read: 2 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function signedInChip() {
  const chip = await screen.findByRole("button", { name: "账号菜单：张伟" });
  await waitFor(() => expect(screen.getByText("2 条未读通知")).toBeTruthy());
  return chip;
}

describe("通知并入「我的」菜单", () => {
  it("顶栏不再渲染独立铃铛，未读数挂在账号入口上", async () => {
    mount();
    const chip = await signedInChip();

    // 旧的独立铃铛按钮（aria-label「通知，N 条未读」）与通知面板触发方式都不存在了
    expect(screen.queryByRole("button", { name: /^通知，/ })).toBeNull();
    expect(document.querySelector('[aria-haspopup="dialog"][aria-label^="通知"]')).toBeNull();

    const badge = chip.querySelector("[data-unread-badge]");
    expect(badge?.textContent).toBe("2");
    expect(chip.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("打开「我的」菜单即可看到通知区域、未读数与列表", async () => {
    mount();
    const chip = await signedInChip();
    fireEvent.click(chip);

    const menu = await screen.findByRole("dialog", { name: "我的" });
    expect(within(menu).getByRole("heading", { name: "通知" })).toBeTruthy();
    await waitFor(() => expect(within(menu).getByText("2 条未读")).toBeTruthy());
    expect(within(menu).getByText("任务逾期提醒")).toBeTruthy();
    expect(within(menu).getByText("支出待审批")).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "全部已读" })).toBeTruthy();
    // 通知列表本身不再是个独立弹层，只是「我的」面板里的一个区域
    expect(within(menu).queryByRole("dialog")).toBeNull();
  });

  it("点击未读通知会标记已读、深链到业务对象并收起菜单", async () => {
    mount();
    const chip = await signedInChip();
    fireEvent.click(chip);

    const menu = await screen.findByRole("dialog", { name: "我的" });
    const item = await within(menu).findByRole("button", { name: /任务逾期提醒/ });
    await act(async () => {
      fireEvent.click(item);
    });

    expect(mocks.read).toHaveBeenCalledWith(11);
    expect(mocks.push).toHaveBeenCalledWith("/progress?project_id=7&task=101");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "我的" })).toBeNull());
  });

  it("「全部已读」清空未读，徽标随之消失", async () => {
    mount();
    const chip = await signedInChip();
    fireEvent.click(chip);

    const menu = await screen.findByRole("dialog", { name: "我的" });
    await within(menu).findByRole("button", { name: /任务逾期提醒/ });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("button", { name: "全部已读" }));
    });

    expect(mocks.readAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(menu).getByText("无未读")).toBeTruthy());
    expect(chip.querySelector("[data-unread-badge]")).toBeNull();
  });

  it("通知列表加载失败时在菜单内提示并可重试", async () => {
    mocks.list.mockRejectedValueOnce(new Error("通知服务不可用")).mockResolvedValue({
      total: NOTIFICATIONS.length,
      unread: 2,
      page: 1,
      size: 12,
      items: NOTIFICATIONS,
    });

    mount();
    const chip = await signedInChip();
    fireEvent.click(chip);

    const menu = await screen.findByRole("dialog", { name: "我的" });
    const alert = await within(menu).findByRole("alert");
    expect(alert.textContent).toContain("通知服务不可用");

    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    });
    await waitFor(() => expect(within(menu).getByText("任务逾期提醒")).toBeTruthy());
  });
});
