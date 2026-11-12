"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { m, useReducedMotion } from "framer-motion";
import { AV_EASE, AV_MOTION } from "@/lib/av/motion";
import { authApi, clearSession } from "@/lib/api";
import { clearMetaCache, loadMe, useMe, useMenus } from "@/lib/useMeta";
import { identityViewOf } from "@/lib/identityCore";
import { SPARK_WINDOW_TARGET } from "@/lib/spark/navigation";
import { AV_WINDOW_TARGET } from "@/lib/av/navigation";
import { useMobilePwaViewport } from "@/lib/mobilePwaViewport";
import Avatar from "@/components/ui/Avatar";
import ThemeModePicker from "@/components/theme/ThemeModePicker";
import {
  NotificationProvider,
  NotificationSection,
  useNotificationUnread,
} from "@/components/ui/NotificationCenter";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ToastProvider } from "@/components/ui/Toast";
import MotionProvider from "@/components/motion/MotionProvider";
import CenteredNavbar from "@/components/shell/CenteredNavbar";
import MobileBottomDock from "@/components/shell/MobileBottomDock";
import MobileBrandBar from "@/components/shell/MobileBrandBar";
import MobileMoreSheet from "@/components/shell/MobileMoreSheet";
import { MobileShellProvider } from "@/components/shell/MobileShellContext";
import { projectScopedShortcutHrefs, splitNav } from "@/lib/globalNav";
import { PageTitleContext } from "@/components/ui/PageTitleContext";
import s from "@/components/ui/Shell.module.css";
import pwa from "@/components/shell/MobilePwaShell.module.css";

/**
 * 业务菜单由 `/meta/me/menus` 决定（Stage 1 契约）；Spark 与智能音视频平台是独立的静态站点入口。
 * · 管理员额外拿到「审批中心」「系统管理」；
 * · 非管理员不会拿到管理与审批入口，也不会看到必然 403 的按钮。
 * 这里只做 href → 图标/兜底文案的映射，不硬编码角色判断。
 */
const ICON: Record<string, React.ReactNode> = {
  "/dashboard": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  "/projects": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v5" />
    </svg>
  ),
  "/opportunities": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14" />
      <path d="M4 19c0-1.1.9-2 2-2h14M8 8h8M8 12h5" />
      <path d="M8 21h12" />
    </svg>
  ),
  "/assets": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="m3.5 7.8 8.5 4.4 8.5-4.4M12 12.2V21" />
    </svg>
  ),
  "/reports": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3h14v18H5z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  ),
  "/progress": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5M4 19h16" />
      <path d="M8 16v-4M12 16v-8M16 16v-6" />
    </svg>
  ),
  "/costs": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  ),
  "/approvals": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3 8-8" />
      <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </svg>
  ),
  "/admin": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" />
    </svg>
  ),
  "/finance": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-7M20 16V4" />
    </svg>
  ),
  "/contacts": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5z" />
      <path d="M5 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h1M9 9h5M9 13h5" />
      <circle cx="9" cy="8" r="2" />
    </svg>
  ),
  "/spark": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9L12 3Z" />
      <path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
    </svg>
  ),
  "/stream-monitor": (
    // 多模态波形：与云电竞管理平台的四角星刻意区分（同一分组下两条入口要一眼分开）
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12h2l1.4-4.6 1.8 9.2 1.9-12.2 1.8 15 1.7-10.4 1.6 3.1h3.1" />
      <path d="M19 9.5v5M22 11v2" />
    </svg>
  ),
  "/partners": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18" />
    </svg>
  ),
};

const LABEL: Record<string, string> = {
  "/dashboard": "工作台",
  "/projects": "项目台账",
  "/opportunities": "商机管理",
  "/progress": "进度跟踪",
  "/costs": "支出记录",
  "/assets": "资产管理",
  "/reports": "支出报表",
  "/approvals": "审批中心",
  "/contacts": "通讯录",
  "/partners": "我的友商",
  "/changelog": "功能更新",
  "/admin": "系统管理",
  "/finance": "财务管理",
  "/dev/date-picker": "日期组件",
  "/spark": "云电竞管理平台",
  "/stream-monitor": "智能音视频平台",
};

