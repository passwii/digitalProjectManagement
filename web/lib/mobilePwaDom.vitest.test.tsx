// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const notificationMocks = vi.hoisted(() => ({
  count: vi.fn((_signal?: AbortSignal) => Promise.resolve({ unread: 2 })),
  list: vi.fn((_query?: string, _signal?: AbortSignal) =>
    Promise.resolve({
      total: 1,
      unread: 2,
      page: 1,
      size: 12,
      items: [
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
      ],
    }),
  ),
  read: vi.fn((_id?: number) => Promise.resolve({ ok: true })),
  readAll: vi.fn(() => Promise.resolve({ ok: true, read: 1 })),
}));

vi.mock("@/lib/api", () => ({
  errText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  notificationsApi: {
    count: () => notificationMocks.count(),
    list: (query = "", signal?: AbortSignal) => notificationMocks.list(query, signal),
    read: (id: number) => notificationMocks.read(id),
    readAll: () => notificationMocks.readAll(),
  },
}));

vi.mock("@/components/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "dark", setMode: vi.fn() }),
}));

vi.mock("@/lib/useMeta", () => ({
  useMe: () => ({ displayName: "张伟", me: null }),
  useMenus: () => ({ ready: true, loading: false }),
}));

import MobileBottomDock from "@/components/shell/MobileBottomDock";
import MobileMoreSheet from "@/components/shell/MobileMoreSheet";
import MobileHome from "@/components/dashboard/MobileHome";
import { MobileShellProvider } from "@/components/shell/MobileShellContext";
import { NotificationProvider } from "@/components/ui/NotificationCenter";
import type { ShellNavItem } from "@/lib/globalNav";

const MENUS: ShellNavItem[] = [
  { href: "/dashboard", label: "工作台" },
  { href: "/projects", label: "项目台账" },
  { href: "/progress", label: "进度跟踪" },
  { href: "/costs", label: "支出记录" },
  { href: "/approvals", label: "审批中心" },
  { href: "/opportunities", label: "商机管理" },
  { href: "/assets", label: "资产管理" },
  { href: "/reports", label: "支出报表" },
  { href: "/contacts", label: "通讯录" },
  { href: "/partners", label: "我的友商" },
  { href: "/spark", label: "云电竞管理平台" },
  { href: "/stream-monitor", label: "智能音视频平台" },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MobileBottomDock：六槽底部导航", () => {
  it("渲染 5 个权限主入口 + 更多，并标记当前项", () => {
    const onMore = vi.fn();
    render(
      <MobileBottomDock
        items={MENUS}
        activeHref="/projects/42"
        moreOpen={false}
        onMoreClick={onMore}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "手机主导航" });
    expect(nav.querySelectorAll("[data-dock]")).toHaveLength(6);
    expect(nav.textContent).toContain("工作台");
    expect(nav.textContent).toContain("项目台账");
    expect(nav.textContent).toContain("进度跟踪");
    expect(nav.textContent).toContain("支出记录");
    expect(nav.textContent).toContain("审批中心");
    expect(nav.textContent).toContain("更多");

    const active = nav.querySelectorAll('[data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-dock")).toBe("/projects");
    expect(active[0].getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("权限加载中补足槽位占位，首屏不闪成两槽", () => {
    render(
      <MobileBottomDock
        items={[{ href: "/dashboard", label: "工作台" }]}
        activeHref="/dashboard"
        moreOpen={false}
        onMoreClick={vi.fn()}
        loading
      />,
    );
    const nav = screen.getByRole("navigation", { name: "手机主导航" });
    expect(nav.querySelectorAll("[data-dock-ghost]")).toHaveLength(4);
    expect(nav.querySelectorAll("[data-dock]")).toHaveLength(2);
  });

  it("溢出页把「更多」标为当前项", () => {
    render(
      <MobileBottomDock items={MENUS} activeHref="/contacts" moreOpen={false} onMoreClick={vi.fn()} />,
    );
    const more = screen.getByRole("button", { name: "更多" });
    expect(more.getAttribute("data-active")).toBe("true");
  });
});

describe("MobileMoreSheet：焦点、Esc 与账号区", () => {
  function Host({
    onClose = vi.fn(),
    permsError = false,
    onRetry,
  }: {
    onClose?: () => void;
    permsError?: boolean;
    onRetry?: () => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>打开更多</button>
        <MobileMoreSheet
          open={open}
          onClose={() => { setOpen(false); onClose(); }}
          items={MENUS.filter((item) => ["/contacts", "/assets", "/spark"].includes(item.href))}
          accountName="张伟"
          onLogout={vi.fn()}
          permsError={permsError}
          onRetry={onRetry}
        />
      </>
    );
  }

  it("打开后是模态 dialog，渲染真实溢出项与账号入口", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "打开更多" }));

    const dialog = screen.getByRole("dialog", { name: "更多" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("link", { name: "通讯录" }).getAttribute("href")).toBe("/contacts");
    expect(screen.getByRole("link", { name: "资产管理" })).toBeTruthy();
    expect(screen.getByText("张伟")).toBeTruthy();
    expect(screen.getByRole("link", { name: "修改密码" }).getAttribute("href")).toBe("/change-password");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
  });

  it("账号区提供「通知」入口，展开后显示列表，且不再有独立铃铛", async () => {
    render(
      <NotificationProvider>
        <Host />
      </NotificationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开更多" }));
    const dialog = screen.getByRole("dialog", { name: "更多" });

    // 旧实现是顶栏一颗独立铃铛；并入账号区后不应再出现那个按钮
    expect(screen.queryByRole("button", { name: /^通知，/ })).toBeNull();

    const toggle = screen.getByRole("button", { name: "通知" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(toggle.textContent).toContain("2"));

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("任务逾期提醒")).toBeTruthy();
    expect(dialog.contains(screen.getByText("任务逾期提醒"))).toBe(true);
    expect(notificationMocks.list).toHaveBeenCalled();
  });

  it("权限菜单加载失败时，在 sheet 内保留可见重试", () => {
    const onRetry = vi.fn();
    render(<Host permsError onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "打开更多" }));

    expect(screen.getByRole("alert").textContent).toContain("权限菜单加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Esc 请求关闭（由 useModalBehavior 统一处理）", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "打开更多" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭后焦点回到打开它的「更多」按钮", async () => {
    vi.useFakeTimers();
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "打开更多" });
    trigger.focus();
    fireEvent.click(trigger);

    // 初始焦点落在 sheet 内（不是关闭按钮），Tab 陷阱才生效。
    expect(screen.getByRole("dialog", { name: "更多" }).contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "关闭更多" }));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("MobileHome：移动首页", () => {
  it("用真实 userName 问候，并按权限渲染四张入口卡与 quick rows", () => {
    const openMore = vi.fn();
    render(
      <MobileShellProvider navItems={MENUS} openMore={openMore}>
        <MobileHome />
      </MobileShellProvider>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("你好，张伟");
    expect(document.querySelectorAll("[data-mobile-entry]")).toHaveLength(4);
    expect(screen.getByText("统一台账")).toBeTruthy();
    expect(screen.getByText("进度留痕")).toBeTruthy();
    expect(screen.getByText("支出归集")).toBeTruthy();
    expect(screen.getByText("审批协同")).toBeTruthy();
    expect(screen.getByRole("link", { name: /通讯录/ }).getAttribute("href")).toBe("/contacts");
    expect(screen.getByRole("link", { name: /新建项目/ }).getAttribute("href")).toBe("/projects");

    fireEvent.click(screen.getByRole("button", { name: /全部入口/ }));
    expect(openMore).toHaveBeenCalledTimes(1);
  });
});
