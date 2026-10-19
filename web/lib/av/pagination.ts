// 告警游标分页（纯函数，不依赖 fetch，方便单测）
//
// 契约（与 alarms-index.json 的 pagination 一致）：
//   cursor = "<shardIndex>:<offsetInShard>"
//   · 首页 cursor 传 null
//   · next_cursor = null 表示已是最后一页
//   · 分片顺序 = 新 → 旧；分片内也按 ts_offset_minutes 升序
import type { AlarmsIndex, AlarmShardFile } from "./types";

export interface Cursor {
  shard: number;
  offset: number;
}

export function parseCursor(cursor: string | null | undefined, index: AlarmsIndex): Cursor {
  if (cursor === null || cursor === undefined || cursor === "") return { shard: 0, offset: 0 };
  const m = /^(\d+):(\d+)$/.exec(cursor);
  if (!m) throw new Error(`游标格式不合法：${cursor}（应为 ${index.pagination.cursor_format}）`);
  const shard = Number(m[1]);
  const offset = Number(m[2]);
  if (shard < 0 || shard >= index.shards.length) throw new Error(`游标的分片号越界：${cursor}`);
  if (offset < 0 || offset > index.shards[shard].count) throw new Error(`游标的分片内偏移越界：${cursor}`);
  return { shard, offset };
}

export function formatCursor(cursor: Cursor): string {
  return `${cursor.shard}:${cursor.offset}`;
}

export function clampPageSize(size: number | undefined, index: AlarmsIndex): number {
  const fallback = index.pagination.page_size;
  if (!size || size < 1) return fallback;
  return Math.min(Math.floor(size), index.pagination.max_page_size);
}

/**
 * 从「当前分片 + 分片内偏移」开始切一页，返回本页告警与下一页游标。
 * shard 变化由调用方（load.ts）负责跨分片加载；这里只切单页。
 */
export function takeFromShard(
  shard: AlarmShardFile,
  cursor: Cursor,
  pageSize: number,
  index: AlarmsIndex,
): { alarms: AlarmShardFile["alarms"]; next_cursor: string | null; done: boolean } {
  const start = Math.min(cursor.offset, shard.alarms.length);
  const end = Math.min(start + pageSize, shard.alarms.length);
  const alarms = shard.alarms.slice(start, end);
  if (end < shard.alarms.length) {
    return { alarms, next_cursor: formatCursor({ shard: cursor.shard, offset: end }), done: false };
  }
  const nextShard = cursor.shard + 1;
  if (nextShard < index.shards.length) {
    return { alarms, next_cursor: formatCursor({ shard: nextShard, offset: 0 }), done: false };
  }
  return { alarms, next_cursor: null, done: true };
}

/** 判断某个偏移落在哪个分片（用于「跳到某天」这类按时间定位）
 *
 * 分片边界是「相邻两个分片各自的首尾」：实测 9 个分片之间有 7 处空隙
 * （首尾相距合计 121 分钟，其间真正没有任何告警的分钟数为 114），
 * 另外 1 处是相接（`202732` 既是 shard-006 的 to，也是 shard-007 的 from，
 * 分别属于两条不同告警，id 不重复，无害）。
 * 落在空隙时取**距离最近**的分片，而不是无条件 fallback 到最后一个分片。
 */
export function findShardForOffset(index: AlarmsIndex, offsetMinutes: number): number {
  const shards = index.shards;
  if (shards.length === 0) return 0;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i];
    if (offsetMinutes >= s.from_offset_minutes && offsetMinutes <= s.to_offset_minutes) return i;
    const distance =
      offsetMinutes < s.from_offset_minutes
        ? s.from_offset_minutes - offsetMinutes
        : offsetMinutes - s.to_offset_minutes;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
