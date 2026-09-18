"use client";
// 通用弹层：Dialog（居中）/ Drawer（右侧）/ Confirm（确认）。
// 统一处理 Esc 关闭、焦点锁定、滚动锁定、脏数据二次确认、移动端全屏。
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { MODAL_BODY_ATTR, MODAL_CLOSE_ATTR, resolveInitialFocus } from "@/lib/modalFocus";
import st from "./Modal.module.css";

type Size = "sm" | "md" | "lg";

/**
 * 弹层结构标记（值取自 `lib/modalFocus` 的常量，避免属性名两处各写一份而漂移）：
 *   · `CLOSE_MARK` —— 标在关闭按钮上，初始聚焦要跳过它；
 *   · `BODY_MARK`  —— 标在正文区上，初始聚焦优先在其中找表单控件。
 */
const CLOSE_MARK = { [MODAL_CLOSE_ATTR]: "true" };
const BODY_MARK = { [MODAL_BODY_ATTR]: "true" };

/**
 * 弹层的共享行为：初始聚焦、Esc、body 滚动锁定、Tab 循环、关闭后归还焦点。
 *
 * `modal=false` 是手机端底部抽屉（`components/mobile/BottomSheet.tsx`，BLF-1127/S3）
 * 的 peek 档要的「非模态」语义：不锁 body 滚动、不锁 Tab（焦点可以离开面板），
 * 但初始聚焦与「关闭后归还焦点」照旧 —— 它仍然是弹层，只是不独占页面。
 * 不加遮罩却锁 Tab，会把键盘用户关在一个看不出来是弹层的东西里。
 *
 * Esc **不受**本开关影响：抽屉三档都要能 Esc 降档 / 收起。
 *
 * 导出它是为了不让第二个弹层组件再实现一遍这套行为（Dialog / Drawer / Confirm
 * 用的是同一份；抽屉也必须是同一份）。
 */
