"use client";

// 自建下拉刷新（BLF-1127/S6，契约 §6「overscroll」行）。
//
// standalone 下没有浏览器原生下拉刷新（整页橡皮筋还会被
// `overscroll-behavior-y: contain` 关掉），所以手势与指示器都自己做；
// 阈值 56px / 指示器 44px / 转环语义对齐原型 §6（`docs/prototypes/.../index.html` 的 ptr 段）。
//
// 只在「页面已滚到顶部」时接管向下拉的手势，其它情况直接放行 —— 列表滚动、
// 抽屉手势、横滑都不受影响。样式只认 `data-ptr-state`（定义见 globals.css 的
// PWA 段），走查脚本（S6 段）与单测都走这个契约面，不读 React 内部 state。
//
// 状态机：idle → pulling（手指没松，指示器跟手）→ refreshing（松手且越线，
// 调 onRefresh）→ idle。`data-ptr-count` 记录成功刷新的次数（走查断言用）。
//
// 离线兜底按契约：这里不做离线写缓存 —— onRefresh 失败时只把错误读出来
//（role=status），数据口径仍由各页面的 LoadFailed 负责。

import { useCallback, useRef, useState } from "react";

/** 越过这条线松手才刷新（px）。与原型一致；改了要同步改走查里的 PULL_PX。 */
export const PULL_THRESHOLD = 56;
/** 指示器最大跟手距离（px）：再往下拉也不再跟，避免整块内容被拽走。 */
export const PULL_MAX = 96;

/** 纯函数：这次松手该不该刷新 —— 单测直接钉，不用起 DOM。 */
export function shouldTriggerRefresh(
  pullDistance: number,
  threshold: number = PULL_THRESHOLD,
): boolean {
  return pullDistance >= threshold;
}

/** 纯函数：指示器跟手高度（钳住上限，负值归零）—— 单测直接钉。 */
export function clampPull(pullDistance: number, max: number = PULL_MAX): number {
  if (pullDistance <= 0) return 0;
  return Math.min(pullDistance, max);
}

type PtrState = "idle" | "pulling" | "refreshing";

export interface PullToRefreshProps {
  /** 松手越线后调用；返回 promise 则指示器等它落定再收（默认等一帧，避免闪一下）。 */
  onRefresh: () => void | Promise<unknown>;
  children: React.ReactNode;
  /** 读屏文案（默认「下拉刷新」）。 */
  label?: string;
}

export default function PullToRefresh({
  onRefresh,
  children,
  label = "下拉刷新",
}: PullToRefreshProps) {
  const [state, setState] = useState<PtrState>("idle");
  const [pull, setPull] = useState(0);
  const [count, setCount] = useState(0);
  const track = useRef<{ startY: number; active: boolean }>({ startY: 0, active: false });
  const stateRef = useRef<PtrState>("idle");
  const pullRef = useRef(0);
  const busyRef = useRef(false);

  const setBoth = useCallback((next: PtrState, distance: number) => {
    stateRef.current = next;
    pullRef.current = distance;
    setState(next);
    setPull(distance);
  }, []);

  const atTop = useCallback(() => {
    // 页面滚动在 document 上（手机端内容区本身不建滚动容器）：只要窗口没往下滚就算到顶。
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    return y <= 1;
  }, []);

  const finish = useCallback(
    async (shouldRefresh: boolean) => {
      if (!shouldRefresh) {
        setBoth("idle", 0);
        return;
      }
      busyRef.current = true;
      setBoth("refreshing", 0);
      try {
        await onRefresh();
      } catch {
        // 刷新失败不断言、不抛到 error boundary：指示器收起，错误由各页面的
        // LoadFailed 负责口径（契约：不断网写缓存，只保证有明确错误与重试）。
      } finally {
        busyRef.current = false;
        setCount((n) => n + 1);
        setBoth("idle", 0);
      }
    },
    [onRefresh, setBoth],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (busyRef.current || !atTop()) return;
      track.current = { startY: e.touches[0].clientY, active: true };
    },
    [atTop],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!track.current.active || busyRef.current) return;
      const dy = e.touches[0].clientY - track.current.startY;
      if (dy <= 0) {
        // 中途改成往上滑：这不是一次下拉，直接复位（不 preventDefault，不抢滚动）。
        track.current.active = false;
        setBoth("idle", 0);
        return;
      }
      setBoth("pulling", clampPull(dy));
    },
    [setBoth],
  );

  const onTouchEnd = useCallback(() => {
    if (!track.current.active || busyRef.current) return;
    track.current.active = false;
    void finish(shouldTriggerRefresh(pullRef.current));
  }, [finish]);

  // 桌面鼠标拖拽（原型同口径）：不断文本选择（不 preventDefault），只认「到顶 + 下拉」。
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (busyRef.current || e.button !== 0 || !atTop()) return;
      track.current = { startY: e.clientY, active: true };
    },
    [atTop],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!track.current.active || busyRef.current || e.buttons === 0) return;
      const dy = e.clientY - track.current.startY;
      if (dy <= 0) {
        track.current.active = false;
        setBoth("idle", 0);
        return;
      }
      setBoth("pulling", clampPull(dy));
    },
    [setBoth],
  );

  const onMouseUp = useCallback(() => {
    if (!track.current.active || busyRef.current) return;
    track.current.active = false;
    void finish(shouldTriggerRefresh(pullRef.current));
  }, [finish]);

  const refreshing = state === "refreshing";
  const pulling = state === "pulling" && pull > 0;

  return (
    <div
      data-ptr=""
      data-ptr-state={state}
      data-ptr-count={count}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* 指示器：pulling 时行内高度跟手，refreshing 时由 CSS 定到 44px。 */}
      <div
        className="ptr"
        data-ptr-state={state}
        style={pulling ? { height: pull } : undefined}
        aria-hidden={refreshing ? undefined : true}
        role={refreshing ? "status" : undefined}
      >
        <span className="ptr-ring" aria-hidden="true" />
        <span className="sr-only">
          {refreshing ? "正在刷新" : pulling ? `${label}，释放立即刷新` : label}
        </span>
      </div>
      {children}
    </div>
  );
}
