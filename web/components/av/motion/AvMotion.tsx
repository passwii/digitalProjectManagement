"use client";

/**
 * /av 的动效基元（Stage 3）。
 *
 * 这一层只做「把入场 / 揭示挂到既有的 data-motion-* 挂载点上」，不改任何组件
 * 结构 —— Stage 2 已经把 key 与 DOM 顺序铺好了。
 *
 * 三个共同约定：
 *   · 动画时长与曲线全部来自 CSS 变量（`--av-dur-*` / `--av-ease-*`），本目录的
 *     组件不写毫秒字面量，因此 `?static=1` 与 prefers-reduced-motion 一关全关；
 *   · 只动 transform / opacity；
 *   · 降级时**不挂任何动画 class**，让元素停在自然态（而不是靠动画补到终态），
 *     这样截图与「JS 没加载」都是同一个静态页面。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AV_MOTION_ATTRIBUTE, AV_STAGGER, avStaggerSeconds } from "@/lib/av/motion";
import { useAvMotion } from "./AvMotionProvider";
import s from "./AvMotion.module.css";

/**
 * 页面切换入场：换页时播一次 8px 上浮 + 淡入（base）。
 *
 * 两个实现细节都是踩出来的：
 *
 * ① **不能用 `key={pathname}` 重挂载来重播**。告警 / 设备的详情抽屉会调
 *    `history.replaceState` 把地址对齐到 `/av/alarm/AL-00037`，pathname 一变，
 *    整棵子树就被卸载重建 —— 抽屉（原生 <dialog>）连同 state 一起消失，
 *    点一下告警卡片什么都不会弹出来。改成「同一个节点上重播 CSS 动画」：
 *    移除 class → 强制回流 → 加回 class。
 *
 * ② **用「分区键」而不是完整 pathname 当判定**。`/av/alarm` → `/av/alarm/AL-00042`
 *    是同一次交互（打开详情），不该重播整页入场；只有 `/av/overview` → `/av/alarm`
 *    这种真的换页才播。所以键取前两段路径。
 */
function routeKeyOf(pathname: string): string {
  return pathname.split("/").slice(0, 3).join("/");
}

export function AvPageTransition({ children }: { children: ReactNode }) {
  const { enabled } = useAvMotion();
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const key = routeKeyOf(pathname);
  const lastKey = useRef(key);

  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    if (lastKey.current === key) return;
    lastKey.current = key;
    node.classList.remove(s.pageIn);
    // 读一次 offsetWidth 强制让浏览器提交「无动画」这一帧，否则移除+加回会被合并
    void node.offsetWidth;
    node.classList.add(s.pageIn);
  }, [enabled, key]);

  if (!enabled) return <div ref={ref}>{children}</div>;
  return (
    <div ref={ref} className={s.pageIn} data-motion="page">
      {children}
    </div>
  );
}

/**
 * 滚动进入视口时播一次的面板（`once`）。
 *
 * 用 IntersectionObserver 而不是 framer 的 `whileInView`：首屏之外的面板有十几个，
 * framer 每个都要挂一个 MotionValue + 观测器；这里一个原生 observer 管一批，
 * 命中后 `disconnect()`，之后完全不参与渲染，也不会在反复滚动时重播。
 */
