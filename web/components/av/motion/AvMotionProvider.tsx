"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LazyMotion, MotionConfig, type domMax } from "framer-motion";
import { usePathname } from "next/navigation";
import {
  AV_MOTION_ATTRIBUTE,
  AV_MOTION_ENABLED,
  avDurationMs,
  avDurationSeconds,
  avEase,
  isMotionEnabled,
  parseStaticMode,
  type AvDurationToken,
  type AvEaseToken,
  type AvMotionState,
} from "@/lib/av/motion";

/**
 * `/av` 的动效状态上下文。
 *
 * 两个开关合流成一个「还能不能动」的判定：
 *   · `prefers-reduced-motion: reduce`（系统设置，用 framer 的 useReducedMotion 读）；
 *   · `?static=1`（截图 / 录屏开关，用 URL 读）。
 *
 * 为什么不把 `?static=1` 写成 useSearchParams：它是 client bailout —— 包住谁，
 * 谁就不进静态 HTML（Stage 2 已经为此把 `?q=` 隔离成一个小组件，见 lib/avSsrGuard）。
 * 这里只需要一个布尔开关，读 `window.location.search` 就够了，且**不能**触发 bailout。
 * 首帧的开关由 app/av/layout.tsx 的内联脚本预先挂到 <html> 上，本组件只负责
 * 客户端导航时把属性同步回去（`?static=1` 在站内跳转后会从地址栏消失，属性要留在
 * 根节点上，否则录到一半动效又自己回来了）。
 */

interface AvMotionContextValue extends AvMotionState {
  /** 是否允许播放动效（两个开关都开时为 true）。 */
  enabled: boolean;
  /** 时长（秒），降级时为 0。 */
  duration: (token: AvDurationToken) => number;
  /** 时长（毫秒），给 recharts 这类只吃毫秒的 API。 */
  durationMs: (token: AvDurationToken) => number;
  /** 曲线四元组。 */
  ease: (token: AvEaseToken) => [number, number, number, number];
}

const AvMotionContext = createContext<AvMotionContextValue>({
  ...AV_MOTION_ENABLED,
  enabled: true,
  duration: (token) => avDurationSeconds(token),
  durationMs: (token) => avDurationMs(token),
  ease: (token) => avEase(token),
});

export function useAvMotion(): AvMotionContextValue {
  return useContext(AvMotionContext);
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 减少动效偏好（自己读，不用 framer 的 `useReducedMotion`）。
 *
 * 为什么不用 framer 的：它在模块首次被调用时把偏好缓存在一个 module-level ref 里，
 * 之后不再跟随系统设置变化，也无法在 SSR 与测试里稳定注入（踩过：CDP 里把
 * 媒体特性强制成 reduce，`useReducedMotion()` 仍然返回 false，于是页面比预期多包了
 * 一层动画节点）。这里自己订阅 change 事件，用户中途改系统设置也会立刻生效。
 *
 * 初值固定 `false`、在 effect 里同步 —— 服务端不知道用户偏好，如果直接拿
 * matchMedia 当 useState 初值，hydration 前后分支不一致会报错。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_QUERY);
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/**
 * framer 特性集按需加载（异步）。
 *
 * 为什么不用同步的 `domMax`：它把 drag 也一并打进 `/av` 的首屏 JS —— 实测
 * First Load JS 从 241 kB 涨到 298 kB，而 `/av` 一个拖拽都没有。改成动态 import
 * 之后首屏 281 kB、特性包在 hydration 后单独拉一次，导航高亮 / Tab 滑块 /
 * 列表 FLIP 都在用户真正操作之前就绪。
 *
 * 类型上仍然要求 `domMax`：`domAnimation` 里没有 `layout`，layoutId 会静默失效
 * （framer 最典型的坑，见下面 LazyMotion 处的注释）。
 */
const loadAvMotionFeatures = () => import("framer-motion").then((mod) => mod.domMax) as Promise<typeof domMax>;

export default function AvMotionProvider({ children }: { children: React.ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const [frozen, setFrozen] = useState(false);
  const pathname = usePathname();

  /**
   * 读取地址栏并把开关落到 <html> 上。
   *
   * 只在「有 static 参数」时改状态：站内跳转后参数消失，不能因此把开关关掉
   * （录屏时点进详情再跳回来，动效不该自己复活）。
   */
  const sync = useCallback(() => {
    const search = window.location.search;
    if (!search) return;
    const next = parseStaticMode(search);
    const root = document.documentElement;
    if (next) {
      root.setAttribute(AV_MOTION_ATTRIBUTE, "off");
      setFrozen(true);
    } else if (search.includes("static=")) {
      // 显式传了 static=0 / static=false：本次会话解除冻结
      root.removeAttribute(AV_MOTION_ATTRIBUTE);
      setFrozen(false);
    }
  }, []);

  useEffect(() => {
    sync();
    // 首次挂载时把内联脚本可能已经挂好的状态读回来（脚本只写属性，不写 React state）
    setFrozen(document.documentElement.getAttribute(AV_MOTION_ATTRIBUTE) === "off");
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [pathname, sync]);

  const value = useMemo<AvMotionContextValue>(() => {
    const state: AvMotionState = { reduced, frozen };
    return {
      reduced,
      frozen,
      enabled: isMotionEnabled(state),
      duration: (token) => avDurationSeconds(token, state),
      durationMs: (token) => avDurationMs(token, state),
      ease: (token) => avEase(token),
    };
  }, [frozen, reduced]);

  return (
    <AvMotionContext.Provider value={value}>
      {/*
        MotionConfig 是 framer 自带的降级总闸：
          · reducedMotion="always" —— 减少动效时只保留 opacity / 颜色，位移与缩放交给
            framer 自己吃掉，比在每个组件里手写 if (reduced) 更不容易漏；
          · frozen 时把默认 transition 时长压成 0，任何忘记读 duration() 的写法也不会动。
      */}
      <MotionConfig
        reducedMotion={reduced ? "always" : "never"}
        transition={value.enabled ? undefined : { duration: 0 }}
      >
        {/*
          用 `domMax` 而不是 `domAnimation`：`layoutId`（导航高亮滑块、Tab 滑块、
          抽屉内容 morph）属于 layout 特性，`domAnimation` 里没有，用 `m` 组件时会
          静默不生效（这是 framer 最典型的坑）。
          `strict` 保证没人从 `motion` 而不是 `m` 里引组件 —— 那样会把整套特性打进
          每个页面的 chunk，`/av` 的 6 个页面各来一份。
        */}
        <LazyMotion features={loadAvMotionFeatures} strict>
          {children}
        </LazyMotion>
      </MotionConfig>
    </AvMotionContext.Provider>
  );
}
