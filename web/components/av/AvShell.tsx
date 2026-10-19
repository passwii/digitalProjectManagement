"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AV_PAGES, AV_WINDOW_TARGET, type AvIconName } from "@/lib/av/navigation";
import { useTheme } from "@/components/theme/ThemeProvider";
import AvGlyph from "./AvGlyph";
import AvGate from "./AvGate";
import s from "./AvShell.module.css";

/** 顶部时钟：默认跟数据集锚点的「实时」演示时间走，避免演示时看到年份错位。 */
function useClock(): { time: string; seconds: string } {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!now) return { time: "--:--:--", seconds: "--" };
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    seconds: pad(now.getSeconds()),
  };
}

const NAV_ICON: Record<string, AvIconName> = {
  overview: "overview",
  monitor: "monitor",
  alarm: "alarm",
  event: "event",
  device: "device",
  capability: "capability",
};

export default function AvShell({
  children,
  onlineRate,
  deviceOnline,
  deviceTotal,
  orgName,
  version,
}: {
  children: React.ReactNode;
  onlineRate?: number;
  deviceOnline?: number;
  deviceTotal?: number;
  orgName: string;
  version: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { resolvedTheme, setMode } = useTheme();
  const clock = useClock();

  useEffect(() => setMobileOpen(false), [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  const groups = useMemo(() => {
    const ordered: { group: string; pages: typeof AV_PAGES[number][] }[] = [];
    for (const page of AV_PAGES) {
      const bucket = ordered.find((entry) => entry.group === page.group);
      if (bucket) bucket.pages.push(page);
      else ordered.push({ group: page.group, pages: [page] });
    }
    return ordered;
  }, []);

  return (
    <div className={`${s.shell} ${collapsed ? s.shellCollapsed : ""} ${mobileOpen ? s.shellOpen : ""}`}>
      {mobileOpen && (
        <button
          type="button"
          className={s.backdrop}
          aria-label="关闭智能音视频平台导航"
          tabIndex={-1}
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={s.sidebar} aria-label="智能音视频平台侧栏">
        <Link className={s.brand} href="/av/overview" aria-label="返回智能音视频平台总览">
          <span className={s.brandMark}>
            <AvGlyph name="wave" size={19} />
          </span>
          <span className={s.brandCopy}>
            <strong>{orgName}</strong>
            <small>AV PLATFORM · {version}</small>
          </span>
        </Link>

        <nav id="av-navigation" className={s.nav} aria-label="智能音视频平台模块">
          {groups.map((entry) => (
            <div key={entry.group}>
              <div className={s.groupLabel}>{collapsed ? "—" : entry.group}</div>
              {entry.pages.map((page) => {
                const active = pathname === page.href || pathname.startsWith(`${page.href}/`);
                return (
                  <Link
                    key={page.slug}
                    href={page.href}
                    className={`${s.navLink} ${active ? s.navActive : ""}`}
                    aria-current={active ? "page" : undefined}
                    title={page.label}
                    onClick={() => setMobileOpen(false)}
                  >
                    <AvGlyph name={NAV_ICON[page.slug] ?? "overview"} size={17} className={s.navIcon} />
                    <span className={s.navText}>{page.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={s.sidebarFoot}>
          <div className={s.footMeta}>
            <span>本地 Mock 数据 · 不连接真实业务系统</span>
            <span>{onlineRate != null ? `在线设备 ${deviceOnline}/${deviceTotal}` : "数据集就绪"}</span>
          </div>
          <button
            type="button"
            className={s.collapseButton}
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <AvGlyph name="collapse" size={15} />
            <span>{collapsed ? "展开" : "收起侧栏"}</span>
          </button>
        </div>
      </aside>

      <div className={s.main}>
        <header className={s.topbar}>
          <button
            type="button"
            className={s.menuButton}
            onClick={() => setMobileOpen(true)}
            aria-label="打开智能音视频平台导航"
            aria-controls="av-navigation"
            aria-expanded={mobileOpen}
          >
            <AvGlyph name="menu" size={18} />
          </button>

          {/* 真搜索：回车跳到告警中心并把关键词带过去（AlarmView 从 ?q= 读初始筛选）。
              之前这里是纯装饰 input，敲字没反应，容易被读成「搜索坏了」。 */}
          <form
            className={s.searchBox}
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = keyword.trim();
              router.push(value ? `/av/alarm?q=${encodeURIComponent(value)}` : "/av/alarm");
            }}
          >
            <AvGlyph name="search" size={15} />
            <input
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索点位、设备、告警编号…（回车进入告警中心）"
              aria-label="搜索点位、设备、告警编号"
            />
            <kbd className={s.searchHint}>↵</kbd>
          </form>

          <div className={s.topbarRight}>
            <span className={s.chip} title="页面内容均为本地 mock 数据">
              <i className={s.chipDot} aria-hidden="true" />
              本地 Mock
            </span>
            {onlineRate != null && (
              <span className={`${s.chip} ${s.rateChip}`} title="设备在线率来自 kpi.online_rate">
                在线率 <strong>{onlineRate.toFixed(1)}%</strong>
              </span>
            )}
            <span className={s.clock} aria-label={`当前时间 ${clock.time}:${clock.seconds}`}>
              {clock.time}
              <span className={s.clockSecond}>:{clock.seconds}</span>
            </span>
            <div className={s.userBadge}>
              <span className={s.avatar} aria-hidden="true">值</span>
              <span className={s.userCopy}>
                <strong>值班台</strong>
                <small>综合安防运营中心</small>
              </span>
            </div>
            <button
              type="button"
              className={s.backLink}
              onClick={() => setMode(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              title={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            >
              {resolvedTheme === "dark" ? "浅色" : "深色"}
            </button>
            {/* prefetch=false：/dashboard 是受保护路由，预取会拿到 /login 的 RSC 响应，
                控制台会留下一条 CORS/Failed to fetch 噪音（AV 是免登录演示站）。 */}
            <Link className={s.backLink} href="/dashboard" title="返回数科云办公" prefetch={false}>
              <AvGlyph name="back" size={14} />
              <span>返回主系统</span>
            </Link>
          </div>
        </header>

        <main className={s.content} id="av-main" tabIndex={-1} data-window-target={AV_WINDOW_TARGET}>
          {children}
        </main>
      </div>

      {/* 可选门禁：只有 /av?gate=1 才会出现，直接访问 /av/overview 不受影响 */}
      <AvGate />
    </div>
  );
}
