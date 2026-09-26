"use client";

// 手机端底部 Dock：五位分组与权限沿用 D1/D3；点按行为按 2026-09-26 新规格。
//
// 为什么和侧栏同时存在于 DOM、靠 CSS 切换（§7「手机壳切换」）：
// SSR 首帧判断不了断点，用 matchMedia 切外壳会先画出**错误的那一个**（手机上闪一下
// 桌面侧栏，或桌面上闪一条底部导航）。所以两份外壳都渲染，由 767px 断点的 display
// 决定谁在场 —— 隐藏的那一份不占位，也不进无障碍树。
//
// 分组与红点在 `lib/mobileNav.ts`；点按任一位打开完整入口面板。
//
// 抽屉内容在 S4 落到 `sheets/`（见下面 `SheetContent`）：§3 表里每位的
// 预览卡 / 筛选 chips / 账号卡按位拆成五个组件，数据走现有 hook / api；
// D3 的权限过滤仍由 `visible` 承担，`MineSheet` 只消费它，不做角色判断。

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

/** 抽屉的 DOM id：Dock 位用 `aria-controls` 指向它（同一个 Dock 只有一张抽屉） */
const SHEET_ID = "mobile-sheet";

/**
 * 每个 Dock 位一张图标。
 *
 * 按「位」取而不是按 href 取：D1 的「支出」位吸收了两条菜单（costs + reports），
 * 按 href 取会在这一位上出现两个图标来源二选一的不稳定行为。
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
  progress: (
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
      <path d="M3 17l5-6 4 4 6-8 3 3" />
      <path d="M3 21h18" />
    </svg>
  ),
  costs: (
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

/**
 * 这一位的抽屉内容（S4 的接缝，`sheets/index.ts`）。
 *
 * 五个按位拆分的内容组件沿用原数据与权限；卡片始终以整宽列表呈现。
 */
function SheetContent({
  id,
  onSelect,
  ...menus
}: {
  id: DockId;
  onSelect: () => void;
} & DockMenuInput & { onReloadMenus?: () => void }) {
  const items = buildDockItems(menus);
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const Content = SHEET_CONTENT[id];
  return (
    <Content
      onSelect={onSelect}
      item={item}
      ready={menus.ready ?? false}
      failed={menus.failed ?? false}
      canApprove={menus.canApprove ?? false}
      onReloadMenus={menus.onReloadMenus}
    />
  );
}

/**
 * 手机壳退场的兜底：≥768px 时收起抽屉。
 *
 * 抽屉是手机外壳的一部分 —— 用户在 767px 打开后横屏 / 拉宽窗口，桌面外壳上场，
 * 抽屉不能悬在桌面屏上。这也是「桌面端不渲染该组件」的可验证形式。
 */
function useCloseOnDesktop(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      if (mq.matches) close();
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [open, close]);
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
export interface MobileDockProps extends DockMenuInput {
  /** 权限重试（`useMenus().reload`）：「我的」抽屉降级行的「重试」按钮用 */
  onReloadMenus?: () => void;
}

export default function MobileDock(props: MobileDockProps) {
  const pathname = usePathname();
  const items = buildDockItems(props);
  const current = dockIdForPath(pathname);

  // 「哪一位 + 开没开」分成两个状态：关闭时 slot 不清空，退场动画那 260ms 里
  // 面板还得渲染这一位的内容，否则会看到一张空面板滑下去。
  const [slot, setSlot] = useState<DockId | null>(null);
  const [open, setOpen] = useState(false);
  // 会话号：只在「关着 → 打开」时递增，作为 BottomSheet 的 key。
  // 抽屉在退场动画里被重新打开时换一个实例，才能重新捕捉「焦点归还落点」
  // （`useModalBehavior` 只在打开那一次记触发元素）。
  const [session, setSession] = useState(0);
  const shown = items.find((item) => item.id === slot) ?? null;

  const close = useCallback(() => setOpen(false), []);

  // 路由变了就收起：客户端导航不会卸载 layout，抽屉会悬在新页面上
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useCloseOnDesktop(open, close);

  /**
   * 点一次打开完整面板；再点当前位关闭，点另一位直接换内容。
   * href 仍供无 JS、新标签页与长按菜单使用。
   */
  function onDockTap(event: React.MouseEvent<HTMLAnchorElement>, id: DockId) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    if (open && slot === id) {
      setOpen(false);
      return;
    }
    setSlot(id);
    if (!open) setSession((n) => n + 1);
    setOpen(true);
  }

  return (
    <>
      <nav className={s.dock} aria-label="主导航" data-shell="dock">
        {items.map((item) => {
          const active = current === item.id;
          const expanded = open && slot === item.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={`${s.tab} ${active ? s.tabActive : ""} ${expanded ? s.tabOpen : ""}`}
              // "page" 才是「当前页」的规范取值；原型里的 "true" 只对 aria-current 的
              // 布尔语义成立，读屏在两处会读成不同的话。
              aria-current={active ? "page" : undefined}
              // 点按展开抽屉：对读屏是一个「展开 / 收起」的开关，不是一个页面链接
              aria-expanded={expanded}
              aria-haspopup="dialog"
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
        title={shown?.label ?? ""}
        subtitle={slot ? SHEET_META[slot].subtitle : undefined}
        action={
          slot && SHEET_META[slot].action ? (
            <Link
              href={SHEET_META[slot].action!.href}
              className={s.sheetGo}
              onClick={close}
            >
              {SHEET_META[slot].action!.label}
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          ) : undefined
        }
      >
        {shown && slot && (
          <SheetContent
            id={slot}
            onSelect={close}
            menus={props.menus}
            ready={props.ready}
            failed={props.failed}
            canApprove={props.canApprove}
            onReloadMenus={props.onReloadMenus}
          />
        )}
      </BottomSheet>
    </>
  );
}
