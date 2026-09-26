"use client";

import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import {
  MODAL_BODY_ATTR,
  MODAL_CLOSE_ATTR,
  resolveInitialFocus,
} from "@/lib/modalFocus";
import { useModalBehavior } from "@/components/ui/Modal";
import s from "./BottomSheet.module.css";

const EXIT_MS = 260;
const BODY_MARK = { [MODAL_BODY_ATTR]: "true" };
const CLOSE_MARK = { [MODAL_CLOSE_ATTR]: "true" };

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}

/** 单档入口面板：面板固定，内容原生滚动，关闭动作始终可见。 */
export default function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  action,
  id,
  children,
}: BottomSheetProps) {
  const titleId = `${useId()}-sheet-title`;
  const reduced = useReducedMotion() ?? false;
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
    }, reduced ? 0 : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, present, reduced, handleExitComplete]);

  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, title]);

  useLayoutEffect(() => {
    if (!open || !present) return;
    const first = resolveInitialFocus(panelRef.current) as HTMLElement | null;
    (first ?? panelRef.current)?.focus({ preventScroll: true });
  }, [open, present, title, panelRef]);

  if (!mounted || !present) return null;

  return createPortal(
    <div className={s.root} data-sheet-root="true" data-open={open}>
      <div className={s.scrim} data-sheet-scrim="true" data-on={open} onClick={onClose} aria-hidden="true" />
      <div
        id={id}
        ref={(node) => { panelRef.current = node; }}
        className={s.panel}
        data-sheet="panel"
        data-open={open}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={s.head}>
          <div className={s.titleRow}>
            <div className={s.ttl}>
              <b id={titleId}>{title}</b>
              {subtitle && <span>{subtitle}</span>}
            </div>
            <button
              type="button"
              className={s.close}
              onClick={onClose}
              aria-label={`关闭${title}面板`}
              {...CLOSE_MARK}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M5 5l14 14M19 5L5 19" />
              </svg>
            </button>
          </div>
          {action && <div className={s.headAction}>{action}</div>}
        </div>
        <div ref={bodyRef} className={s.body} data-sheet-body="true" {...BODY_MARK}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
