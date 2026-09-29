import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEGACY_PROJECT_TABS,
  PROJECT_TABS,
  parseProjectTab,
} from "./projectTabs";

describe("档案页 Tab 解析", () => {
  it("现行页签为文档、合同、进度、成本、应收、日志", () => {
    assert.deepEqual([...PROJECT_TABS], [
      "文档",
      "合同",
      "进度",
      "成本",
      "应收",
      "日志",
    ]);
  });

  it("现行 Tab 名原样返回", () => {
    for (const tab of PROJECT_TABS) {
      assert.equal(parseProjectTab(tab), tab);
    }
  });

  it("「支出」与「变更」改名为「成本」与「日志」后旧深链仍然可用", () => {
    assert.equal(parseProjectTab("支出"), "成本");
    assert.equal(parseProjectTab("变更"), "日志");
  });

  it("「白板」改名为「文档」后旧深链仍然可用", () => {
    // 通知与历史链接里都存在旧名，改名不能让它们落到空白页
    assert.equal(parseProjectTab("白板"), "文档");
    assert.equal(parseProjectTab("基本"), "文档");
    assert.equal(parseProjectTab("附件"), "文档");
    assert.equal(parseProjectTab("跟进"), "文档");
  });

  it("缺失或非法取值落到主 Tab「文档」", () => {
    assert.equal(parseProjectTab(null), "文档");
    assert.equal(parseProjectTab(undefined), "文档");
    assert.equal(parseProjectTab(""), "文档");
    assert.equal(parseProjectTab("不存在的页签"), "文档");
    // 大小写与空格不做宽松匹配：避免把拼错的值悄悄当成有效 Tab
    assert.equal(parseProjectTab(" 文档"), "文档");
    assert.equal(parseProjectTab("documents"), "文档");
  });

  it("原型链上的键不是一个 Tab（`?tab=constructor` 不能落空白页）", () => {
    // 回归：折叠表曾经用 `raw in LEGACY_PROJECT_TABS` 命中原型链，
    // 这三个键会读出 Object.prototype 的成员，返回值不是 ProjectTab：
    // 页面里 `tab === "文档" / "合同" / …` 全不匹配 → 页签容器在、内容区全空。
    // 它们都是 `URLSearchParams` 里普通字符串，任何访问者都能构造。
    for (const key of [
      "constructor",
      "toString",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
    ]) {
      assert.equal(parseProjectTab(key), "文档", `原型链键 ${key} 未回落到文档`);
    }
    // 契约强化：返回值一定是一个真正的现行 Tab，不会是函数 / 对象 / undefined
    for (const raw of [
      "constructor",
      "toString",
      "__proto__",
      "白板",
      "不存在的页签",
      null,
    ]) {
      const tab = parseProjectTab(raw);
      assert.ok(
        (PROJECT_TABS as readonly string[]).includes(tab),
        `${String(raw)} 解析出了非现行 Tab：${String(tab)}`,
      );
    }
  });

  it("折叠表只指向现行 Tab，不产生悬空目标", () => {
    for (const [legacy, target] of Object.entries(LEGACY_PROJECT_TABS)) {
      assert.ok(
        (PROJECT_TABS as readonly string[]).includes(target),
        `旧名 ${legacy} 指向了非现行 Tab：${target}`,
      );
    }
  });
});
