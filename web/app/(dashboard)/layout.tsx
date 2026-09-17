"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { authApi, clearSession, type Me } from "@/lib/api";
import { clearMetaCache, useMenus } from "@/lib/useMeta";
import Avatar from "@/components/ui/Avatar";
import Bell from "@/components/ui/Bell";
import { ToastProvider } from "@/components/ui/Toast";
import ActivityBar from "@/components/motion/ActivityBar";
import MotionProvider, { useNavigationActivity } from "@/components/motion/MotionProvider";
import s from "@/components/ui/Shell.module.css";

/**
 * 导航单一入口：菜单项由 `/meta/me/menus` 决定（Stage 1 契约）。
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
  "/progress": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l5-6 4 4 6-8 3 3" />
      <path d="M3 21h18" />
    </svg>
  ),
  "/costs": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 5l5 7 5-7M12 12v7M8 13h8M8 16h8" />
    </svg>
  ),
  "/reports": (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3h14v18H5z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
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
};

const LABEL: Record<string, string> = {
  "/dashboard": "工作台",
  "/projects": "项目台账",
  "/progress": "进度跟踪",
  "/costs": "支出记录",
  "/reports": "支出报表",
  "/approvals": "审批中心",
  "/admin": "系统管理",
};

/** 工作台恒可见（非管理与审批入口）；权限同步失败时退回这组参与性入口，绝不默认放行管理入口 */
const BASE_HREFS = ["/dashboard", "/projects", "/progress", "/costs", "/reports"];
const ADMIN_HREFS = ["/approvals", "/admin"];

const CRUMB: Record<string, string> = LABEL;

interface NavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const { menus, isAdmin, loading: permsLoading, error: permsError, reload: reloadMenus } = useMenus();
  const { startNavigation } = useNavigationActivity();
  const reduced = useReducedMotion();

  const current = Object.keys(CRUMB).find((k) => pathname === k || pathname.startsWith(k + "/"));
  const today = new Date().toISOString().slice(0, 10);

  const navItems = useMemo<NavItem[]>(() => {
    const fromMenus = menus.map((m) => ({ href: m.href, label: m.label || LABEL[m.href] || m.href }));
    // 权限同步失败（或菜单为空）：只保留参与性入口并提示重试，绝不猜测管理员身份
    const list = permsError || menus.length === 0
      ? BASE_HREFS.map((href) => ({ href, label: LABEL[href] }))
      : [{ href: "/dashboard", label: LABEL["/dashboard"] }, ...fromMenus];
    const out: NavItem[] = [];
    for (const it of list) {
      if (out.some((o) => o.href === it.href)) continue;
      out.push({ ...it, icon: ICON[it.href] });
    }
    return out;
  }, [menus, permsError]);

  useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((m) => {
        if (!alive) return;
        setMe(m);
        if (m.must_change_pwd) router.replace("/change-password");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [router]);

  const displayName = me?.real_name || me?.username || "当前用户";
  const roleText = isAdmin
    ? "管理员 · 全局管理与审批"
    : "普通用户 · 参与项目业务";
  const roleTip = isAdmin
    ? "管理员是唯一的管理与审批角色，可跨部门、跨项目查看与处理管理数据"
    : me?.roles.length
    ? `角色：${me.roles.map((r) => r.name).join(" / ")}（当前仅参与项目业务，无管理与审批权限）`
    : "当前账号无管理与审批权限，仅参与项目业务";

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
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <div className={`${s.shell} ${collapsed ? s.collapsed : ""}`}>
      <aside className={s.sidebar}>
        <div className={s.ws}>
          <div className={s.wsName} title="数科云办公">
            <span className={s.brandSeal}>SHZK</span>
            <span className={s.brandText}>
              <b>数科云办公</b>
            </span>
          </div>
        </div>
        <nav className={s.nav} aria-label="主导航" aria-busy={permsLoading}>
          {navItems.map((n, i) => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            const prev = navItems[i - 1]?.href ?? "";
            const startsAdminGroup = ADMIN_HREFS.includes(n.href) && !ADMIN_HREFS.includes(prev);
            return (
              <Fragment key={n.href}>
                {startsAdminGroup && (
                  <span className={s.navGroupLabel} title="仅管理员可见" aria-hidden={collapsed}>
                    {collapsed ? "——" : "管理与审批"}
                  </span>
                )}
                <Link
                  href={n.href}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.currentTarget.target === "_blank" ||
                      event.currentTarget.hasAttribute("download") ||
                      active
                    ) {
                      return;
                    }
                    startNavigation(n.label, n.href);
                  }}
                  className={`${s.navLink} ${active ? s.active : ""}`}
                  title={n.label}
                  aria-current={active ? "page" : undefined}
                >
                  {n.icon}
                  <span className={s.label}>{n.label}</span>
                  {active && (
                    <m.span
                      layoutId="primary-nav-active"
                      className={s.navActive}
                      transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0.72, 0.2, 1] }}
                    />
                  )}
                </Link>
              </Fragment>
            );
          })}
        </nav>
        {permsError && (
          <div className={s.navError} role="alert">
            <span>权限信息加载失败，仅显示基础入口。</span>
            <button className={s.navRetry} onClick={reloadMenus}>重试</button>
          </div>
        )}
        <div className={s.sideFoot}>
          <div className={s.userRow}>
            <Avatar name={displayName} size={28} />
            <div className={s.userMeta}>
              <div className={s.n}>{displayName}</div>
              <div className={s.r} title={roleTip}>{roleText}</div>
            </div>
            <button className={s.logoutBtn} onClick={logout} aria-label="退出登录">登出</button>
          </div>
          <button
            className={s.collapseBtn}
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {collapsed ? "展开 »" : "« 收起"}
          </button>
        </div>
      </aside>

      <div className={s.main}>
        <header className={s.topbar}>
          <div className={s.topContext}>
            <span className={s.crumb}>数科云办公 / <b>{current ? CRUMB[current] : "控制台"}</b></span>
          </div>
          <div className={s.topActions}>
            <span className={s.topDate}>{today}</span>
            <Bell />
            <div className={s.userChip}>
              <Avatar name={displayName} size={30} />
              <span className={s.userChipText}>
                <b>{displayName}</b>
                <small>{isAdmin ? "管理员" : "项目成员"}</small>
              </span>
            </div>
          </div>
          <ActivityBar />
        </header>
        <main className={s.content} id="main-content" tabIndex={-1}>
          <div className={s.contentInner}>
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={pathname}
                className={s.routeView}
                initial={reduced ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
                transition={{ duration: reduced ? 0 : 0.22, ease: [0.2, 0.72, 0.2, 1] }}
              >
                {children}
              </m.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
    </>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <MotionProvider>
        <DashboardShell>{children}</DashboardShell>
      </MotionProvider>
    </ToastProvider>
  );
}