/** 工作台恒可见；权限同步失败时退回这组参与性入口，绝不因同步失败就清空导航 */
const BASE_HREFS = ["/dashboard", "/opportunities", "/projects", "/assets", "/reports"];

interface NavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  external?: boolean;
  target?: string;
}

/**
 * 鼠标从 chip 移到面板要跨过 8px 间隙，立刻关会「碰一下就闪」；留一段容错时间，
 * 期间移进面板（mouseenter 冒泡到同一容器）会取消关闭。
 */
const MENU_CLOSE_DELAY = 180;

/**
 * 顶栏右上角身份区：头像 + 姓名，hover / focus / tap 出「我的」面板（BLF-1141）。
 *
 * 身份与账号操作原本挤在侧栏底部（`sideFoot`），用户反馈那一块是冗余的（尤其
 * 「全局管理与审批」这类角色权限文案），这里把**账号操作**搬到顶栏：
 *   · hover 进 chip 或面板 → 打开；移出 → 延时关闭（跨间隙不闪）；
 *   · 键盘 Tab 聚焦 chip → 打开，Enter / Space 把焦点送进面板，Esc 关闭并还焦；
 *   · 触屏（≤767px 没有 hover，且 chip 文字被 CSS 隐藏）→ tap 头像打开同一个面板；
 *   · 关闭时面板**不渲染**（而不是 visibility 隐藏），所以不在 Tab 序列里。
 *
 * 面板同时承载通知（列表 / 未读 / 已读 / 深链），所以语义是**非模态 dialog** 而不是
 * 纯 menu：里面既有列表按钮，也有账号链接与显示模式单选组，用普通 Tab 顺序浏览。
 * 角色 / 权限文案（`identity.role` / `roleShort`）不再出现在这里，也不出现在 chip 上。
 */
