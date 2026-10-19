import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANCHOR,
  ANCHOR_MS,
  clockHourOf,
  clockMinutesOf,
  durationText,
  isNaturalDay,
  sortNewestFirst,
  sortTimeline,
  toAbsolute,
  toClock,
  toDateString,
  toRelative,
  withinHours,
} from "./time";

// 锚点固定为 2026-10-19 12:00（UTC+8）。这些用例同时锁住「时区无关」这条约定：
// 无论 CI 机器是 UTC 还是 Asia/Shanghai，结果都必须一样。
describe("时间换算（UTC+8，与机器时区无关）", () => {
  it("锚点即 12:00，偏移 0", () => {
    assert.equal(ANCHOR, "2026-10-19T12:00:00+08:00");
    assert.equal(toClock(0), "12:00");
    assert.equal(clockMinutesOf(0), 12 * 60);
    assert.equal(clockHourOf(0), 12);
    assert.equal(toAbsolute(0), "2026-10-19 12:00");
    assert.equal(toDateString(0), "2026-10-19");
  });

  it("02:10 是 590 分钟前（剧本 E 的夜间分贝）", () => {
    assert.equal(toClock(590), "02:10");
    assert.equal(clockHourOf(590), 2);
  });

  it("21:00 的偏移在每一天都落在 21 点（剧本 B 连续 7 天 21:00）", () => {
    for (let day = 1; day <= 7; day += 1) {
      // 21:00 在锚点（正午）之后，所以属于「前一个自然日」
      assert.equal(toClock(day * 1440 + 900), "21:00");
    }
  });

  it("处理跨零点而不溢出（偏移越大越早）", () => {
    // 锚点 10-19 12:00 → 720 分钟前 = 10-19 00:00；721 分钟前 = 10-18 23:59
    assert.equal(toClock(12 * 60), "00:00");
    assert.equal(toDateString(12 * 60), "2026-10-19");
    assert.equal(toClock(12 * 60 + 1), "23:59");
    assert.equal(toDateString(12 * 60 + 1), "2026-10-18");
  });

  it("自然日窗口 = [0, 720]（锚点在正午）", () => {
    assert.equal(isNaturalDay(0), true);
    assert.equal(isNaturalDay(720), true);
    assert.equal(isNaturalDay(721), false);
    assert.equal(isNaturalDay(-1), false);
  });

  it("相对时间与时长文案", () => {
    assert.equal(toRelative(0), "刚刚");
    assert.equal(toRelative(3), "3 分钟前");
    assert.equal(toRelative(90), "1 小时前");
    assert.equal(toRelative(3 * 1440), "3 天前");
    assert.equal(durationText(100, 98), "2 分钟");
    assert.equal(durationText(0, 0.5), "30 秒");
  });

  it("排序辅助：告警新→旧，时间线旧→新", () => {
    const alarms = [{ ts_offset_minutes: 30 }, { ts_offset_minutes: 2 }, { ts_offset_minutes: 9 }];
    assert.deepEqual(sortNewestFirst(alarms).map((a) => a.ts_offset_minutes), [2, 9, 30]);
    const timeline = [{ at_offset_minutes: 1 }, { at_offset_minutes: 9 }, { at_offset_minutes: 4 }];
    assert.deepEqual(sortTimeline(timeline).map((n) => n.at_offset_minutes), [9, 4, 1]);
  });

  it("withinHours 是左闭右开（与 alarm_last_24h 口径一致）", () => {
    assert.equal(withinHours(0, 24), true);
    assert.equal(withinHours(1439, 24), true);
    assert.equal(withinHours(1440, 24), false);
  });

  it("ANCHOR_MS 与 toAbsolute 使用同一基准", () => {
    assert.equal(new Date(ANCHOR_MS).toISOString(), "2026-10-19T04:00:00.000Z");
  });
});
