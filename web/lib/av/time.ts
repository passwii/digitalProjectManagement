// 时间换算：数据里只有「相对锚点的分钟偏移」，这里给统一的换算入口。
//
// 为什么不用 Date 的本地时区：
//   数据集的「钟点 / 自然日」是按 UTC+8 生成的。如果前端用 new Date(...).getHours()，
//   在别的时区打开就会整体错位（热力图最明显）。这里把展示时区固定为 UTC+8，
//   保证同一份数据在任何机器上画出同一张图。
//
// 约定：offset 越小 → 越新。绝对时间 = base - offset。
import type { TimelineNode } from "./types";

/** 数据集锚点（与 scripts/mock/generate.mjs 的 DEMO_ANCHOR 保持一致） */
export const ANCHOR = "2026-10-19T12:00:00+08:00";
export const ANCHOR_MS = new Date(ANCHOR).getTime();
/** 展示时区 UTC+8 */
export const TZ_OFFSET_MINUTES = 8 * 60;
const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/**
 * 换算基准。
 * - 默认用数据集锚点（截图可复现）
 * - 传 `live: true` 用当前时间（演示当天最自然，但截图不固定）
 */
export function resolveBase(live = false): number {
  return live ? Date.now() : ANCHOR_MS;
}

/** 偏移 → 展示时区（UTC+8）下的绝对时间 */
export function toDate(offsetMinutes: number, base = ANCHOR_MS): Date {
  return new Date(base - offsetMinutes * MINUTE);
}

/** 偏移 → 展示时区下的钟点分钟数（0..1439） */
export function clockMinutesOf(offsetMinutes: number): number {
  const ms = ANCHOR_MS - offsetMinutes * MINUTE + TZ_OFFSET_MINUTES * MINUTE;
  const dayMs = ((ms % (DAY_MINUTES * MINUTE)) + DAY_MINUTES * MINUTE) % (DAY_MINUTES * MINUTE);
  return Math.floor(dayMs / MINUTE);
}

/** 偏移 → 时钟小时 0..23（UTC+8） */
export function clockHourOf(offsetMinutes: number): number {
  return Math.floor(clockMinutesOf(offsetMinutes) / 60);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 偏移 → 「2026-10-19」（UTC+8） */
export function toDateString(offsetMinutes: number, base = ANCHOR_MS): string {
  const d = new Date(base - offsetMinutes * MINUTE + TZ_OFFSET_MINUTES * MINUTE);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 偏移 → 「2026-10-19 10:23」 / 「2026-10-19 10:23:14」 */
export function toAbsolute(offsetMinutes: number, base = ANCHOR_MS, withSeconds = false): string {
  const d = new Date(base - offsetMinutes * MINUTE + TZ_OFFSET_MINUTES * MINUTE);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSeconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${time}`;
}

/** 偏移 → 「10:23」（时间线节点的紧凑显示，UTC+8） */
export function toClock(offsetMinutes: number): string {
  const m = clockMinutesOf(offsetMinutes);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 偏移 → 「3 分钟前」这类相对时间（实时列表用） */
export function toRelative(offsetMinutes: number): string {
  const m = Math.max(0, Math.round(offsetMinutes));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/** 两个偏移之间的时长 → 「4 分 12 秒」 */
export function durationText(fromOffset: number, toOffset: number): string {
  const sec = Math.max(0, Math.abs(fromOffset - toOffset) * 60);
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** 排序辅助：越新越前（偏移升序） */
export function sortNewestFirst<T extends { ts_offset_minutes: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.ts_offset_minutes - b.ts_offset_minutes);
}

/** 时间线按「旧 → 新」排（偏移降序） */
export function sortTimeline<T extends Pick<TimelineNode, "at_offset_minutes">>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => b.at_offset_minutes - a.at_offset_minutes);
}

/** 判断某条告警是否落在「最近 N 小时」 */
export function withinHours(offsetMinutes: number, hours: number): boolean {
  return offsetMinutes >= 0 && offsetMinutes < hours * 60;
}

/**
 * 判断是否落在「今天自然日」（UTC+8 的 00:00 起）。
 * 锚点是正午 12:00，所以今天的自然日窗口就是 [0, 720] 分钟。
 */
export function isNaturalDay(offsetMinutes: number): boolean {
  return offsetMinutes >= 0 && offsetMinutes <= clockMinutesOf(0);
}
