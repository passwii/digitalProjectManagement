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

/** 判断某个偏移落在哪个分片（用于「跳到某天」这类按时间定位） */
export function findShardForOffset(index: AlarmsIndex, offsetMinutes: number): number {
  for (let i = 0; i < index.shards.length; i++) {
    const s = index.shards[i];
    if (offsetMinutes >= s.from_offset_minutes && offsetMinutes <= s.to_offset_minutes) return i;
  }
  return offsetMinutes < index.shards[0].from_offset_minutes ? 0 : index.shards.length - 1;
}
