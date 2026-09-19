"use client";

// 三态底部抽屉（BLF-1127 / S3，契约 §4 + 决策 D2）。
//
// 为什么是「一张面板三档」而不是三个组件：peek / half / full 是同一张面板的三个
// 停靠位，手势语义与 iOS 地图 / Safari 一致 —— 换档只改高度与遮罩，内容、滚动位置、
// 焦点都保持，用户不会因为「升了一档」而丢上下文。
//
// 弹层行为**不新写第二套**：初始聚焦落点、Tab 锁定、Esc、body 滚动锁定、
// 关闭后归还焦点全部来自 `components/ui/Modal.tsx` 的 `useModalBehavior`
// （它用的正是 `lib/modalFocus.ts`）。本文件只负责「三档几何 + 手势采集 + 抽屉布局」。
//
// 三档的模态语义（刻意的，不是默认值）：
//   · peek —— **非模态**：无遮罩、不锁 body 滚动、不锁 Tab（焦点能离开面板回到 Dock）。
//     它不打断当前页，「把键盘用户关在一个没有遮罩的面板里」才是错的;
//   · half / full —— 有遮罩、锁 body 滚动、Tab 在面板内循环。
// 两条路径的 Esc 都生效：peek 收起，half / full 降回 peek（契约「Esc 降档 / 关闭」）。
//
// 与 Dock 的层级：Dock 永远压在抽屉之上（原型 z-index: dock 20 > sheet 16），
// 所以「再点当前位降回 peek」在 half / full 也成立。细节见 BottomSheet.module.css。
//
// 退场为什么不用 AnimatePresence：它保留的是**上一次渲染的元素对象**，
// 于是退场那 260ms 里 `data-open` / `data-scrim` 会停留在打开时的值 ——
// 遮罩继续吃点击、面板继续可点，正是「关闭后还在拦截点击」那类 bug。
// 这里自己握着 `present`（面板留到动画播完）+ 由 React 状态驱动 data-* 属性，
// 关闭的那一帧命中链就断了，动画照常播。

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "framer-motion";
import { MODAL_BODY_ATTR } from "@/lib/modalFocus";
import {
  DRAG_SLOP,
  clampDragOffset,
  resolveDragOutcome,
  type SheetStop,
} from "@/lib/sheetGesture";
import { useModalBehavior } from "@/components/ui/Modal";
import s from "./BottomSheet.module.css";

/** 面板正文标记：初始聚焦优先在正文里找落点（复用 `lib/modalFocus` 的约定） */
const BODY_MARK = { [MODAL_BODY_ATTR]: "true" };

/** peek 档高度上限，px。与 `BottomSheet.module.css` 的 `--m-sheet-peek` 同值 */
const PEEK_MAX = 236;
/** 退场时长，ms。与 `BottomSheet.module.css` 的 `--m-sheet-motion` 同值 */
const EXIT_MS = 260;

export type { SheetStop };

export interface BottomSheetProps {
  /** 是否在场（关闭后仍留 `EXIT_MS` 播放下滑动画，之后卸载） */
  open: boolean;
  /** 当前档位 */
  stop: SheetStop;
  onStopChange: (stop: SheetStop) => void;
  /** 收起（点遮罩 / peek 下甩 / Esc 收起 / 点卡片进模块） */
  onClose: () => void;
  /** 面板标题（`aria-labelledby` 指向它） */
  title: string;
  subtitle?: string;
  /** 头部右侧动作（如「进入模块」）；S4 接模块落点时用 */
  action?: React.ReactNode;
  /** Dock 位的 id：供触发 Dock 的 `aria-controls` 指向 */
  id?: string;
  children: React.ReactNode;
}

