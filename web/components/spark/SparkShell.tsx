"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SPARK_PAGES } from "@/lib/spark/navigation";
import SparkGlyph from "./SparkGlyph";
import s from "./SparkShell.module.css";

export default function SparkShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  let lastGroup = "";

  return (
    <div className={`${s.root} ${collapsed ? s.collapsed : ""} ${mobileOpen ? s.mobileOpen : ""}`}>
      {mobileOpen && (
        <button
          className={s.backdrop}
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="关闭云电竞管理平台导航"
          tabIndex={-1}
        />
      )}

      <aside className={s.sidebar} aria-label="云电竞管理平台侧栏">
        <Link className={s.brand} href="/spark/dashboard" aria-label="云电竞管理平台运营总览">
          <span className={s.brandMark}><SparkGlyph name="spark" size={21} /></span>
          <span className={s.brandCopy}>
            <strong>云电竞<span>管理平台</span></strong>
            <small>云电竞运营控制台</small>
          </span>
        </Link>

        <nav id="spark-navigation" className={s.nav} aria-label="管理模块">
          {SPARK_PAGES.map((page) => {
            const groupHeading = page.group !== lastGroup;
            lastGroup = page.group;
            const active = pathname === page.href;
            return (
              <div className={s.navItemWrap} key={page.slug}>
                {groupHeading && <div className={s.groupLabel}>{page.group}</div>}
                <Link
                  href={page.href}
                  className={`${s.navLink} ${active ? s.active : ""}`}
                  aria-current={active ? "page" : undefined}
                  title={page.label}
                  onClick={() => setMobileOpen(false)}
                >
                  <SparkGlyph name={page.icon} />
                  <span className={s.navText}>{page.label}</span>
                  {"badge" in page && page.badge && <span className={`${s.navBadge} ${page.badge === "LIVE" ? s.liveBadge : ""}`}>{page.badge}</span>}
                </Link>
              </div>
            );
          })}
        </nav>

        <div className={s.sidebarFoot}>
          <div className={s.clusterCard}>
            <span className={s.clusterStatus}><i />集群运行正常</span>
            <b>16:21:14</b>
            <small>华东 1 · 南京枢纽</small>
          </div>
          <button
            className={s.collapseButton}
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!collapsed}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <SparkGlyph name="collapse" size={16} />
            <span>{collapsed ? "展开" : "收起侧栏"}</span>
          </button>
        </div>
      </aside>

      <div className={s.mainColumn}>
        <header className={s.topbar}>
          <button
            className={s.mobileMenuButton}
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="打开云电竞管理平台导航"
            aria-controls="spark-navigation"
            aria-expanded={mobileOpen}
          >
            <SparkGlyph name="menu" size={19} />
          </button>
          <div className={s.searchBox} aria-label="搜索门店、设备、用户或工单号">
            <span className={s.searchGlyph}>⌕</span>
            <span>搜索门店、设备、用户、工单号…</span>
            <kbd>⌘K</kbd>
          </div>
          <div className={s.topbarRight}>
            <span className={s.demoBadge} title="页面内容均为本地 mock 数据，不连接真实业务系统">
              本地 Mock
            </span>
            <div className={s.regionStatus}>
              <span className={s.locationPin}>⌖</span>
              <b>苏州</b>
              <i />
              <span>在线终端</span>
              <strong>3,892 <small>/4,624</small></strong>
            </div>
            <span className={s.notification} aria-label="3 条安全合规提醒">
              <SparkGlyph name="security" size={16} />
              <i />
            </span>
            <Link className={s.returnLink} href="/dashboard" title="返回数科云办公" aria-label="返回数科云办公">
              <SparkGlyph name="back" size={16} />
              <span>返回主系统</span>
            </Link>
          </div>
        </header>

        <main className={s.content} id="spark-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
