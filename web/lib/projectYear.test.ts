import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_YEAR_OPTION,
  buildYearOptions,
  extractProjectYear,
  parseYearParam,
  yearToCodeFilter,
} from "./projectYear";

describe("编号派生年份", () => {
  it("标准编号取出年份", () => {
    assert.equal(extractProjectYear("PJ-2026-0001"), "2026");
    assert.equal(extractProjectYear("PJ-2023-9123"), "2023");
  });

  it("非标/空编号返回空串（按无年份处理，不抛错）", () => {
    assert.equal(extractProjectYear(""), "");
    assert.equal(extractProjectYear(null), "");
    assert.equal(extractProjectYear(undefined), "");
    assert.equal(extractProjectYear("手工编号-001"), "");
    assert.equal(extractProjectYear("PJ-26-0001"), "");
    assert.equal(extractProjectYear("PJ-2026"), "");
  });

  it("首尾空格容忍", () => {
    assert.equal(extractProjectYear("  PJ-2026-0001  "), "2026");
  });
});

describe("URL year 参数解析", () => {
  it("合法 4 位年份原样返回", () => {
    assert.equal(parseYearParam("2026"), "2026");
  });

  it("缺失与非法取值回落全部年份", () => {
    assert.equal(parseYearParam(""), "");
    assert.equal(parseYearParam(null), "");
    assert.equal(parseYearParam(undefined), "");
    assert.equal(parseYearParam("26"), "");
    assert.equal(parseYearParam("2026-01"), "");
    assert.equal(parseYearParam("abcd"), "");
    assert.equal(parseYearParam("  "), "");
  });
});

describe("年份转后端 code 过滤", () => {
  it("2026 → PJ-2026-（后端 LIKE 匹配编号年份）", () => {
    assert.equal(yearToCodeFilter("2026"), "PJ-2026-");
  });

  it("空/非法年份 → 空串（buildQuery 自动跳过，不过滤）", () => {
    assert.equal(yearToCodeFilter(""), "");
    assert.equal(yearToCodeFilter("xyz"), "");
    assert.equal(yearToCodeFilter(undefined), "");
  });
});

describe("年度下拉选项", () => {
  const fakeNow = new Date("2026-09-18T00:00:00Z").getTime();

  it("倒序且覆盖 当年+1 … 最早年份", () => {
    const opts = buildYearOptions(fakeNow);
    assert.equal(opts[0], "2027");
    assert.equal(opts[opts.length - 1], String(MIN_YEAR_OPTION));
    assert.ok(opts.includes("2026"));
    // 严格倒序
    const nums = opts.map(Number);
    assert.deepEqual([...nums].sort((a, b) => b - a), nums);
  });

  it("范围外的已选年份追加到末尾（刷新/分享链接选中态不丢）", () => {
    const opts = buildYearOptions(fakeNow, "2018");
    assert.ok(opts.includes("2018"));
    assert.equal(opts[opts.length - 1], "2018");
  });

  it("范围内已选年份不重复", () => {
    const opts = buildYearOptions(fakeNow, "2026");
    assert.equal(opts.filter((y) => y === "2026").length, 1);
  });

  it("非法已选年份不污染选项", () => {
    const opts = buildYearOptions(fakeNow, "xyz");
    assert.deepEqual(opts, buildYearOptions(fakeNow));
  });
});
