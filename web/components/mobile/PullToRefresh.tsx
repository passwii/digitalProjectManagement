"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageRefresh } from "@/lib/pageRefresh";

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

const IGNORE_TARGET =
  'button, input, select, textarea, [contenteditable="true"], [role="slider"], [role="dialog"], [data-ptr-ignore], [aria-modal="true"]';

function pageIsAtTop(target: HTMLElement): boolean {
  // A nested list or panel can have its own scroll position. Only refresh when every
  // scroll container between the touch point and the document is already at its top.
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const overflowY = window.getComputedStyle(node).overflowY;
    const scrollable = /auto|scroll|overlay/.test(overflowY) && node.scrollHeight > node.clientHeight + 1;
    if (scrollable && node.scrollTop > 1) return false;
  }

  const documentScroller = document.scrollingElement as HTMLElement | null;
  return window.scrollY <= 1 &&
    document.documentElement.scrollTop <= 1 &&
    document.body.scrollTop <= 1 &&
    (!documentScroller || documentScroller.scrollTop <= 1);
}

function eventElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Element && target.parentElement instanceof HTMLElement) return target.parentElement;
  return null;
}

/** One app-wide, browser-style pull gesture shared by every route in the root layout. */
export default function PullToRefresh() {
  const refresh = usePageRefresh();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const trackRef = useRef<TouchTrack | null>(null);
  const pullRef = useRef(0);
  const busyRef = useRef(false);
  const [state, setState] = useState<PtrState>("idle");
  const [pull, setPull] = useState(0);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");

  const reset = useCallback(() => {
    trackRef.current = null;
    if (busyRef.current) return;
    pullRef.current = 0;
    setPull(0);
    setState("idle");
  }, []);

  const refreshNow = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    setState("refreshing");
    const started = Date.now();
    try {
      await refreshRef.current();
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 360 - (Date.now() - started))));
      setCount((current) => current + 1);
      pullRef.current = 0;
      setPull(0);
      setState("idle");
    } catch (cause) {
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 360 - (Date.now() - started))));
      setError(cause instanceof Error && cause.message ? cause.message : "刷新失败，请重试");
      setState("error");
    } finally {
      busyRef.current = false;
    }
  }, []);

  const finish = useCallback((trigger: boolean) => {
    if (trigger) void refreshNow();
    else reset();
  }, [refreshNow, reset]);

  useEffect(() => {
    const onStart = (event: TouchEvent) => {
      if (
        busyRef.current || event.touches.length !== 1 ||
        !window.matchMedia("(max-width: 767px)").matches ||
        document.body.style.overflow === "hidden"
      ) return;

      const target = eventElement(event.target);
      if (!target || target.closest(IGNORE_TARGET) || !pageIsAtTop(target)) return;

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
      const distance = clampPull(dy);
      pullRef.current = distance;
      setPull(distance);
      setState("pulling");
    };

    const onEnd = () => {
      const track = trackRef.current;
      trackRef.current = null;
      if (!track || busyRef.current) return;
      finish(track.direction === "pull" && shouldTriggerRefresh(pullRef.current));
    };

    // Capture at the window so page layouts, portals, and nested scrollers all share
    // the same gesture handling. Prevent the browser bounce only after a downward pull
    // has clearly started, so taps and horizontal swipes retain their normal behavior.
    window.addEventListener("touchstart", onStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onMove, { capture: true, passive: false });
    window.addEventListener("touchend", onEnd, true);
    window.addEventListener("touchcancel", reset, true);
    return () => {
      window.removeEventListener("touchstart", onStart, true);
      window.removeEventListener("touchmove", onMove, true);
      window.removeEventListener("touchend", onEnd, true);
      window.removeEventListener("touchcancel", reset, true);
    };
  }, [finish, reset]);

  const message = state === "refreshing"
    ? "正在刷新"
    : state === "error"
      ? error
      : state === "pulling" && shouldTriggerRefresh(pull)
        ? "松开以刷新"
        : "下拉刷新";

  return (
    <div
      className="ptr"
      data-ptr=""
      data-ptr-state={state}
      data-ptr-count={count}
      style={{ "--ptr-distance": `${pull}px` } as React.CSSProperties}
      aria-hidden={state === "idle" ? true : undefined}
    >
      <span className="ptr-ring" aria-hidden="true" />
      <span
        className="ptr-label"
        role={state === "refreshing" || state === "error" ? "status" : undefined}
        aria-live={state === "refreshing" || state === "error" ? "polite" : undefined}
      >
        {message}
      </span>
      {state === "error" && (
        <button type="button" className="ptr-retry" onClick={() => void refreshNow()}>
          重试
        </button>
      )}
    </div>
  );
}
