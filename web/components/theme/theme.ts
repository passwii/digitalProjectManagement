export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "shuzhi-theme-mode";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * 读取持久化的显示模式。
 *
 * 无存储值 / 非法值一律回落到「跟随系统」：新用户与从未手动选过主题的人
 * 应当与设备偏好一致，而不是被产品硬塞一个深色。已有用户保存的 light / dark /
 * system 原样保留，不会被这次默认值调整覆盖。
 */
export function parseStoredTheme(value: string | null): ThemeMode {
  return isThemeMode(value) ? value : "system";
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
