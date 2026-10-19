"use client";

import { animate, m } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCountValue, parseCountValue } from "@/lib/av/motion";
import { useAvMotion } from "./AvMotionProvider";
import { useMotionNow } from "./AvMotion";
import s from "./AvMotion.module.css";

/**
 * KPI 数字滚动（slow）。
 *
 * 进入视口时从 0 滚到目标值，**只播一次**；`tabular-nums` 由 `.metricValue`
 * 的 CSS 统一给（等宽数字，滚动时宽度不抖）。
 *
 * 数据来源是 `AvMetric` 的 `value` 字符串（"99.8" / "14,366"）—— 这里只用
 * `parseCountValue` 拆出数字，前后缀与千分位原样保留，所以「99.8%」「14,366 条」
 * 滚完与静态文本逐字一致。解析失败（"—"、"无数据"）直接原样输出，绝不滚成 0。
 */
export default function AvCounter({ value, className }: { value: string; className?: string }) {
  // 数字滚动只在客户端发生（effect 里 animate），所以可以同步读截图开关：
  // `?static=1` 下从**第一次渲染**就停在终值，不会先滚一遍再跳回来。
  const enabled = useMotionNow();
  const { duration } = useAvMotion();
  /*
   * `parseCountValue` 每次渲染都返回**新对象**：若直接进 effect 依赖，滚动过程中
   * 每帧的 setDisplay 都会让 effect 重跑，而重跑的清理 + started 判断会把它拉回终值
   * —— 表现就是「数字闪一下就定住」。所以按 value 记忆一次。
   */
  const parsed = useMemo(() => parseCountValue(value), [value]);
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || !parsed || started.current) {
      setDisplay(value);
      return;
    }
    const node = ref.current;
    if (!node) return;

    const run = () => {
      if (started.current) return;
      started.current = true;
      const controls = animate(0, parsed.value, {
        duration: duration("slow"),
        ease: "easeOut",
        onUpdate: (next) => setDisplay(formatCountValue(next, parsed)),
      });
      return controls;
    };

    // 没有 IntersectionObserver（老浏览器 / jsdom）时直接落到终值，不留在 0
    if (typeof IntersectionObserver === "undefined") {
      setDisplay(value);
      return;
    }
    let controls: { stop: () => void } | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            controls = run();
            observer.disconnect();
          }
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      controls?.stop();
    };
    // parsed 由 value 决定，value 变才需要重跑
  }, [enabled, parsed, duration, value]);

  return (
    <span ref={ref} className={className}>
      {display}
    </span>
  );
}

/**
 * Tab / 分段控件的滑块（`layoutId` 共享布局动画，base + standard）。
 *
 * 每组分段控件用自己的 id（`useId`）—— 同一页有 3 组筛选（级别 / 场景 / 状态），
 * 共用一个 layoutId 会让滑块在三组之间穿越页面飞。
 */
export function AvTabSlider({ groupId, label }: { groupId: string; label: string }) {
  const { enabled, duration, ease } = useAvMotion();
  if (!enabled) return null;
  return (
    <m.span
      layoutId={`av-tab-${groupId}`}
      className={s.tabSlider}
      transition={{ duration: duration("base"), ease: ease("standard") }}
      aria-hidden="true"
      data-tab-label={label}
    />
  );
}

/**
 * 新告警从顶部插入：整条淡入 + 下移，其余卡片靠 `layout`（FLIP）自己让位。
 *
 * 只对**新增**的项播一次（调用方把 `fresh` 传进来），历史项不重播。
 */
export function AvInsertedItem({ children, className }: { children: React.ReactNode; className?: string }) {
  const { enabled, duration, ease } = useAvMotion();
  if (!enabled) return <li className={className}>{children}</li>;
  return (
    <m.li
      /* 同 AlarmRow：只投影位置，不投影尺寸（否则行高会被压扁一下） */
      layout="position"
      className={className}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: duration("base"), ease: ease("enter") } }}
    >
      {children}
    </m.li>
  );
}

/** 骨架屏：同尺寸占位，数据到达后由 `AvSkeletonSwap` 交叉淡入。 */
export function AvSkeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={`${className ?? ""} ${s.skeleton}`} style={style} aria-hidden="true" />;
}

/** 骨架 → 真数据的交叉淡入（base）。 */
export function AvSkeletonSwap({ children }: { children: React.ReactNode }) {
  const { enabled } = useAvMotion();
  if (!enabled) return <>{children}</>;
  return <div className={s.skeletonSwap}>{children}</div>;
}
