"use client";
// 通用弹层：Dialog（居中）/ Drawer（右侧）/ Confirm（确认）。
// 统一处理 Esc 关闭、焦点锁定、滚动锁定、脏数据二次确认、移动端全屏。
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import st from "./Modal.module.css";

type Size = "sm" | "md" | "lg";

function useModalBehavior({
  open,
  onRequestClose,
  dirty,
}: {
  open: boolean;
  onRequestClose: () => void;
  dirty?: boolean;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<Element | null>(null);
  const wasOpenRef = useRef(false);
  const requestCloseRef = useRef(onRequestClose);
  const [mounted, setMounted] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);

  useEffect(() => setMounted(true), []);

  const requestClose = useCallback(() => {
    if (dirty) {
      setAskDiscard(true);
      return;
    }
    onRequestClose();
  }, [dirty, onRequestClose]);

  useEffect(() => {
    requestCloseRef.current = requestClose;
  }, [requestClose]);

  useEffect(() => {
    if (!open) {
      setAskDiscard(false);
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    restoreRef.current = document.activeElement;
  }, [open]);

  const handleExitComplete = useCallback(() => {
    const element = restoreRef.current as HTMLElement | null;
    if (element && typeof element.focus === "function") element.focus();
    restoreRef.current = null;
    wasOpenRef.current = false;
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const t = setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(
        "input:not([type=hidden]), select, textarea, button, [href], [tabindex]:not([tabindex='-1'])"
      );
      (first ?? panel).focus();
    }, 30);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
        )
      ).filter((el) => el.offsetParent !== null);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return { mounted, panelRef, requestClose, askDiscard, setAskDiscard, handleExitComplete };
}

function DiscardConfirm({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <div className={st.inner} role="alertdialog" aria-label="放弃未保存的修改" aria-live="assertive">
      <div className={st.innerBody}>有未保存的修改，确定关闭吗？</div>
      <div className={st.innerFoot}>
        <button className="btn-ghost" onClick={onKeep}>继续编辑</button>
        <button className={`btn-primary ${st.dangerBtn}`} onClick={onDiscard}>放弃修改</button>
      </div>
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: Size;
  /** 有未保存修改时为 true：关闭前二次确认 */
  dirty?: boolean;
  /** 是否允许点遮罩关闭，默认 true */
  maskClosable?: boolean;
}

export function Dialog({
  open, onClose, title, children, footer, size = "md", dirty, maskClosable = true,
}: DialogProps) {
  const { mounted, panelRef, requestClose, askDiscard, setAskDiscard, handleExitComplete } = useModalBehavior({ open, onRequestClose: onClose, dirty });
  const reduced = useReducedMotion();
  const closing = !open;
  const titleId = useId();
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence onExitComplete={handleExitComplete}>
      {open && (
        <m.div
          className={st.overlay}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.12 }}
          style={{ pointerEvents: closing ? "none" : undefined }}
          aria-hidden={closing || undefined}
          onMouseDown={() => maskClosable && requestClose()}
        >
          <m.div
            ref={(element) => { panelRef.current = element; }}
            className={`${st.panel} ${st[size]}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduced ? false : { opacity: 0, y: 6, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, y: 4, scale: 0.995 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className={st.head}>
              <h2 id={titleId} className={st.title}>{title}</h2>
              <button className={st.close} onClick={requestClose} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            <div className={st.body}>{children}</div>
            {footer && <footer className={st.foot}>{footer}</footer>}
            {askDiscard && (
              <DiscardConfirm onKeep={() => setAskDiscard(false)} onDiscard={() => { setAskDiscard(false); onClose(); }} />
            )}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  dirty?: boolean;
}

export function Drawer({ open, onClose, title, children, footer, width = 480, dirty }: DrawerProps) {
  const { mounted, panelRef, requestClose, askDiscard, setAskDiscard, handleExitComplete } = useModalBehavior({ open, onRequestClose: onClose, dirty });
  const reduced = useReducedMotion();
  const closing = !open;
  const titleId = useId();
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence onExitComplete={handleExitComplete}>
      {open && (
        <m.div
          className={st.overlay}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.12 }}
          style={{ pointerEvents: closing ? "none" : undefined }}
          aria-hidden={closing || undefined}
          onMouseDown={requestClose}
        >
          <m.aside
            ref={(element) => { panelRef.current = element; }}
            className={st.drawer}
            style={{ width }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduced ? false : { x: 16, opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduced ? { opacity: 1 } : { x: 16, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className={st.head}>
              <h2 id={titleId} className={st.title}>{title}</h2>
              <button className={st.close} onClick={requestClose} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            <div className={st.body}>{children}</div>
            {footer && <footer className={st.foot}>{footer}</footer>}
            {askDiscard && (
              <DiscardConfirm onKeep={() => setAskDiscard(false)} onDiscard={() => { setAskDiscard(false); onClose(); }} />
            )}
          </m.aside>
        </m.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

export interface ConfirmProps {
  open: boolean;
  title: string;
  text?: React.ReactNode;
  children?: React.ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  open, title, text, children, okText = "确定", cancelText = "取消", danger, loading, onConfirm, onCancel,
}: ConfirmProps) {
  const handleRequestClose = useCallback(() => {
    if (!loading) onCancel();
  }, [loading, onCancel]);
  const { mounted, panelRef, requestClose, handleExitComplete } = useModalBehavior({
    open,
    onRequestClose: handleRequestClose,
  });
  const reduced = useReducedMotion();
  const closing = !open;
  const titleId = useId();
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence onExitComplete={handleExitComplete}>
      {open && (
        <m.div
          className={st.overlay}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.12 }}
          style={{ pointerEvents: closing ? "none" : undefined }}
          aria-hidden={closing || undefined}
          onMouseDown={requestClose}
        >
          <m.div
            ref={(element) => { panelRef.current = element; }}
            className={`${st.panel} ${st.sm}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduced ? false : { opacity: 0, y: 6, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, y: 4, scale: 0.995 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className={st.head}>
              <h2 id={titleId} className={st.title}>{title}</h2>
              <button className={st.close} onClick={requestClose} aria-label="关闭" disabled={loading}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            {(text || children) && <div className={st.body}>{text}{children}</div>}
            <footer className={st.foot}>
              <button className="btn-ghost" onClick={requestClose} disabled={loading}>{cancelText}</button>
              <button
                className={`btn-primary ${danger ? st.dangerBtn : ""}`}
                onClick={onConfirm}
                disabled={loading}
              >
                {loading ? "处理中…" : okText}
              </button>
            </footer>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
