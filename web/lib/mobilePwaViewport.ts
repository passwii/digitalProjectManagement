"use client";

import { useEffect, useState } from "react";

/**
 * 手机 PWA 视口：竖屏 ≤767px，以及横屏短屏（手机横放时 CSS 宽度是长边
 * 844 / 852 / 932，单纯 max-width:767px 一条都不会命中）。
 *
 * 这与 DESIGN.md 里「横屏手机报的 CSS 视口宽度是长边」的口径一致：
 * 横屏只在 max-width:932px 且 max-height:500px 时归入手机壳；平板横屏
 * （如 1024×768）仍走桌面壳。
 */
export const MOBILE_PWA_VIEWPORT_QUERY =
  "(max-width: 767px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

/** 当前是否按手机 PWA 壳渲染。SSR 首帧为 false（与 useIsMobile 同口径）。 */
export function useMobilePwaViewport(): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia?.(MOBILE_PWA_VIEWPORT_QUERY);
    if (!media) return;
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  return matches;
}