function UserMenu({ name, onLogout }: { name: string | null; onLogout: () => void }) {
  const { mode, setMode } = useTheme();
  const { unread } = useNotificationUnread();
  const notificationHeadingId = useId();
  /** 未读数的可读描述：徽标本身对读屏隐藏，名称保持稳定（不随未读数变化）。 */
  const unreadDescriptionId = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 面板节点：Enter / Space 从 chip 进入面板时，聚焦面板里的第一个可交互项 */
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 指针按下过：tap / click 也会触发 focus，不能让 focus 先开、click 再关（触屏会打不开菜单） */
  const pointerDown = useRef(false);
  /** Esc 还焦给 chip 时会触发它的 focus 处理器：跳过那一次自动展开，见 onKey 里的注释 */
  const skipFocusOpen = useRef(false);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openMenu = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const closeMenu = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);
  const closeLater = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, MENU_CLOSE_DELAY);
  }, [cancelClose]);

  // 卸载（例如登出跳转途中）时清掉待执行的关闭定时器
  useEffect(() => cancelClose, [cancelClose]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      // Esc 关闭并把焦点还给 chip，键盘用户不丢位置。
      // 还焦会同步触发 chip 的 focus 处理器，用一次性标记让它别再展开 ——
      // 否则 Esc 关掉的菜单会被这次还焦立刻重新打开。
      if (e.key === "Escape") {
        skipFocusOpen.current = true;
        closeMenu();
        chipRef.current?.focus();
        // chip 本来就持有焦点时 focus() 不发事件（标记没被消费），下一轮清掉
        setTimeout(() => {
          skipFocusOpen.current = false;
        }, 0);
      }
    }
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeMenu();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, closeMenu]);

  return (
    <div
      className={s.userChipWrap}
      ref={wrapRef}
      onMouseEnter={openMenu}
      onMouseLeave={() => {
        // 指针中途离开（按下后拖走）也要复位，否则下一次键盘聚焦打不开菜单
        pointerDown.current = false;
        closeLater();
      }}
      onBlur={(e) => {
        // 焦点在身份区内移动（chip ↔ 菜单项）不关，离开整块才关
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) closeMenu();
      }}
    >
      <button
        ref={chipRef}
        type="button"
        className={s.userChip}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={name === null ? "账号菜单，身份加载中" : `账号菜单：${name}`}
        aria-describedby={unread > 0 ? unreadDescriptionId : undefined}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onFocus={() => {
          // 还焦 / 指针引起的 focus 不该展开菜单，只有键盘主动聚焦才展开
          if (skipFocusOpen.current || pointerDown.current) {
            skipFocusOpen.current = false;
            pointerDown.current = false;
            return;
          }
          openMenu();
        }}
        onClick={() => {
          pointerDown.current = false;
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={(e) => {
          // 键盘聚焦已经把面板打开了：Enter / Space 顺势把焦点送进面板，
          // 而不是触发按钮默认行为把刚看到的面板又关掉。
          if ((e.key === "Enter" || e.key === " ") && open) {
            e.preventDefault();
            panelRef.current?.querySelector<HTMLElement>("a[href], button:not(:disabled)")?.focus();
          }
        }}
      >
        {name === null ? (
          <>
            <span className={`skel ${s.avatarSkel}`} aria-hidden="true" />
            <span className={s.userChipText}>
              <span className={`skel ${s.nameSkel}`} aria-hidden="true" />
              <small className="sr-only">身份加载中</small>
            </span>
          </>
        ) : (
          <>
            <Avatar name={name} size={30} />
            <span className={s.userChipText}>
              <b>{name}</b>
            </span>
          </>
        )}
        {/* 身份还在加载时也照样显示未读数：通知不依赖姓名先到。 */}
        {unread > 0 && (
          <span className={s.userChipBadge} data-unread-badge aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {/*
        未读数的可读描述挂在 chip 上（aria-describedby），而不是改名按钮：名字保持
        「账号菜单：姓名」稳定，读屏用户聚焦时仍能听到「N 条未读通知」。徽标只有
        视觉作用，对读屏隐藏，避免数字被念两遍。
      */}
      {unread > 0 && (
        <span id={unreadDescriptionId} className="sr-only">
          {unread} 条未读通知
        </span>
      )}

      {open && (
        <div
          ref={panelRef}
          className={s.userMenu}
          role="dialog"
          aria-label="我的"
        >
          {/*
            通知整体并入「我的」：不再有独立铃铛。区域标题 + 未读数 + 全部已读在上方，
            列表在菜单里直接可读、可点、可深链；账号操作与显示模式仍在下方。
          */}
          <NotificationSection headingId={notificationHeadingId} onNavigate={closeMenu} />
          <div className={s.userMenuDivider} role="none" />
          <Link href="/changelog" className={s.userMenuItem} onClick={closeMenu}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16M4 12h10M4 19h7" />
              <path d="M17 14v6M14 17h6" />
            </svg>
            功能更新
          </Link>
          <Link href="/change-password" className={s.userMenuItem} onClick={closeMenu}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="15" r="4" />
              <path d="M10.9 12.1L20 3M17 6l2.5 2.5M14.5 8.5L17 11" />
            </svg>
            修改密码
          </Link>
          <button
            type="button"
            className={`${s.userMenuItem} ${s.userMenuItemDanger}`}
            onClick={() => {
              closeMenu();
              onLogout();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
            退出登录
          </button>
          <ThemeModePicker mode={mode} onChange={setMode} />
        </div>
      )}
    </div>
  );
}

/** 侧栏（桌面外壳）与 Dock（手机外壳）共用的同一份权限状态，避免两个外壳各自取一次 */
function DashboardShell({ children, modal }: { children: React.ReactNode; modal?: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, error: meError } = useMe();
  const { menus, isAdmin, ready: permsReady, error: permsError, reload: reloadMenus } = useMenus();
  const reduced = useReducedMotion();
  /**
   * 手机形态下两个独立站点的入口**不带** `target`（BLF-1389）。
   *
   * 桌面端 `target` 是有意为之：两个站点各有自己的浏览上下文
   * （`spark-platform` / `stream-monitor`），桌面用户能同时开两个窗口对比。
   * 但手机端 `target` 会开出一堆新标签页 —— 屏幕底部多一条地址栏，
   * 回主工作台要连点好几次「返回」，而且 standalone 下（无地址栏）用户
   * 根本不知道自己「跳」到了另一个标签页。
   */
  const mobileViewport = useMobilePwaViewport();
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);

  // 路由变化后「更多」sheet 不应留在原地。
  useEffect(() => {
    setMobileMoreOpen(false);
  }, [pathname]);

  const current = Object.keys(LABEL).find((k) => pathname === k || pathname.startsWith(k + "/"));
  const [registeredTitle, setRegisteredTitle] = useState<{ pathname: string; title: string } | null>(null);
  const pageTitle = registeredTitle?.pathname === pathname
    ? registeredTitle.title
    : current ? LABEL[current] : "控制台";
  const registerPageTitle = useCallback((title: string) => {
    setRegisteredTitle((previous) =>
      previous?.pathname === pathname && previous.title === title
        ? previous
        : { pathname, title },
    );
  }, [pathname]);

  const navItems = useMemo<NavItem[]>(() => {
    // Spark 是本地静态入口，不属于后端权限菜单。
    const fromMenus = menus
      .filter((m) => m.href !== "/spark")
      .map((m) => ({ href: m.href, label: m.label || LABEL[m.href] || m.href }));
    // 权限同步失败时才退回参与性入口并提示重试；空菜单是合法的「未分配任何模块」，
    // 此时只保留恒可见的工作台与本地 Spark 入口（Stage 5：模块按用户手动分配）。
    // 进度/支出是项目台账的子视图，后端没有独立模块；有项目权限时补进主入口，
    // 没有项目权限时保持「更多」里的真实模块，不凭空暴露 403 页面。
    const shortcuts = projectScopedShortcutHrefs(fromMenus).map((href) => ({
      href,
      label: LABEL[href],
      icon: ICON[href],
    }));
    const list = permsError
      ? BASE_HREFS.map((href) => ({ href, label: LABEL[href] }))
      : [{ href: "/dashboard", label: LABEL["/dashboard"] }, ...fromMenus, ...shortcuts];
    const out: NavItem[] = [];
    for (const it of list) {
      if (out.some((o) => o.href === it.href)) continue;
      out.push({ ...it, icon: ICON[it.href] });
    }
    // Spark 分组下两条独立站点入口：云电竞管理平台与智能音视频平台。
    // 两者是完全不同的产品，各自一个 target，互不抢同一个标签页。
    out.push({ href: "/spark", label: LABEL["/spark"], icon: ICON["/spark"], external: true, target: mobileViewport ? undefined : SPARK_WINDOW_TARGET });
    out.push({ href: "/stream-monitor", label: LABEL["/stream-monitor"], icon: ICON["/stream-monitor"], external: true, target: mobileViewport ? undefined : AV_WINDOW_TARGET });
    return out;
  }, [menus, permsError, mobileViewport]);

  // 「更多」sheet 的溢出项与底部 dock 共用同一份 splitNav 投影，不另维护一份菜单。
  const mobileOverflow = useMemo(() => splitNav(navItems, pathname).overflow, [navItems, pathname]);
  const openMore = useCallback(() => setMobileMoreOpen(true), []);
  const closeMore = useCallback(() => setMobileMoreOpen(false), []);

  useEffect(() => {
    // must_change_pwd 的强制跳转仍在这里；复用 `loadMe()` 而不是再直接打一次
    // `/auth/me`（它与 useMe 共享内存缓存与 inflight，同一会话只发一次请求）。
    let alive = true;
    loadMe()
      .then((m) => {
        if (alive && m.must_change_pwd) window.location.replace("/change-password");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 身份区展示文案（BLF-1125）。
   *
   * 未确认时 `identity.name` 为 `null`——渲染骨架，不再用 `|| "当前用户"` 顶上。
   * 旧写法的 `"当前用户"` 会被 `next build` 静态预渲染进 HTML（实测 dashboard.html
   * 里出现 4 次），刷新时浏览器先画出假名字，等 `/auth/me` 回来才变成真名。
   */
  const identity = identityViewOf({
    me,
    isAdmin: permsReady ? isAdmin : null,
    permsFailed: Boolean(permsError),
    identityFailed: Boolean(meError),
  });
  // 取出为局部常量：TS 才能在 `name !== null` 分支里把类型缩窄给 <Avatar> 用。
  // BLF-1141：外壳只消费姓名 —— 角色权限文案不再是展示内容（用户反馈为冗余信息），
  // 所以这里不再解构 role / roleShort，派生逻辑仍留在 identityViewOf 供其它调用方使用。
  const { name: displayName } = identity;

  async function logout() {
    try {
      await authApi.logout();
    } catch {
      // 后端不可用也照常清本地会话
    }
    clearMetaCache();
    clearSession();
    router.push("/login");
  }

  return (
    <>
    <PageTitleContext.Provider value={registerPageTitle}>
      <MobileShellProvider navItems={navItems} openMore={openMore}>
      <div
        className={`${s.shell} ${pwa.shell}`}
        data-console-shell="true"
        data-console-route={pathname}
        data-dashboard-shell={pathname === "/dashboard" ? "true" : undefined}
      >
        <a className="skip-link" href="#main-content">跳到主要内容</a>

        <div className={pwa.brandFloatSlot}>
          <Link href="/dashboard" className={s.brandFloat} aria-label="数科云办公首页">
            <span className={s.brandSeal} aria-hidden="true">
              <span className={s.brandSealWord}>SHZK</span>
              <span className={s.brandSealBar} />
            </span>
            <span className={s.brandText}><b>数科云办公</b></span>
          </Link>
        </div>

        <MobileBrandBar />

        <div className={pwa.navDockSlot}>
          <div className={s.navDock}>
            <CenteredNavbar
              items={navItems}
              activeHref={pathname}
              permsError={Boolean(permsError)}
              onRetry={reloadMenus}
            />
          </div>
        </div>

        {/* 顶栏只有账号浮标：通知入口 / 未读数 / 列表都在「我的」菜单里，不再单列铃铛。 */}
        <div className={`${s.accountDock} ${pwa.accountDock}`}>
          <UserMenu name={displayName} onLogout={logout} />
        </div>

        <div className={`${s.main} ${pwa.main}`}>
          <main className={`${s.content} ${pwa.content}`} id="main-content" tabIndex={-1}>
            <div className={s.contentInner}>
              {pathname !== "/dashboard" && (
                <div className={s.pageHeading} aria-hidden="true">{pageTitle}</div>
              )}
              <m.div
                key={pathname}
                className={`${s.routeView} ${pwa.routeView}`}
                initial={reduced ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduced ? 0 : AV_MOTION.base, ease: AV_EASE.enter }}
              >
                {children}
              </m.div>
            </div>
          </main>
        </div>
        {modal}

        <MobileBottomDock
          items={navItems}
          activeHref={pathname}
          moreOpen={mobileMoreOpen}
          onMoreClick={openMore}
          loading={!permsReady && !Boolean(permsError)}
        />
        <MobileMoreSheet
          open={mobileMoreOpen}
          onClose={closeMore}
          items={mobileOverflow}
          accountName={displayName}
          onLogout={logout}
          permsError={Boolean(permsError)}
          onRetry={reloadMenus}
        />
      </div>
      </MobileShellProvider>
    </PageTitleContext.Provider>
    </>
  );
}

export default function DashboardLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal?: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <MotionProvider>
        {/* 未读数只在外壳轮询一次；账号菜单与手机「更多」sheet 共享同一份状态。 */}
        <NotificationProvider>
          <DashboardShell modal={modal}>{children}</DashboardShell>
        </NotificationProvider>
      </MotionProvider>
    </ToastProvider>
  );
}
