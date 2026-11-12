"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import type { ShellNavItem } from "@/lib/globalNav";
import { buildMobileDockModel } from "@/lib/mobilePwaNav";
import s from "./MobileBottomDock.module.css";

/**
 * 手机底部 dock（≤767px）：5 个权限主入口 + 恒定的「更多」。
 *
 * 视觉按已确认草稿 docs/prototypes/mobile-pwa：透明底、细边界、液态玻璃胶囊。
 * 桌面完全隐藏（display:none），顶部仍由 CenteredNavbar 承担主导航。
 *
 * 这里只渲染导航本身；「更多」sheet 由 layout 渲染并在打开时接管焦点，
 * 这样 sheet 关闭后焦点能自然回到触发它的按钮。
 */
export interface MobileBottomDockProps {
  items: ShellNavItem[];
  activeHref: string;
  /** 「更多」sheet 是否打开（用于胶囊高亮与 aria-expanded）。 */
  moreOpen: boolean;
  /** 点击「更多」。 */
  onMoreClick: () => void;
  /** 权限菜单加载中：补足 5 个主入口占位，避免 dock 首屏只剩两槽。 */
  loading?: boolean;
}

const MORE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export default function MobileBottomDock({
  items,
  activeHref,
  moreOpen,
  onMoreClick,
  loading = false,
}: MobileBottomDockProps) {
  const { slots, activeIndex, activeInOverflow } = buildMobileDockModel(items, activeHref);
  const primarySlots = slots.filter((slot) => slot.kind === "link");
  const moreSlot = slots.find((slot) => slot.kind === "more");
  // 权限还在加载时补足槽位占位（不模拟任何入口）：首屏就是 6 槽几何，
  // 不会先画出一条两槽的 dock 再跳成六槽。权限确认后按真实入口收敛。
  const ghostCount = loading ? Math.max(0, 5 - primarySlots.length) : 0;
  const ghosts = Array.from({ length: ghostCount }, (_, index) => ({
    id: `ghost-${index}`,
    kind: "ghost" as const,
    label: "",
  }));
  const displaySlots = [...primarySlots, ...ghosts, ...(moreSlot ? [moreSlot] : [])];
  const count = displaySlots.length;
  const active = moreOpen || activeInOverflow
    ? count - 1
    : activeIndex >= 0
      ? activeIndex
      : -1;
  const liquidStyle: CSSProperties = {
    left: `calc(6px + ${Math.max(active, 0)} * ((100% - 12px) / ${count}))`,
    width: `calc((100% - 12px) / ${count} - 4px)`,
  };

  return (
    <nav
      className={s.dock}
      aria-label="手机主导航"
      data-shell="mobile-dock"
      data-mobile-dock="true"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        className={s.liquid}
        data-visible={active >= 0 ? "true" : "false"}
        aria-hidden="true"
        style={liquidStyle}
      />
      {displaySlots.map((slot, index) => {
        if (slot.kind === "ghost") {
          return (
            <span
              key={slot.id}
              className={s.tabGhost}
              data-dock-ghost="true"
              aria-hidden="true"
            >
              <span className={s.ghostIcon} />
              <span className={s.ghostLabel} />
            </span>
          );
        }
        if (slot.kind === "more") {
          return (
            <button
              key={slot.id}
              type="button"
              className={s.tab}
              data-dock="more"
              data-active={active === index ? "true" : "false"}
              aria-label="更多"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-controls="mobile-more-sheet"
              onClick={onMoreClick}
            >
              <span className={s.icon} aria-hidden="true">{MORE_ICON}</span>
              <span className={s.label}>{slot.label}</span>
            </button>
          );
        }

        return (
          <Link
            key={slot.id}
            href={slot.href ?? "/dashboard"}
            className={s.tab}
            data-dock={slot.id}
            data-active={active === index ? "true" : "false"}
            aria-current={active === index ? "page" : undefined}
          >
            <span className={s.icon} aria-hidden="true">{slot.icon}</span>
            <span className={s.label}>{slot.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
