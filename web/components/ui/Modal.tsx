"use client";
// 通用弹层：Dialog（居中）/ Drawer（右侧）/ Confirm（确认）。
// 统一处理 Esc 关闭、焦点锁定、滚动锁定、脏数据二次确认、移动端全屏。
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);
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
    if (!open) {
      setAskDiscard(false);
      return;
    }
    restoreRef.current = document.activeElement;
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
        requestClose();
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
      const el = restoreRef.current as HTMLElement | null;
      if (el && typeof el.focus === "function") el.focus();
    };
  }, [open, requestClose]);

  return { mounted, panelRef, requestClose, askDiscard, setAskDiscard };
}

function DiscardConfirm({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <div className={st.inner} role="alertdialog" aria-label="放弃未保存的修改">
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
  const { mounted, panelRef, requestClose, askDiscard, setAskDiscard } = useModalBehavior({ open, onRequestClose: onClose, dirty });
  if (!mounted || !open) return null;

  return createPortal(
    <div className={st.overlay} onMouseDown={() => maskClosable && requestClose()}>
      <div
        ref={panelRef}
        className={`${st.panel} ${st[size]}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={st.head}>
          <h2 className={st.title}>{title}</h2>
          <button className={st.close} onClick={requestClose} aria-label="关闭">✕</button>
        </header>
        <div className={st.body}>{children}</div>
        {footer && <footer className={st.foot}>{footer}</footer>}
        {askDiscard && (
          <DiscardConfirm onKeep={() => setAskDiscard(false)} onDiscard={() => { setAskDiscard(false); onClose(); }} />
        )}
      </div>
    </div>,
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
  const { mounted, panelRef, requestClose, askDiscard, setAskDiscard } = useModalBehavior({ open, onRequestClose: onClose, dirty });
  if (!mounted || !open) return null;

  return createPortal(
    <div className={st.overlay} onMouseDown={requestClose}>
      <div
        ref={panelRef}
        className={st.drawer}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={st.head}>
          <h2 className={st.title}>{title}</h2>
          <button className={st.close} onClick={requestClose} aria-label="关闭">✕</button>
        </header>
        <div className={st.body}>{children}</div>
        {footer && <footer className={st.foot}>{footer}</footer>}
        {askDiscard && (
          <DiscardConfirm onKeep={() => setAskDiscard(false)} onDiscard={() => { setAskDiscard(false); onClose(); }} />
        )}
      </div>
    </div>,
    document.body
  );
}

export interface ConfirmProps {
  open: boolean;
  title: string;
  text?: React.ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  open, title, text, okText = "确定", cancelText = "取消", danger, loading, onConfirm, onCancel,
}: ConfirmProps) {
  const { mounted, panelRef, requestClose } = useModalBehavior({ open, onRequestClose: onCancel });
  if (!mounted || !open) return null;

  return createPortal(
    <div className={st.overlay} onMouseDown={requestClose}>
      <div
        ref={panelRef}
        className={`${st.panel} ${st.sm}`}
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={st.head}>
          <h2 className={st.title}>{title}</h2>
          <button className={st.close} onClick={requestClose} aria-label="关闭">✕</button>
        </header>
        {text && <div className={st.body}>{text}</div>}
        <footer className={st.foot}>
          <button className="btn-ghost" onClick={requestClose}>{cancelText}</button>
          <button
            className={`btn-primary ${danger ? st.dangerBtn : ""}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "处理中…" : okText}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
