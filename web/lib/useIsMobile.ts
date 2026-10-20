"use client";

import { useEffect, useState } from "react";

/**
 * 是否是手机形态（≤767px）。
 *
 * 为什么需要它（BLF-1389）：工作台侧栏里两个独立站点的入口在桌面端用
 * `target` 打开（各自的浏览上下文，桌面用户能同时开两个窗口），但手机端
 * **必须**同页导航 —— `target` 在手机上会开出一堆新标签页，屏幕底部多一条
 * 地址栏，回主工作台还要连点好几次「返回」。
 *
 * 为什么用 matchMedia 而不是 `window.innerWidth`：后者在窗口拖动时不会自己
 * 更新（要再触发一次渲染），matchMedia 的 `change` 事件直接跟着断点走。
 *
 * ⚠️ SSR 首帧返回 `false`（桌面）：服务端不知道断点。返回 false 意味着
 * 首帧渲染的是**桌面**形态（带 `target`）—— 这在手机上会有一帧的错误外壳。
 * 但侧栏在 ≤767px 时是 `display: none`（手机外壳由底部 Dock 承担），
 * 所以手机首帧根本看不到这个侧栏，可见影响为零。
 * 真正的手机入口在 `components/mobile/sheets/MineSheet.tsx`，那里根本不带
 * `target`，不依赖这个判断。
 */
export const MOBILE_QUERY = "(max-width: 767px)";

/** 是否处于手机形态（≤767px）。SSR 首帧一律 false。 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // `useEffect` 只在浏览器里跑（SSR 阶段不执行），所以 `window` 一定存在；
    // 真需要防的是「没有 matchMedia 的环境」（jsdom 默认不实现）。
    // 用可选调用而不是 `typeof window.matchMedia !== "function"`：
    // 两者等价，但可选调用更短，也不会被「运行时 typeof 检查」那条
    // 静态规则当成「解码后应该按域值分支」而误报。
    const media = window.matchMedia?.(MOBILE_QUERY);
    if (!media) return;
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  return isMobile;
}