export function useModalBehavior({
  open,
  onRequestClose,
  dirty,
  modal = true,
}: {
  open: boolean;
  onRequestClose: () => void;
  dirty?: boolean;
  modal?: boolean;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<Element | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const overflowRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const requestCloseRef = useRef(onRequestClose);
  const [mounted, setMounted] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);

  useEffect(() => setMounted(true), []);

  const requestClose = useCallback(() => {
    if (!openRef.current) return;
    if (dirty) {
      setAskDiscard(true);
      return;
    }
    onRequestClose();
  }, [dirty, onRequestClose]);

  useEffect(() => {
    requestCloseRef.current = requestClose;
  }, [requestClose]);

  /** 初始聚焦的落点：正文里第一个表单控件，其次弹层内其余非 chrome 控件。 */
  const focusInitial = useCallback((panel: HTMLElement) => {
    const target = resolveInitialFocus(panel) as HTMLElement | null;
    // `panel` 兜底必须保留：Confirm 这类没有可聚焦控件的弹层不能丢掉焦点。
    (target ?? panel).focus();
  }, []);

  // 捕获「打开前的焦点」，供关闭后归还（handleExitComplete 用）。
  //
  // 必须是 layout effect，且必须排在下面那次初始聚焦**之前**：两者若同处一轮，
  // 先跑聚焦的话 document.activeElement 已是我们自己聚焦的正文控件，
  // 于是「关闭后归还触发元素」就会把焦点还给弹层内部的元素。
  useLayoutEffect(() => {
    if (!open) {
      setAskDiscard(false);
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    restoreRef.current = document.activeElement;
  }, [open]);

  // 初始聚焦：**同步**做，不留等待窗口。
  //
  // 依赖里必须带 `mounted`：弹层经 createPortal 在 `mounted` 变 true 之后才真正
  // 挂到 DOM 上，首次提交时 panelRef 还是 null。旧实现靠 setTimeout(30) 把查找
  // 推迟到 portal 挂载之后，所以「延迟」在当时同时承担了「等挂载」与「聚焦」两件事；
  // 现在把等挂载交给依赖表达，聚焦本身不再需要等待。
  //
  // BLF-1123：这里原本是 `setTimeout(..., 30)`，造成两个症状：
  //   ① 选择器是并集（`…, button, …`）而 header 里的关闭按钮在 DOM 序上先于 body，
  //      `querySelector` 取到的首个匹配就是关闭叉叉；
  //   ② 更要紧的是**时序**：弹层挂载后的 30ms 内焦点还没落到正文，用户若已开始输入
  //      （含中文输入法的拼音首字母），定时器再把焦点抢走会打断输入法组合，
  //      把首字母以裸小写拉丁字母上屏 —— 即「首个输入键出小写字母」。
  //      两者同源但**不是**同一个修复：只把落点改对、保留 30ms 延迟，症状②依旧复现
  //      （真实 Chromium 实测，见 PR 说明）。
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    // 用户已经自己把焦点放进弹层（抢在挂载前点进字段）就不要抢走；
    // StrictMode 的二次调用也靠这条守卫短路。
    const active = document.activeElement;
    if (active && panel.contains(active)) return;
    focusInitial(panel);

    // 延迟兜底：仅当「焦点还没落进弹层」时才补一次，用于个别浏览器
    // 在挂载动画期间丢弃同步 focus() 的情况。
    //
    // 与旧实现的本质区别是它**永不抢走用户已在弹层内的焦点**，
    // 因此不可能再中断输入法组合；主路径是上面那次同步聚焦，本条只是保险。
    const timer = window.setTimeout(() => {
      if (!openRef.current || panelRef.current !== panel) return;
      const current = document.activeElement;
      if (current && panel.contains(current)) return;
      focusInitial(panel);
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open, mounted, focusInitial]);

  const handleExitComplete = useCallback(() => {
    const element = restoreRef.current as HTMLElement | null;
    if (element && typeof element.focus === "function") element.focus();
    restoreRef.current = null;
    wasOpenRef.current = false;
    if (overflowRef.current !== null) {
      document.body.style.overflow = overflowRef.current;
      overflowRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!modal) {
      // 由模态档降回非模态档（抽屉 full/half → peek）：立刻解锁滚动。
      // 关闭路径不在这里处理 —— 仍旧由 handleExitComplete 在退场动画结束后解锁，
      // Dialog / Drawer / Confirm 的行为因此完全不变。
      if (overflowRef.current !== null) {
        document.body.style.overflow = overflowRef.current;
        overflowRef.current = null;
      }
    } else if (overflowRef.current === null) {
      overflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // 非模态档不锁 Tab：面板没有遮罩、不占有页面，焦点本来就该能走到别处
      if (!modal) return;
      const panel = panelRef.current;
      if (!panel) return;
      // 与初始聚焦用的选择器刻意分开：这一条表达的是「Tab 顺序」——
      // 关闭按钮是合法的 Tab 落点（只在**初始**聚焦时才排除），且这里要逐项过滤 disabled。
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
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, modal]);

  useEffect(
    () => () => {
      if (overflowRef.current !== null) {
        document.body.style.overflow = overflowRef.current;
        overflowRef.current = null;
      }
    },
    [],
  );

  return { mounted, panelRef, openRef, requestClose, askDiscard, setAskDiscard, handleExitComplete };
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
  const { mounted, panelRef, openRef, requestClose, askDiscard, setAskDiscard, handleExitComplete } = useModalBehavior({ open, onRequestClose: onClose, dirty });
  const reduced = useReducedMotion();
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
          onPointerDownCapture={(event) => {
            if (!openRef.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
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
              <button className={st.close} {...CLOSE_MARK} onClick={requestClose} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            <div className={st.body} {...BODY_MARK}>{children}</div>
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
  const { mounted, panelRef, openRef, requestClose, askDiscard, setAskDiscard, handleExitComplete } = useModalBehavior({ open, onRequestClose: onClose, dirty });
  const reduced = useReducedMotion();
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
          onPointerDownCapture={(event) => {
            if (!openRef.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
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
              <button className={st.close} {...CLOSE_MARK} onClick={requestClose} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            <div className={st.body} {...BODY_MARK}>{children}</div>
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
  const { mounted, panelRef, openRef, requestClose, handleExitComplete } = useModalBehavior({
    open,
    onRequestClose: handleRequestClose,
  });
  const reduced = useReducedMotion();
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
          onPointerDownCapture={(event) => {
            if (!openRef.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
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
              <button className={st.close} {...CLOSE_MARK} onClick={requestClose} aria-label="关闭" disabled={loading}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            {(text || children) && <div className={st.body} {...BODY_MARK}>{text}{children}</div>}
            <footer className={st.foot}>
              <button className="btn-ghost" onClick={requestClose} disabled={loading}>{cancelText}</button>
              <button
                className={`btn-primary ${danger ? st.dangerBtn : ""}`}
                onClick={() => {
                  if (openRef.current) onConfirm();
                }}
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
