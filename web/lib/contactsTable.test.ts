import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("通讯录花名册列契约", () => {
  const page = () => source("app/(dashboard)/contacts/page.tsx");
  const css = () => source("app/globals.css");

  it("列集合：10 列且保留工号；「附件数」列已整列移除", () => {
    const src = page();
    const cols = Array.from(src.matchAll(/<col style=\{\{ width: \d+ \}\} \/>/g));
    assert.equal(cols.length, 10, "列数与 colgroup 必须一一对应");
    assert.match(src, /<th>工号<\/th>/);
    assert.doesNotMatch(src, /附件数/);
    assert.doesNotMatch(src, /attachment_count/);
  });

  it("工号列有最起码宽度（SHZK-002 完整可读）且不折行", () => {
    const src = page();
    const widths = Array.from(src.matchAll(/<col style=\{\{ width: (\d+) \}\} \/>/g)).map((m) =>
      Number(m[1]),
    );
    // 工号是第 3 列（索引 2）：14px×2 内边距 + 8 位等宽字符（约 62px）仍有余量
    assert.ok(widths[2] >= 110, `工号列宽 ${widths[2]} 不足以完整显示 SHZK-002`);
    assert.ok(
      widths.reduce((sum, w) => sum + w, 0) === 1210,
      "列宽合计必须与 .contacts-table 的 min-width 一致",
    );
    assert.match(src, /<td className="mono" title=\{row\.employee_no \|\| ""\}>/);
  });

  it("表格锁 min-width + 单元格 nowrap：窄屏横滑，不折行", () => {
    assert.match(page(), /<table className="grid contacts-table" aria-busy=\{loading\}>/);
    assert.match(page(), /<DesktopTable>[\s\S]*<table className="grid contacts-table"/);
    const style = css();
    assert.match(style, /\.contacts-table \{\n min-width: 1210px;\n table-layout: fixed;\n\}/);
    assert.match(
      style,
      /\.contacts-table th,\n\.contacts-table td \{\n overflow: hidden;\n white-space: nowrap;\n text-overflow: ellipsis;\n\}/,
    );
  });
});
