"use client";

// 手机端底部 Dock（BLF-1127 / S1）。
// 实现契约：docs/superpowers/specs/2026-09-18-mobile-pwa-navigation-design.md §3 / §7 + D1–D3。
//
// 为什么和侧栏同时存在于 DOM、靠 CSS 切换（§7「手机壳切换」）：
// SSR 首帧判断不了断点，用 matchMedia 切外壳会先画出**错误的那一个**（手机上闪一下
// 桌面侧栏，或桌面上闪一条底部导航）。所以两份外壳都渲染，由 767px 断点的 display
// 决定谁在场 —— 隐藏的那一份不占位，也不进无障碍树。
//
// 这一层只负责「把 5 个位画出来」：菜单 → Dock 位的分组、红点信令都在
// `lib/mobileNav.ts`（不依赖 React 的纯函数，单测直接钉住 D1/D3）。

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildDockItems, dockIdForPath, type DockId, type DockMenuInput } from "@/lib/mobileNav";
import s from "./MobileDock.module.css";

/**
 * 每个 Dock 位一张图标。
 *
 * 按「位」取而不是按 href 取：D1 的「支出」位吸收了两条菜单（costs + reports），
 * 按 href 取会在这一位上出现两个图标来源二选一的不稳定行为。
 * 线条风格与桌面侧栏一致（22px / 1.8 描边），手机上手小，图标比文字更早被识别。
 */
const ICON: Record<DockId, React.ReactNode> = {
  dashboard: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  projects: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v5" />
    </svg>
  ),
  progress: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l5-6 4 4 6-8 3 3" />
      <path d="M3 21h18" />
    </svg>
  ),
  costs: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 5l5 7 5-7M12 12v7M8 13h8M8 16h8" />
    </svg>
  ),
  mine: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  ),
};

/**
 * 「我的」位的待办红点。
 *
 * 纯红点（`badge === true`）在无障碍树上没有文字，读屏会读成「我的」而丢掉「有待办」，
 * 所以用 `sr-only` 补一句；数字徽标则把数字读出来。角标本身 `aria-hidden`，
 * 避免读屏读成「3 我的」这种语序颠倒的组合。
 */
function Badge({ badge }: { badge: number | true }) {
  const isDot = badge === true;
  const text = isDot ? "有待办" : `${badge} 条待办`;
  return (
    <>
      <span className={isDot ? s.dot : s.badge} data-badge={isDot ? "dot" : "count"} aria-hidden="true">
        {isDot ? "" : badge > 99 ? "99+" : badge}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}

/**
 * 底部 Dock：恒 5 位（§3 / D3），不随角色变形。
 *
 * 角色只影响「我的」位的红点与那个位的可见菜单（`visible`，S4 的抽屉消费）；
 * 非管理员在 `/meta/me/menus` 里本就拿不到管理与审批三项，Dock 不会凭空多出或
 * 少掉一位（§3.2：手机端不新增角色判断）。
 *
 * props 由 `app/(dashboard)/layout.tsx` 从**同一份** `useMenus()` 传进来，
 * 保证侧栏与 Dock 不会各自拿到不同批次的权限状态。
 */
export default function MobileDock(props: DockMenuInput) {
  const pathname = usePathname();
  const items = buildDockItems(props);
  const current = dockIdForPath(pathname);

  return (
    <nav className={s.dock} aria-label="主导航" data-shell="dock">
      {items.map((item) => {
        const active = current === item.id;
        return (
          <Link
            key={item.id}
            href={item.href}
            className={`${s.tab} ${active ? s.tabActive : ""}`}
            // "page" 才是「当前页」的规范取值；原型里的 "true" 只对 aria-current 的
            // 布尔语义成立，读屏在两处会读成不同的话。
            aria-current={active ? "page" : undefined}
            data-dock={item.id}
          >
            <span className={s.pill} aria-hidden="true" />
            <span className={s.icon} aria-hidden="true">{ICON[item.id]}</span>
            {item.badge !== undefined && <Badge badge={item.badge} />}
            <span className={s.label}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
