import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("全局页面滚动契约", () => {
  it("不把 html/body 的纵向根滚动锁成 auto", () => {
    const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
    const rootBlocks = css.match(/html,\s*body\s*\{[^}]*\}/g) ?? [];

    assert.ok(rootBlocks.length > 0, "必须保留 html/body 的全局尺寸与 overscroll 规则");
    assert.ok(rootBlocks.every((block) => !/overflow-y\s*:\s*auto/.test(block)));
  });
});
