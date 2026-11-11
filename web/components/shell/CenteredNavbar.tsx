"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import LiquidNavbar from "@/components/ui/liquid-navbar";
import { navItemMatchesPath, splitNav, type ShellNavItem } from "@/lib/globalNav";
import s from "./CenteredNavbar.module.css";

export type { ShellNavItem };

/**
 * 居中药丸导航（已确认草稿 docs/prototypes/navbar-centered）。
 *
 * 职责边界（Lead 的 layout 约定）：
 *   · 本组件**不**自己 `position: fixed`，也不渲染品牌 / 账号 / 通知；
 *     外层 `.navDock` 负责 fixed 居中，这里只负责药丸与「更多」浮层的相对布局。
 *   · 五个主入口固定为 /dashboard /projects /progress /costs /approvals；
 *     缺位时按 /contacts /opportunities /assets /reports 补足，独立站点
 *     （`external`）永远不补位，其余入口全部进「更多」。
 *   · 当前路径落在溢出层时高亮「更多」；Esc / 外部点击关闭并还焦。
 *
 * 窄屏（≤767px）只显示图标与「更多」，标签通过 CSS 收成 sr-only。
 */
export interface CenteredNavbarProps {
  items: ShellNavItem[];
  activeHref: string;
  /** 权限菜单同步失败时为 true：药丸下方提示并给出重试入口。 */
  permsError?: boolean;
  onRetry?: () => void;
}

/** 外部站点 / 协议链接不走 Next 路由，交给浏览器原生打开。 */
function isNativeHref(href: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(href) || href.startsWith("mailto:") || href.startsWith("#");
}

/** 打开方式只由 item.target 决定（手机端 layout 不传 target，于是同页打开）。 */
function linkRel(target: string | undefined): string | undefined {
  return target === "_blank" ? "noopener noreferrer" : undefined;
}

export default function CenteredNavbar({
  items,
  activeHref,
  permsError = false,
  onRetry,
}: CenteredNavbarProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const { primary, overflow, activeInOverflow } = useMemo(
    () => splitNav(items, activeHref),
    [items, activeHref],
  );

  const hasOverflow = overflow.length > 0;
  /** 「更多」被点亮：面板打开中，或当前页落在溢出层。 */
  const moreLit = hasOverflow && (open || activeInOverflow);

  /**
   * 液滴目标：打开「更多」时优先跟随它（与草稿的 toggleMore 一致），
   * 否则跟随药丸里的激活项；都没有时退回药丸第一项。
   */
  const liquidKey = moreLit ? "__more__" : activeHref;

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) moreButtonRef.current?.focus();
  }, []);

  // 路由变化后浮层不应留在原地
  useEffect(() => {
    setOpen(false);
  }, [activeHref]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // Esc 关闭并还焦到「更多」，键盘用户不丢位置。
        closeMenu(true);
      }
    }

    // 统一收成 Event：mousedown / touchstart 的重载各自带自己的事件类型，
    // 写成 MouseEvent | PointerEvent 反而与 addEventListener 的重载不兼容。
    function onOutside(event: Event) {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      closeMenu(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open, closeMenu]);

  /** 键盘（Enter / Space）打开时把焦点送进浮层；指针打开则留在按钮上。 */
  function focusFirstItem() {
    const first = panelRef.current?.querySelector<HTMLElement>("a, button");
    first?.focus();
  }

  function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    const next = !open;
    setOpen(next);
    // 键盘触发的 click 的 detail 恒为 0
    if (next && event.detail === 0) {
      requestAnimationFrame(focusFirstItem);
    }
  }

  return (
    <div className={s.root} ref={rootRef}>
      <nav className={s.nav} aria-label="主导航" data-centered-nav="true">
        <LiquidNavbar
          activeKey={liquidKey}
          canvasClassName={s.water}
          dropClassName={s.drop}
        />

        {primary.map((item) => {
          const active = !activeInOverflow && navItemMatchesPath(item.href, activeHref);
          const rel = linkRel(item.target);
          const content = (
            <>
              {item.icon ? (
                <span className={s.icon} aria-hidden="true">{item.icon}</span>
              ) : null}
              <span className={s.label}>{item.label}</span>
            </>
          );
          const className = s.item;
          const common = {
            "data-nav-item": "true",
            // 打开「更多」时液滴跟到按钮上（与草稿的 toggleMore 一致），
            // aria-current 仍留在真实页面对应的入口上。
            "data-liquid-active": active && !open ? "true" : undefined,
            "aria-current": active ? ("page" as const) : undefined,
            title: item.label,
          };

          return isNativeHref(item.href) ? (
            <a
              key={item.href}
              href={item.href}
              target={item.target}
              rel={rel}
              className={className}
              {...common}
            >
              {content}
            </a>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              target={item.target}
              rel={rel}
              className={className}
              {...common}
            >
              {content}
            </Link>
          );
        })}

        {hasOverflow ? (
          <button
            ref={moreButtonRef}
            type="button"
            className={`${s.item} ${s.moreBtn}`}
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={panelId}
            aria-current={activeInOverflow ? "page" : undefined}
            data-liquid-active={moreLit ? "true" : undefined}
            onClick={toggle}
          >
            <span className={s.icon} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <span className={s.label}>更多</span>
            <svg className={s.chev} viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
        ) : null}
      </nav>

      {open && hasOverflow ? (
        <div
          ref={panelRef}
          id={panelId}
          className={s.more}
          aria-label="更多导航"
          data-more-panel="true"
        >
          <div className={s.moreGrid}>
            {overflow.map((item) => {
              const active = navItemMatchesPath(item.href, activeHref);
              const rel = linkRel(item.target);
              const content = (
                <>
                  {item.icon ? (
                    <span className={s.moreIcon} aria-hidden="true">{item.icon}</span>
                  ) : (
                    <span className={s.moreBullet} aria-hidden="true" />
                  )}
                  <span className={s.moreLabel}>{item.label}</span>
                </>
              );
              const className = `${s.moreItem} ${active ? s.moreItemActive : ""}`.trim();
              const common = {
                "data-nav-item": "true",
                "aria-current": active ? ("page" as const) : undefined,
                onClick: () => closeMenu(false),
              };

              return isNativeHref(item.href) ? (
                <a
                  key={item.href}
                  href={item.href}
                  target={item.target}
                  rel={rel}
                  className={className}
                  {...common}
                >
                  {content}
                </a>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  target={item.target}
                  rel={rel}
                  className={className}
                  {...common}
                >
                  {content}
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}

      {permsError ? (
        <div className={s.permsError} role="alert">
          <span className={s.permsErrorText}>权限信息加载失败，仅显示基础入口。</span>
          {onRetry ? (
            <button type="button" className={s.retry} onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
