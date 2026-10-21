import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENT_PAGE_SIZE, paginate, pagerItems } from "./eventPaging";

/**
 * 事件列表分页（BLF-1427 验收：首屏 ≤ 20 行、翻页能到末页）。
 *
 * 这里的用例不读数据文件，只钉住三条不变量：
 *   1. page 永远被 clamp 在 [1, pageCount]；
 *   2. 每页条数 ≤ size（首屏 20 行是硬指标）；
 *   3. 末页取到的条数是余数，不是整页。
 */
describe("事件列表分页", () => {
  const rows = Array.from({ length: 327 }, (_, i) => i + 1);

  it("首屏只切 20 条", () => {
    const page = paginate(rows, 1);
    assert.equal(EVENT_PAGE_SIZE, 20);
    assert.equal(page.items.length, 20);
    assert.equal(page.items[0], 1);
    assert.equal(page.items[19], 20);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 17); // ceil(327 / 20)
    assert.deepEqual(page.range, { from: 1, to: 20 });
  });

  it("末页是余数，且 pageCount 与行数对得上", () => {
    const page = paginate(rows, 17);
    assert.equal(page.items.length, 7);
    assert.equal(page.items[0], 321);
    assert.equal(page.items.at(-1), 327);
    assert.deepEqual(page.range, { from: 321, to: 327 });
  });

  it("越界页码被夹回合法区间（筛选把行数筛少不会停在空页）", () => {
    assert.equal(paginate(rows, 99).page, 17);
    assert.equal(paginate(rows, 99).items.length, 7);
    assert.equal(paginate(rows, 0).page, 1);
    assert.equal(paginate(rows, -3).page, 1);
    // 筛完只剩 5 条时，第 9 页回到第 1 页且不是空表
    const shrunk = paginate(rows.slice(0, 5), 9);
    assert.equal(shrunk.page, 1);
    assert.equal(shrunk.pageCount, 1);
    assert.equal(shrunk.items.length, 5);
  });

  it("空结果也渲染「第 1 / 1 页」而不是 0 页", () => {
    const empty = paginate([], 3);
    assert.equal(empty.page, 1);
    assert.equal(empty.pageCount, 1);
    assert.equal(empty.total, 0);
    assert.equal(empty.range, null);
    assert.deepEqual(empty.items, []);
  });

  it("自定义每页条数与非法值兜底", () => {
    assert.equal(paginate(rows, 1, 50).items.length, 50);
    assert.equal(paginate(rows, 1, 0).items.length, EVENT_PAGE_SIZE);
    assert.equal(paginate(rows, 1, -8).items.length, EVENT_PAGE_SIZE);
  });

  it("页码条：首页 / 末页 / 当前页前后一页，中间省略", () => {
    assert.deepEqual(pagerItems(1, 17), [1, 2, "gap", 17]);
    assert.deepEqual(pagerItems(9, 17), [1, "gap", 8, 9, 10, "gap", 17]);
    assert.deepEqual(pagerItems(17, 17), [1, "gap", 16, 17]);
    // 页数很少时不出现省略号
    assert.deepEqual(pagerItems(2, 3), [1, 2, 3]);
    assert.deepEqual(pagerItems(1, 1), [1]);
  });
});
