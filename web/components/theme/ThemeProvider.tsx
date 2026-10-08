"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  MEDIA_QUERY,
  applyTheme,
  readAppliedTheme,
  startThemeSwap,
} from "@/lib/themeTransition";
import {
  THEME_STORAGE_KEY,
  parseStoredTheme,
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const DEFAULT_THEME_CONTEXT: ThemeContextValue = {
  mode: "dark",
  resolvedTheme: "dark",
  setMode: () => {},
};
const ThemeContext = createContext<ThemeContextValue>(DEFAULT_THEME_CONTEXT);

function readStoredMode(): ThemeMode {
  try {
    return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

/** 首屏先于 React 读取主题选择，避免浅色用户刷新时看到一帧深色。 */
export const themeBootstrapScript = `(() => {
  try {
    const stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    const mode = stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
    const prefersDark = window.matchMedia(${JSON.stringify(MEDIA_QUERY)}).matches;
    const resolved = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();`;

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [prefersDark, setPrefersDark] = useState(false);
  /**
   * 首帧主题由 themeBootstrapScript 直接写在 `<html>` 上，而 React 要等挂载 effect 里
   * 读完 localStorage 才知道用户选了什么（useState 的初值只能给 "dark"，否则服务端渲染
   * 与客户端首帧不一致）。所以读出来之前不许写 html：否则默认值 "dark" 会盖掉 bootstrap
   * 写好的浅色，浅色用户刷新时白闪一帧深色——那正是这次要消灭的「生硬」。
   */
  const [ready, setReady] = useState(false);
  /** 上一次真正落到 `<html>` 上的主题：判断这次是不是「用户看得见的切换」，以及过场方向。 */
  const appliedTheme = useRef<ResolvedTheme | null>(null);
  /** 进行中的过场收尾句柄；连着快速切换时先把上一场收尾，避免属性叠加。 */
  const endSwap = useRef<(() => void) | null>(null);

  useEffect(() => {
    const media = window.matchMedia(MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setModeState(readStoredMode());
    setPrefersDark(media.matches);
    // 以 bootstrap 写在 html 上的值为起点，首帧就不算「切换」，不播过场。
    appliedTheme.current = readAppliedTheme(document.documentElement) ?? appliedTheme.current;
    setReady(true);
    media.addEventListener?.("change", onChange);
    if (!media.addEventListener) media.addListener?.(onChange);
    return () => {
      media.removeEventListener?.("change", onChange);
      if (!media.removeEventListener) media.removeListener?.(onChange);
    };
  }, []);

  const resolvedTheme = resolveTheme(mode, prefersDark);

  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    const previous = appliedTheme.current;
    appliedTheme.current = resolvedTheme;

    // 首次落主题（bootstrap 没写、或解析结果与它不同）与幂等重放都不算切换：
    // 直接落，不过场——首屏进来就闪一层光晕是干扰。
    if (previous === null || previous === resolvedTheme) {
      applyTheme(root, resolvedTheme);
      return;
    }

    endSwap.current?.();
    endSwap.current = startThemeSwap({
      root,
      direction: resolvedTheme,
      apply: () => applyTheme(root, resolvedTheme),
    });
    // 这里不登记卸载清理：startThemeSwap 自己的定时器一定会摘掉过场属性，
    // 而 effect 清理会在 React 严格模式下把刚起的过场误杀（开发环境就看不到过场了）。
  }, [ready, resolvedTheme]);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    } catch {
      // 隐私模式或受限存储不应阻止本次主题切换。
    }
  }, []);

  const value = useMemo(() => ({ mode, resolvedTheme, setMode }), [mode, resolvedTheme, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
