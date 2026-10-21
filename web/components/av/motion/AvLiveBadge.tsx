"use client";

import { useEffect, useState } from "react";
import { useMotionNow } from "./AvMotion";
import { formatTimecode } from "@/lib/av/timecode";

/**
 * 通道卡的「录制中」标记（Stage 3 / BLF-1425）。
 *
 * 三件事：
 *   · 呼吸点：CSS keyframes（`avLivePulse`），只动 opacity / transform；
 *   · 时间码递增：每张卡一个 1s 定时器，只重渲染这个 span（不牵动整页）；
 *   · 离线：灰态 + `--:--:--`，不挂动画、不起定时器。
 *
 * 为什么时间码的初值来自 props 而不是 `Date.now()`：SSR 与客户端首帧必须是同一个
 * 字符串，否则 hydration 会不匹配；`?static=1` 连拍 3 次也必须完全一致。
 *
 * 为什么用 `useMotionNow()` 而不是上下文的 `enabled`：`?static=1` 的开关在首帧前就
 * 挂在 <html> 上了（内联脚本），同步读能在**第一次 effect** 就决定起不起定时器；
 * 上下文要等 provider 的 effect 才同步完，那时定时器已经可能跑过一拍。
 * 时间码只在客户端递增，不影响 SSR 标记，因此同步读属性不会造成水合错位。
 */
/** 通道帧号：`startSeconds` + 已运行的秒数（动效关闭时恒等于 startSeconds）。 */
export function useChannelClock(startSeconds: number): number {
  const enabled = useMotionNow();
  const [ticks, setTicks] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setTicks(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setTicks(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      window.clearInterval(timer);
      setTicks(0);
    };
  }, [enabled]);

  return Math.max(0, startSeconds + ticks);
}

export type AvLiveState = "online" | "offline" | "maintenance";

export default function AvLiveBadge({
  state,
  frame,
  className,
}: {
  state: AvLiveState;
  frame: number;
  /** 外层结构样式由页面 CSS 提供（`.channelLive` 的定位与胶囊外观在这里之外）。 */
  className?: string;
}) {
  const live = state === "online";
  return (
    <span className={className} data-live={live ? "on" : "off"} data-frame={frame}>
      <i aria-hidden="true" />
      <span data-live-label="">{live ? "LIVE" : "OFFLINE"}</span>
      {live && (
        <time data-live-clock="" dateTime={`PT${Math.max(0, Math.floor(frame))}S`}>
          {formatTimecode(frame)}
        </time>
      )}
    </span>
  );
}
