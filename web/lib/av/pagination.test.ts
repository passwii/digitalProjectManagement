import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampPageSize, findShardForOffset, formatCursor, parseCursor, takeFromShard } from "./pagination";
import type { Alarm, AlarmsIndex, AlarmShardFile } from "./types";

function makeIndex(shards: { count: number; from: number; to: number }[]): AlarmsIndex {
  return {
    _meta: { total: shards.reduce((s, x) => s + x.count, 0), shard_count: shards.length, sorted_by: "", note: "" },
    pagination: {
      page_size: 50,
      max_page_size: 200,
      cursor_format: "<shardIndex>:<offsetInShard>",
      cursor_example: "0:50",
      next_cursor_field: "next_cursor",
      empty_cursor: null,
      total: shards.reduce((s, x) => s + x.count, 0),
    },
    shards: shards.map((s, i) => ({
      index: i,
      file: `alarms/shard-${String(i).padStart(3, "0")}.json`,
      count: s.count,
      bytes: 0,
      from_offset_minutes: s.from,
      to_offset_minutes: s.to,
      tier_counts: { script: 0, related: 0, noise: s.count },
    })),
  };
}

function makeShard(index: number, count: number): AlarmShardFile {
  const alarms = Array.from({ length: count }, (_, i) => ({ id: `AL-${index}-${i}`, ts_offset_minutes: i })) as unknown as Alarm[];
  return { shard: index, count, from_offset_minutes: 0, to_offset_minutes: count, alarms };
}

describe("告警游标分页", () => {
  const index = makeIndex([
    { count: 120, from: 0, to: 120 },
    { count: 20, from: 121, to: 141 },
  ]);

  it("null / 空游标从第一片第一条开始", () => {
    assert.deepEqual(parseCursor(null, index), { shard: 0, offset: 0 });
    assert.deepEqual(parseCursor("", index), { shard: 0, offset: 0 });
  });

  it("解析并回写游标", () => {
    assert.deepEqual(parseCursor("1:7", index), { shard: 1, offset: 7 });
    assert.equal(formatCursor({ shard: 1, offset: 7 }), "1:7");
  });

  it("拒绝非法游标（格式 / 序号 / 页内偏移）", () => {
    assert.throws(() => parseCursor("abc", index), /游标格式不合法/);
    assert.throws(() => parseCursor("0", index), /游标格式不合法/);
    assert.throws(() => parseCursor("9:0", index), /位置序号越界/);
    assert.throws(() => parseCursor("0:999", index), /页内偏移越界/);
  });

  it("页大小被夹在 [1, max_page_size] 内", () => {
    assert.equal(clampPageSize(undefined, index), 50);
    assert.equal(clampPageSize(0, index), 50);
    assert.equal(clampPageSize(10, index), 10);
    assert.equal(clampPageSize(9999, index), 200);
  });

  it("片内还有剩余时游标停在同一片", () => {
    const shard = makeShard(0, 120);
    const page = takeFromShard(shard, { shard: 0, offset: 0 }, 50, index);
    assert.equal(page.alarms.length, 50);
    assert.equal(page.next_cursor, "0:50");
    assert.equal(page.done, false);
  });

  it("读完一片自动续到下一片", () => {
    const shard = makeShard(0, 120);
    const page = takeFromShard(shard, { shard: 0, offset: 100 }, 50, index);
    assert.equal(page.alarms.length, 20);
    assert.equal(page.next_cursor, "1:0");
    assert.equal(page.done, false);
  });

  it("最后一片读完给出 next_cursor = null", () => {
    const shard = makeShard(1, 20);
    const page = takeFromShard(shard, { shard: 1, offset: 0 }, 50, index);
    assert.equal(page.alarms.length, 20);
    assert.equal(page.next_cursor, null);
    assert.equal(page.done, true);
  });

  it("游标偏移等于片长时返回空页而不是抛错", () => {
    const shard = makeShard(0, 120);
    const page = takeFromShard(shard, { shard: 0, offset: 120 }, 50, index);
    assert.equal(page.alarms.length, 0);
    assert.equal(page.next_cursor, "1:0");
  });

  it("按偏移定位分片", () => {
    assert.equal(findShardForOffset(index, 0), 0);
    assert.equal(findShardForOffset(index, 120), 0);
    assert.equal(findShardForOffset(index, 130), 1);
    assert.equal(findShardForOffset(index, 9999), 1);
  });

  it("落在分片空隙时取最近的分片（不是无条件取最后一个）", () => {
    const gapped = makeIndex([
      { count: 10, from: 0, to: 100 },
      { count: 10, from: 140, to: 200 },
      { count: 10, from: 260, to: 300 },
    ]);
    // 空隙 101..139：靠前一片
    assert.equal(findShardForOffset(gapped, 105), 0);
    // 同样落在第一段空隙，但更靠近后一片
    assert.equal(findShardForOffset(gapped, 138), 1);
    assert.equal(findShardForOffset(gapped, 120), 0);
    // 空隙 201..259
    assert.equal(findShardForOffset(gapped, 205), 1);
    assert.equal(findShardForOffset(gapped, 255), 2);
    // 两端
    assert.equal(findShardForOffset(gapped, -50), 0);
    assert.equal(findShardForOffset(gapped, 99999), 2);
  });
});