export default function BottomSheet({
  open,
  stop,
  onStopChange,
  onClose,
  title,
  subtitle,
  action,
  id,
  children,
}: BottomSheetProps) {
  const titleId = `${useId()}-sheet-title`;
  // peek 非模态、half / full 模态：这一个布尔量同时决定遮罩、body 锁定与 Tab 锁定
  const modal = stop !== "peek";
  const reduced = useReducedMotion() ?? false;
  const exitMs = reduced ? 0 : EXIT_MS;

  /** Esc：peek 收起，half / full 降回 peek（§4 交互约定 / D2） */
  const handleRequestClose = useCallback(() => {
    if (stop === "peek") onClose();
    else onStopChange("peek");
  }, [stop, onClose, onStopChange]);

  const { mounted, panelRef, handleExitComplete } = useModalBehavior({
    open,
    onRequestClose: handleRequestClose,
    modal,
  });

  // 面板留到下滑动画播完才卸载；卸载那一刻交还焦点（handleExitComplete）
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => {
      setPresent(false);
      handleExitComplete();
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, present, exitMs, handleExitComplete]);

  // peek 的确定高度：先量内容自然高度再落成 px。为什么不交给 CSS 的 max-height：
  // `height: auto → 56%` 之间过渡不了，换档就成了瞬移。封顶 236 由 PEEK_MAX 与
  // CSS 的 max-height 各兜一次（契约：peek ≤236px）。
  useLayoutEffect(() => {
    if (!open || !present) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (stop !== "peek") {
      panel.style.height = "";
      return;
    }
    panel.style.height = "auto";
    panel.style.height = `${Math.min(panel.scrollHeight, PEEK_MAX)}px`;
  }, [open, present, stop, panelRef, children]);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 列表顶部继续往下拉时，把手势从浏览器手里拿回来。
  // 原生滚动已经到头（scrollTop=0 再往下拉）：浏览器的「接管」只会空耗掉这次
  // 下甩（pointercancel），面板的降档手势永远接不上。scrollTop>0 或上滑时绝不拦
  // —— 滚动优先；只有「滚无可滚却想降档」这一下才归面板。
  // 注意不能走 React 的 onTouchMove：React 在 root 把 touchmove 挂成 passive，
  // preventDefault 会被忽略，这里必须用原生 listener + { passive: false }。
  useEffect(() => {
    const scroller = bodyRef.current;
    if (!open || !present || !scroller) return;
    let startY = 0;
    const onStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
    };
    const onMove = (e: TouchEvent) => {
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      if (scroller.scrollTop <= 0 && dy > DRAG_SLOP && e.cancelable)
        e.preventDefault();
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
    };
  }, [open, present]);
  const dragRef = useRef<{
    startY: number;
    from: SheetStop;
    dy: number;
    moved: boolean;
    /** 起手是否落在可滚列表里：是则浏览器拥有滚动优先权，面板只在
        列表顶部（scrollTop=0）且浏览器没接管时才跟手（见 onPointerMove） */
    startedInBody: boolean;
  } | null>(null);
  /** 拖拽结束后的那一次 click 不是「点卡片」：置位后由捕获阶段吃掉 */
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  function resetDragStyle() {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transition = "";
    panel.style.transform = "";
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const scroller = bodyRef.current;
    const target = event.target as Node;
    const inBody = scroller ? scroller.contains(target) : false;
    // §4「滚动不抢手势」：列表已经滚过顶部时，整体拖拽必须让位给列表滚动。
    // 列表在顶部（scrollTop=0）时才允许面板接管 —— 这正是「往下滑先是滚列表，
    // 滚到底才收抽屉」的手感来源。
    // （touch-action 的配合见 BottomSheet.module.css：面板是 pan-y 而不是 none，
    // 否则 body 的 pan-y 会被祖先进交集吃掉，原生滚动永远起不来。）
    if (inBody && scroller && scroller.scrollTop > 0) return;
    suppressClickRef.current = false;
    dragRef.current = {
      startY: event.clientY,
      from: stop,
      dy: 0,
      moved: false,
      startedInBody: inBody,
    };
    setDragging(true);
    // 只在把手 / 头部起手时才抓指针：落在列表里时不抓 —— 浏览器可能下一刻
    // 就要接管这次触摸去滚列表（随后会收到 pointercancel 复位）；抓了反而
    // 跟原生滚动抢。列表顶部且浏览器没接管时，move 事件照常冒泡到面板，拖拽不断。
    if (!inBody) event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel) return;
    // 从列表起手、但列表已经滚起来了（浏览器先接管、pointercancel 还在路上）：
    // 这次手势归滚动，面板复位、不改档。
    if (drag.startedInBody) {
      const scroller = bodyRef.current;
      if (scroller && scroller.scrollTop > 0) {
        dragRef.current = null;
        setDragging(false);
        resetDragStyle();
        return;
      }
    }
    const dy = event.clientY - drag.startY;
    drag.dy = dy;
    if (!drag.moved) {
      if (Math.abs(dy) <= DRAG_SLOP) return;
      drag.moved = true;
    }
    panel.style.transform = `translateY(${clampDragOffset(dy, panel.getBoundingClientRect().height)}px)`;
  }

  function endDrag() {
    const drag = dragRef.current;
    const panel = panelRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    // 位移没超过阈值 = 点按：原地复位，交给 click 正常走（点卡片进模块）
    if (!drag.moved) {
      resetDragStyle();
      return;
    }
    suppressClickRef.current = true;
    const outcome = resolveDragOutcome(drag.from, drag.dy);
    if (outcome.kind === "close") {
      // 从拖到的位置继续滑出：清掉「拖拽中禁过渡」后写目标值即可产生过渡
      if (panel) {
        panel.style.transition = "";
        panel.style.transform = "translateY(100%)";
      }
      onClose();
      return;
    }
    resetDragStyle();
    if (outcome.kind === "stop") onStopChange(outcome.stop);
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    endDrag();
  }

  /** 指针被浏览器抢走（触摸下开始滚列表）：复位但**不改档**，交给列表滚动 */
  function onPointerCancel() {
    dragRef.current = null;
    setDragging(false);
    resetDragStyle();
  }

  function onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  if (!mounted || !present) return null;

  return createPortal(
    <div
      className={s.root}
      data-sheet-root="true"
      data-open={open}
      data-scrim={open && modal}
      onClickCapture={onClickCapture}
    >
      <div
        className={s.scrim}
        data-sheet-scrim="true"
        data-on={open && modal}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        id={id}
        ref={(node) => {
          panelRef.current = node;
        }}
        className={s.panel}
        data-sheet={stop}
        data-open={open}
        data-dragging={dragging}
        role="dialog"
        // peek 是非模态档：aria-modal 必须是 false，否则读屏会以为页面其余部分不可用
        aria-modal={modal}
        aria-labelledby={titleId}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div className={s.grip} data-sheet-grip="true" aria-hidden="true">
          <span />
        </div>
        <div className={s.head}>
          <div className={s.ttl}>
            <b id={titleId}>{title}</b>
            {subtitle && <span>{subtitle}</span>}
          </div>
          {action}
        </div>
        <div
          ref={bodyRef}
          className={s.body}
          data-sheet-body="true"
          {...BODY_MARK}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
