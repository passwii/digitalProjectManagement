import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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

  it("从任意合同编号前缀提取年份", () => {
    assert.equal(extractProjectYear("SHZK-2026-009"), "2026");
    assert.equal(extractProjectYear("ABC-2024-1"), "2024");
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
  it("仅接受固定的五个年份", () => {
    for (const year of ["2027", "2026", "2025", "2024", "2023"]) {
      assert.equal(parseYearParam(year), year);
    }
  });

  it("缺失、范围外与非法取值回落全部年份", () => {
    assert.equal(parseYearParam(""), "");
    assert.equal(parseYearParam(null), "");
    assert.equal(parseYearParam(undefined), "");
    assert.equal(parseYearParam("26"), "");
    assert.equal(parseYearParam("2026-01"), "");
    assert.equal(parseYearParam("abcd"), "");
    assert.equal(parseYearParam("  "), "");
    assert.equal(parseYearParam("2028"), "");
    assert.equal(parseYearParam("2022"), "");
  });
});

describe("年份转后端 code 过滤", () => {
  it("2026 → -2026-（匹配任意合同编号前缀的年份段）", () => {
    assert.equal(yearToCodeFilter("2026"), "-2026-");
  });

  it("空/非法年份 → 空串（buildQuery 自动跳过，不过滤）", () => {
    assert.equal(yearToCodeFilter(""), "");
    assert.equal(yearToCodeFilter("xyz"), "");
    assert.equal(yearToCodeFilter(undefined), "");
  });
});

describe("年度下拉选项", () => {
  const fakeNow = new Date("2026-09-18T00:00:00Z").getTime();

  it("固定返回 2027 到 2023 的倒序选项", () => {
    const opts = buildYearOptions(fakeNow);
    assert.deepEqual(opts, ["2027", "2026", "2025", "2024", "2023"]);
  });

  it("范围外的已选年份不追加", () => {
    const opts = buildYearOptions(fakeNow, "2018");
    assert.deepEqual(opts, ["2027", "2026", "2025", "2024", "2023"]);
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
