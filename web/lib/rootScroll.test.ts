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

  it("为根滚动条常驻槽位，避免切换分区时内容左右横移", () => {
    const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

    // 选择器恰好是 html 的规则块（html, 是联合选择器，不算）
    const htmlBlocks = css.match(/(^|[\n{}])\s*html\s*\{[^}]*\}/g) ?? [];
    const gutter = htmlBlocks.find((block) => /scrollbar-gutter\s*:\s*stable/.test(block));

    assert.ok(
      gutter,
      "html 必须声明 scrollbar-gutter: stable，否则 Tab 切换导致根滚动条出现/消失时，内容宽度会跳一个滚动条宽度",
    );
  });
});
