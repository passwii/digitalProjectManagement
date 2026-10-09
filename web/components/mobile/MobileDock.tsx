"use client";

// 手机端底部 Dock：五位分组与权限沿用 D1/D3；点按行为按 2026-09-26 新规格。
//
// 为什么和侧栏同时存在于 DOM、靠 CSS 切换（§7「手机壳切换」）：
// SSR 首帧判断不了断点，用 matchMedia 切外壳会先画出**错误的那一个**（手机上闪一下
// 桌面侧栏，或桌面上闪一条底部导航）。所以两份外壳都渲染，由 767px 断点的 display
// 决定谁在场 —— 隐藏的那一份不占位，也不进无障碍树。
//
// 分组与红点在 `lib/mobileNav.ts`；四个模块位直接路由跳转，「我的」保留账号与权限面板。
// 抽屉组件继续消费既有菜单与权限判定；Dock 不自行判断角色。

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  buildDockItems,
  dockIdForPath,
  type DockId,
  type DockMenuInput,
} from "@/lib/mobileNav";
import BottomSheet from "./BottomSheet";
import { SHEET_CONTENT, SHEET_META } from "./sheets";
import s from "./MobileDock.module.css";

const SHEET_ID = "mobile-sheet";

/**
 * 每个 Dock 位一张图标。
 *
 * 按「位」取图标，保证固定五槽的每个入口来源稳定。
 * 线条风格与桌面侧栏一致（22px / 1.8 描边），手机上手小，图标比文字更早被识别。
 */
const ICON: Record<DockId, React.ReactNode> = {
  dashboard: (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  projects: (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v5" />
    </svg>
  ),
  assets: (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="m3.5 7.8 8.5 4.4 8.5-4.4M12 12.2V21" />
    </svg>
  ),
  reports: (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 5l5 7 5-7M12 12v7M8 13h8M8 16h8" />
    </svg>
  ),
  mine: (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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
      <span
        className={isDot ? s.dot : s.badge}
        data-badge={isDot ? "dot" : "count"}
        aria-hidden="true"
      >
        {isDot ? "" : badge > 99 ? "99+" : badge}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}

function SheetContent({
  id,
  onSelect,
  ...menus
}: {
  id: DockId;
  onSelect: () => void;
} & DockMenuInput & { onReloadMenus?: () => void; isAdmin?: boolean }) {
  const items = buildDockItems(menus);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return null;
  const Content = SHEET_CONTENT[id];
  return (
    <Content
      onSelect={onSelect}
      item={item}
      ready={menus.ready ?? false}
      failed={menus.failed ?? false}
      canApprove={menus.canApprove ?? false}
      isAdmin={menus.isAdmin ?? false}
      onReloadMenus={menus.onReloadMenus}
    />
  );
}

function useCloseOnDesktop(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      if (media.matches) close();
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [open, close]);
}

/**
 * 底部 Dock：恒 5 位（§3 / D3），不随角色变形。模块位直接导航；「我的」承载账号与管理入口。
 *
 * 角色只影响「我的」位的红点与那个位的可见菜单（`visible`，S4 的抽屉消费）；
 * 非管理员在 `/meta/me/menus` 里本就拿不到管理与审批三项，Dock 不会凭空多出或
 * 少掉一位（§3.2：手机端不新增角色判断）。
 *
 * props 由 `app/(dashboard)/layout.tsx` 从**同一份** `useMenus()` 传进来，
 * 保证侧栏与 Dock 不会各自拿到不同批次的权限状态。
 */
export interface MobileDockProps extends DockMenuInput {
  /** 是否管理员角色（仅用于「我的」面板的身份展示） */
  isAdmin?: boolean;
  /** 菜单权限加载失败时的重试回调 */
  onReloadMenus?: () => void;
}

export default function MobileDock(props: MobileDockProps) {
  const pathname = usePathname();
  const items = buildDockItems(props);
  const current = dockIdForPath(pathname);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const mine = items.find((item) => item.id === "mine") ?? null;
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useCloseOnDesktop(open, close);

  function onDockTap(event: React.MouseEvent<HTMLAnchorElement>, id: DockId) {
    if (id !== "mine") return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    if (open) {
      setOpen(false);
      return;
    }
    setSession((value) => value + 1);
    setOpen(true);
  }

  return (
    <>
      <nav className={s.dock} aria-label="主导航" data-shell="dock">
        {items.map((item) => {
          const active = current === item.id;
          const expanded = item.id === "mine" && open;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={`${s.tab} ${active ? s.tabActive : ""} ${expanded ? s.tabOpen : ""}`}
              aria-current={active ? "page" : undefined}
              aria-expanded={item.id === "mine" ? expanded : undefined}
              aria-haspopup={item.id === "mine" ? "dialog" : undefined}
              aria-label={item.id === "mine" && item.badge !== undefined
                ? `我的，${item.badge === true ? "有待办" : `${item.badge} 条待办`}`
                : undefined}
              aria-controls={expanded ? SHEET_ID : undefined}
              data-dock={item.id}
              onClick={(event) => onDockTap(event, item.id)}
            >
              <span className={s.pill} aria-hidden="true" />
              <span className={s.icon} aria-hidden="true">
                {ICON[item.id]}
              </span>
              {item.badge !== undefined && <Badge badge={item.badge} />}
              <span className={s.label}>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <BottomSheet
        key={session}
        id={SHEET_ID}
        open={open}
        onClose={close}
        title={mine?.label ?? "我的"}
        subtitle={SHEET_META.mine.subtitle}
      >
        {open && mine && (
          <SheetContent
            id="mine"
            onSelect={close}
            menus={props.menus}
            ready={props.ready}
            failed={props.failed}
            canApprove={props.canApprove}
            isAdmin={props.isAdmin}
            onReloadMenus={props.onReloadMenus}
          />
        )}
      </BottomSheet>
    </>
  );
}
