/**
 * 监控页的时间码格式化（BLF-1425）。
 *
 * 单独放在 lib 里而不是塞进 `AvLiveBadge.tsx`：视频画面的右下角时间码也要用它，
 * 而 `AvLiveBadge` 是 `"use client"` 组件（要跑定时器）—— 让服务端可渲染的
 * `AvVideoScene` 去 import 一个 client 模块的导出，会把整块拖进客户端边界。
 * 纯函数放这里，谁都能用，node:test / vitest 也能直接测。
 */
export function formatTimecode(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
