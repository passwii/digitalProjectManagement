"use client";

import { createPortal } from "react-dom";
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import Avatar from "@/components/ui/Avatar";
import ThemeModePicker from "@/components/theme/ThemeModePicker";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useModalBehavior } from "@/components/ui/Modal";
import { getWorkbenchPortalContainer } from "@/lib/workbenchPortalContainer";
import { MODAL_BODY_ATTR, MODAL_CLOSE_ATTR, resolveInitialFocus } from "@/lib/modalFocus";
import type { ShellNavItem } from "@/lib/globalNav";
import s from "./MobileMoreSheet.module.css";

const BODY_MARK = { [MODAL_BODY_ATTR]: "true" };
const CLOSE_MARK = { [MODAL_CLOSE_ATTR]: "true" };

/** 从全站动效令牌解析毫秒数，确保退出清理与 CSS 过渡同源。 */
function cssDurationMs(name: string): number {
  if (typeof window === "undefined") return 0;
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return 0;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith("ms") ? value : value * 1000;
}

/**
 * 「更多」底部 sheet（≤767px）。
 *
 * 行为直接复用 `useModalBehavior`（与 Dialog / Drawer / Confirm / BottomSheet 同源）：
 * Esc 关闭、Tab 焦点锁定、body 滚动锁定、关闭后把焦点还给打开它的「更多」按钮。
 * 视觉按草稿：遮罩 + 底部圆角面板 + 两列溢出入口 + 账号与设置。
 */
export interface MobileMoreSheetProps {
  open: boolean;
  onClose: () => void;
  /** 来自同一份 `navItems` 的溢出项（`splitNav().overflow`），不写死。 */
  items: ShellNavItem[];
  accountName: string | null;
  onLogout: () => void;
  /** 权限菜单加载失败：手机端没有 CenteredNavbar 的重试入口，需要在 sheet 里保留。 */
  permsError?: boolean;
  onRetry?: () => void;
}

export default function MobileMoreSheet({
  open,
  onClose,
  items,
  accountName,
  onLogout,
  permsError = false,
  onRetry,
}: MobileMoreSheetProps) {
  const titleId = `${useId()}-more-title`;
  const reduced = useReducedMotion() ?? false;
  const { mode, setMode } = useTheme();
  const { mounted, panelRef, handleExitComplete } = useModalBehavior({
    open,
    onRequestClose: onClose,
  });
  const [present, setPresent] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => {
      setPresent(false);
      handleExitComplete();
    }, reduced ? 0 : cssDurationMs("--av-dur-base"));
    return () => window.clearTimeout(timer);
  }, [open, present, reduced, handleExitComplete]);

  /**
   * 立即完成 sheet 的清理再离开页面。
   *
   * 修改密码是拦截路由 modal：如果只调用 onClose，320ms 的退出定时器会在密码
   * dialog 已经挂载后才恢复 body overflow / 焦点，导致后者保存了错误的锁状态。
   * 这里在 Link / 退出登录真正跳转前同步完成 modal 清理。
   */
  function closeImmediately() {
    onClose();
    setPresent(false);
    handleExitComplete();
  }

  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open]);

  // 断点回到桌面（>767px）时收起 sheet：桌面没有「更多」入口，留着会成为孤儿浮层。
  useEffect(() => {
    if (!open) return;
    // 桌面 / 平板横屏才收起；手机横屏（≤932px 且 ≤500px 高）仍属于手机壳。
    const media = window.matchMedia?.("(min-width: 933px), (min-width: 768px) and (min-height: 501px)");
    const sync = () => {
      if (media?.matches) onClose();
    };
    sync();
    media?.addEventListener?.("change", sync);
    return () => media?.removeEventListener?.("change", sync);
  }, [open, onClose]);

  // 面板要等 `present` 才真正挂到 portal 上；useModalBehavior 的初始聚焦
  // 在 panelRef 为空时不会重跑，这里按 BottomSheet 同款口径补一次同步聚焦。
  useLayoutEffect(() => {
    if (!open || !present) return;
    const first = resolveInitialFocus(panelRef.current) as HTMLElement | null;
    (first ?? panelRef.current)?.focus({ preventScroll: true });
  }, [open, present, panelRef]);

  if (!mounted || !present) return null;

  return createPortal(
    <div className={s.root} data-open={open} data-more-root="true">
      <div className={s.scrim} data-more-scrim="true" onClick={onClose} aria-hidden="true" />
      <section
        id="mobile-more-sheet"
        ref={(node) => { panelRef.current = node; }}
        className={s.sheet}
        data-open={open}
        data-more-sheet="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <span className={s.handle} aria-hidden="true" />
        <header className={s.head}>
          <b id={titleId}>更多</b>
          <button
            type="button"
            className={s.close}
            aria-label="关闭更多"
            onClick={onClose}
            {...CLOSE_MARK}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </header>

        <div className={s.body} ref={bodyRef} {...BODY_MARK}>
          {permsError ? (
            <div className={s.permsError} role="alert">
              <span>权限菜单加载失败，当前显示兜底入口。</span>
              {onRetry ? (
                <button type="button" onClick={onRetry} className={s.retry}>重试</button>
              ) : null}
            </div>
          ) : null}
          {items.length > 0 ? (
            <div className={s.grid}>
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  target={item.target}
                  rel={item.target === "_blank" ? "noopener noreferrer" : undefined}
                  className={s.navItem}
                  onClick={onClose}
                >
                  <span className={s.navIcon} aria-hidden="true">{item.icon}</span>
                  <span className={s.navLabel}>{item.label}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className={s.empty}>当前没有更多入口</p>
          )}

          <div className={s.account}>
            <div className={s.who}>
              <Avatar name={accountName || "账号"} size={34} />
              <span className={s.identity}>
                <b>{accountName || "账号"}</b>
              </span>
            </div>
            <div className={s.accountActions}>
              <Link href="/change-password" className={s.accountLink} onClick={closeImmediately}>
                修改密码
              </Link>
              <button
                type="button"
                className={s.logout}
                onClick={() => {
                  closeImmediately();
                  onLogout();
                }}
              >
                退出登录
              </button>
            </div>
            <ThemeModePicker mode={mode} onChange={setMode} />
          </div>
        </div>
      </section>
    </div>,
    getWorkbenchPortalContainer(),
  );
}
