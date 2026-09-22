import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("生产端中文界面文案", () => {
  it("登录页不再暴露英文宣传文案", () => {
    const login = source("app/login/page.tsx");
    assert.doesNotMatch(login, /Digital Project Operations/);
    assert.doesNotMatch(login, /OA \/ PROJECT DELIVERY/);
    assert.match(login, /数字化项目运营/);
    assert.match(login, /项目协同 · 交付管理/);
  });

  it("项目状态码在管理页以中文状态展示", () => {
    const labels = source("lib/labels.ts");
    assert.match(labels, /doing: "进行中"/);
    assert.match(labels, /archived: "已归档"/);
  });

  it("审计日志使用集中中文格式化，不直接展示原始编码", () => {
    const admin = source("app/(dashboard)/admin/page.tsx");
    assert.match(admin, /auditActionLabel/);
    assert.match(admin, /auditResourceDisplay/);
    assert.match(admin, /auditDetailLabel/);
    assert.doesNotMatch(admin, /<td className="mono tiny">\{l\.action\}<\/td>/);
    assert.doesNotMatch(admin, /title=\{l\.detail\}/);
  });
});
