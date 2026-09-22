"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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

const ThemeContext = createContext<ThemeContextValue | null>(null);

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readStoredMode(): ThemeMode {
  try {
    return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
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

  useEffect(() => {
    const media = window.matchMedia(MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setModeState(readStoredMode());
    setPrefersDark(media.matches);
    media.addEventListener?.("change", onChange);
    if (!media.addEventListener) media.addListener?.(onChange);
    return () => {
      media.removeEventListener?.("change", onChange);
      if (!media.removeEventListener) media.removeListener?.(onChange);
    };
  }, []);

  const resolvedTheme = resolveTheme(mode, prefersDark);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

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
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return context;
}