export function AvPanelReveal({
  children,
  index = 0,
  className,
}: {
  children: ReactNode;
  index?: number;
  className?: string;
}) {
  const { enabled } = useAvMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!enabled || shown) return;
    const node = ref.current;
    // 没有 IntersectionObserver（老浏览器 / jsdom）时直接落到终态，不做「永远透明」
    if (!node || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, shown]);

  if (!enabled) return <div className={className}>{children}</div>;
  return (
    <div
      ref={ref}
      className={`${s.inView} ${className ?? ""}`}
      data-av-inview={shown ? "on" : undefined}
      data-motion="in-view"
      style={{ "--av-i": Math.min(index, AV_STAGGER.max) } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * 列表项错峰进场的 className + 内联 `--av-i`。
 *
 * 返回「可以直接挂到 <li> 上的 className / style」，不包 wrapper ——
 * 列表语义（ul > li）不能被动画层多加一层 div 破坏，`layout` FLIP 也要求
 * 兄弟节点就是真实的列表项。
 *
 * 超过 `AV_STAGGER.longList`（100）行整段不做入场（Stage 3 性能硬约束）。
 */
export function staggerProps(
  index: number,
  total: number,
  enabled: boolean,
): {
  className: string;
  style: CSSProperties;
} {
  if (!enabled || total > AV_STAGGER.longList) {
    return { className: "", style: {} };
  }
  // 前 10 条错峰，第 11 条起不再延迟（否则 50 条列表最后一条要等 1.5s）
  const step = avStaggerSeconds(index, total);
  const normalized = AV_STAGGER.list > 0 ? Math.round(step / AV_STAGGER.list) : 0;
  return {
    className: s.itemIn,
    style: { "--av-i": normalized } as CSSProperties,
  };
}

/** `staggerProps` 的 hook 版（组件顶层用）。 */
export function useStaggerIndex(index: number, total: number): {
  className: string;
  style: CSSProperties;
} {
  const { enabled } = useAvMotion();
  return staggerProps(index, total, enabled);
}

/**
 * 同步读一次开关（含 `<html data-av-motion>`）。
 *
 * 只给「客户端才渲染」的东西用（图表、数字滚动、游标）：这些组件在 SSR 里根本
 * 不产出最终 DOM（图表要等调色板 effect、数字要等 animate），所以同步读 DOM 属性
 * 不会造成水合错位。
 *
 * 反过来，**会影响 SSR 标记**的组件（页面切换包装、Tab 滑块、导航滑块）必须只用
 * 上下文里的 `enabled`：服务端不知道 `?static=1`，同步读会让首帧标记与 HTML 不一致，
 * React 会报水合失败。它们晚一帧关掉动画即可 —— 静态截图本来就发生在水合之后。
 */
export function useMotionNow(): boolean {
  const { enabled } = useAvMotion();
  if (!enabled) return false;
  if (typeof document === "undefined") return true;
  return document.documentElement.getAttribute(AV_MOTION_ATTRIBUTE) !== "off";
}

/**
 * 播放游标：`requestAnimationFrame` 驱动，**不用 CSS transition**。
 *
 * 为什么必须 rAF：CSS 过渡的插值起点是「上一帧的渲染值」，游标会一直落后
 * 一两帧，而且越拖越远；rAF 每帧直接写 `transform: translateX(%)`，与时间轴同源。
 *
 * 频谱是 canvas 2D 矩阵（96 × 480），游标是**独立的一层 DOM**（不画在 canvas 上），
 * 所以每帧只改这一个元素的 transform，既不重绘 canvas，也不触发 React 重渲染
 * —— 只有「当前句索引」变化时才 setState（每句一次，不是每帧）。
 *
 * @param duration  时间轴总长（秒）
 * @param playing   是否在播
 * @param onChange  当前时间变化（秒）；只在跨句时被组件用来切高亮
 */
export function usePlayhead(
  duration: number,
  playing: boolean,
  onChange: (seconds: number) => void,
): { barRef: React.MutableRefObject<HTMLSpanElement | null>; reset: () => void } {
  const barRef = useRef<HTMLSpanElement | null>(null);
  const startAt = useRef(0);
  const offset = useRef(0);
  const notify = useRef(onChange);
  notify.current = onChange;

  /** 回到 0：播完之后再点播放要从头走，否则会立刻又停在末尾。 */
  const reset = () => {
    offset.current = 0;
    if (barRef.current) barRef.current.style.transform = "translateX(0%)";
  };

  useEffect(() => {
    if (!playing) return;
    // 续播：从上次暂停的位置接着走，不回到 0
    startAt.current = performance.now() - offset.current * 1000;
    let frame = 0;
    const total = duration > 0 ? duration : 1;
    const tick = () => {
      const seconds = (performance.now() - startAt.current) / 1000;
      const clamped = Math.min(total, Math.max(0, seconds));
      offset.current = clamped;
      if (barRef.current) {
        barRef.current.style.transform = `translateX(${((clamped / total) * 100).toFixed(3)}%)`;
      }
      notify.current(clamped);
      if (clamped >= total) return; // 播完停在末尾，不再申请下一帧
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [duration, playing]);

  return { barRef, reset };
}

export const avMotionClasses = s;
