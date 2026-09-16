"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authApi, clearSession, type Me } from "@/lib/api";
import Avatar from "@/components/ui/Avatar";
import Bell from "@/components/ui/Bell";
import { ToastProvider } from "@/components/ui/Toast";
import s from "@/components/ui/Shell.module.css";

const NAV = [
  {
    href: "/dashboard",
    label: "工作台",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    href: "/projects",
    label: "项目台账",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 4v5" />
      </svg>
    ),
  },
  {
    href: "/progress",
    label: "进度跟进",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-6 4 4 6-8 3 3" />
        <path d="M3 21h18" />
      </svg>
    ),
  },
  {
    href: "/costs",
    label: "成本支出",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v18M5 7c0-1.5 3-2.5 7-2.5s7 1 7 2.5-3 2.5-7 2.5-7 1-7 2.5 3 2.5 7 2.5 7-1 7-2.5" />
      </svg>
    ),
  },
  {
    href: "/reports",
    label: "报表",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 3h14v18H5z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </svg>
    ),
  },
  {
    href: "/approvals",
    label: "审批中心",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3 8-8" />
        <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
      </svg>
    ),
  },
  {
    href: "/admin",
    label: "系统管理",
    adminOnly: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" />
      </svg>
    ),
  },
];

const CRUMB: Record<string, string> = {
  "/dashboard": "工作台",
  "/projects": "项目台账",
  "/progress": "进度跟进",
  "/costs": "成本支出",
  "/reports": "报表",
  "/approvals": "审批中心",
  "/admin": "系统管理",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const current = Object.keys(CRUMB).find((k) => pathname === k || pathname.startsWith(k + "/"));
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((m) => {
        if (!alive) return;
        setMe(m);
        setIsAdmin(m.roles.some((r) => r.code === "admin"));
        if (m.must_change_pwd) router.replace("/change-password");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [router]);

  const displayName = me?.real_name || me?.username || "当前用户";
  const roleText = me?.roles.map((r) => r.name).join(" / ") || "—";
  const navItems = NAV.filter((n) => !n.adminOnly || isAdmin);

  async function logout() {
    try {
      await authApi.logout();
    } catch {
      // 后端不可用也照常清本地会话
    }
    clearSession();
    router.push("/login");
  }

  return (
    <ToastProvider>
    <div className={`${s.shell} ${collapsed ? s.collapsed : ""}`}>
      <aside className={s.sidebar}>
        <div className={s.ws}>
          <div className={s.wsName} title="项目管理工作区">
            <span className={s.dot} />
            <span className={s.label}>{collapsed ? "PM" : "项目管理工作区"}</span>
          </div>
          <Link className={s.newBtn} href="/projects" title="新建项目">
            {collapsed ? "+" : "+ 新建项目"}
          </Link>
        </div>
        <nav className={s.nav}>
          {navItems.map((n) => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            return (
              <Link key={n.href} href={n.href} className={`${s.navLink} ${active ? s.active : ""}`} title={n.label}>
                {n.icon}
                <span className={s.label}>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className={s.sideFoot}>
          <div className={s.userRow}>
            <Avatar name={displayName} size={28} />
            <div className={s.userMeta}>
              <div className={s.n}>{displayName}</div>
              <div className={s.r} title={roleText}>{roleText}</div>
            </div>
            <button className={s.logoutBtn} onClick={logout}>登出</button>
          </div>
          <button className={s.collapseBtn} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? "展开 »" : "« 收起"}
          </button>
        </div>
      </aside>

      <div className={s.main}>
        <header className={s.topbar}>
          <span className={s.crumb}>工作区 / <b>{current ? CRUMB[current] : "控制台"}</b></span>
          <span className={s.topDate}>{today}</span>
          <Bell />
          <Avatar name={displayName} size={28} />
          <button className={`${s.logoutBtn} no-print`} onClick={logout}>登出</button>
        </header>
        <main className={s.content}>
          <div className={s.contentInner}>{children}</div>
        </main>
      </div>
    </div>
    </ToastProvider>
  );
}
