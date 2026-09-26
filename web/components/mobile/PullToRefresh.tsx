"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const PULL_THRESHOLD = 56;
export const PULL_MAX = 96;

export function shouldTriggerRefresh(
  pullDistance: number,
  threshold: number = PULL_THRESHOLD,
): boolean {
  return pullDistance >= threshold;
}

export function clampPull(pullDistance: number, max: number = PULL_MAX): number {
  if (pullDistance <= 0) return 0;
  return Math.min(pullDistance, max);
}

type PtrState = "idle" | "pulling" | "refreshing" | "error";
type Direction = "pending" | "pull" | "ignore";

interface TouchTrack {
  startX: number;
  startY: number;
  direction: Direction;
}

export interface PullToRefreshProps {
  onRefresh: () => void | Promise<unknown>;
  children: React.ReactNode;
  label?: string;
}

const IGNORE_TARGET =
  'button, input, select, textarea, [contenteditable="true"], [role="slider"], [data-ptr-ignore]';

function hasNestedScroller(target: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = target; node && node !== root; node = node.parentElement) {
    const overflow = window.getComputedStyle(node).overflowY;
    if (/auto|scroll/.test(overflow) && node.scrollHeight > node.clientHeight + 1) return true;
  }
  return false;
}

export default function PullToRefresh({
  onRefresh,
  children,
  label = "下拉刷新",
}: PullToRefreshProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<TouchTrack | null>(null);
  const pullRef = useRef(0);
  const busyRef = useRef(false);
  const [state, setState] = useState<PtrState>("idle");
  const [pull, setPull] = useState(0);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");

  const setPullState = useCallback((next: PtrState, distance = 0) => {
    pullRef.current = distance;
    setState(next);
    setPull(distance);
  }, []);

  const finish = useCallback(async (trigger: boolean) => {
    if (busyRef.current) return;
    if (!trigger) {
      setPullState("idle");
      return;
    }
    busyRef.current = true;
    setError("");
    setPullState("refreshing");
    const started = Date.now();
    try {
      await onRefresh();
      // 本地快请求也留一点反馈时间，避免转环只闪一帧。
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 320 - (Date.now() - started))));
      setCount((n) => n + 1);
      setPullState("idle");
    } catch (cause) {
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 320 - (Date.now() - started))));
      setError(cause instanceof Error && cause.message ? cause.message : "刷新失败，请重试");
      setPullState("error");
    } finally {
      busyRef.current = false;
    }
  }, [onRefresh, setPullState]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reset = () => {
      trackRef.current = null;
      if (!busyRef.current) setPullState("idle");
    };
    const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 1;
    const onStart = (event: TouchEvent) => {
      if (
        busyRef.current || event.touches.length !== 1 || !atTop() ||
        !window.matchMedia("(max-width: 767px)").matches ||
        document.body.style.overflow === "hidden"
      ) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(IGNORE_TARGET) || hasNestedScroller(target, root)) return;
      trackRef.current = {
        startX: event.touches[0].clientX,
        startY: event.touches[0].clientY,
        direction: "pending",
      };
    };
    const onMove = (event: TouchEvent) => {
      const track = trackRef.current;
      if (!track || busyRef.current) return;
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      const dx = event.touches[0].clientX - track.startX;
      const dy = event.touches[0].clientY - track.startY;
      if (track.direction === "pending" && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
        track.direction = dy > 0 && dy > Math.abs(dx) * 1.25 ? "pull" : "ignore";
      }
      if (track.direction !== "pull") return;
      if (dy <= 0) {
        reset();
        return;
      }
      if (event.cancelable) event.preventDefault();
      setPullState("pulling", clampPull(dy));
    };
    const onEnd = () => {
      const track = trackRef.current;
      trackRef.current = null;
      if (!track || busyRef.current) return;
      void finish(track.direction === "pull" && shouldTriggerRefresh(pullRef.current));
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", reset);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", reset);
    };
  }, [finish, setPullState]);

  const pulling = state === "pulling";
  const message = state === "refreshing"
    ? "正在刷新"
    : state === "error"
      ? error
      : pulling && shouldTriggerRefresh(pull)
        ? "松开刷新"
        : label;

  return (
    <div ref={rootRef} data-ptr="" data-ptr-state={state} data-ptr-count={count}>
      <div
        className="ptr"
        data-ptr-state={state}
        style={pulling ? { height: pull } : undefined}
        role={state === "refreshing" || state === "error" ? "status" : undefined}
        aria-live={state === "refreshing" || state === "error" ? "polite" : undefined}
        aria-hidden={state === "idle" ? true : undefined}
      >
        {state !== "error" && <span className="ptr-ring" aria-hidden="true" />}
        <span className="ptr-label">{message}</span>
        {state === "error" && (
          <button type="button" className="ptr-retry" onClick={() => void finish(true)}>
            重试
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
