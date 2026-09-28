import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const layout = readFileSync(join(root, "app/(dashboard)/layout.tsx"), "utf8");
const meta = readFileSync(join(root, "../api/routers/meta.py"), "utf8");
const rbac = readFileSync(join(root, "../api/core/rbac.py"), "utf8");
const page = readFileSync(join(root, "app/(dashboard)/opportunities/page.tsx"), "utf8");
const api = readFileSync(join(root, "lib/api.ts"), "utf8");

test("商机管理位于 sidebar 第二个入口", () => {
  assert.match(layout, /"\/opportunities":\s*\(/);
  assert.match(layout, /"\/opportunities":\s*"商机管理"/);
  assert.match(layout, /const BASE_HREFS = \["\/dashboard", "\/opportunities", "\/projects"/);
  // Stage 5：菜单顺序由后端模块目录（MODULE_CATALOG）决定，商机紧随模块目录首项
  assert.match(
    rbac,
    /\(MODULE_OPPORTUNITIES, "商机管理", "\/opportunities"\),\s*\(MODULE_PROJECTS/s,
  );
  assert.match(meta, /for key, label, href in MODULE_CATALOG/);
});

test("商机列表复用台账式分页数据接口", () => {
  assert.match(page, /商机管理/);
  assert.match(page, /opportunitiesApi\.list/);
  assert.match(api, /export const opportunitiesApi = \{/);
  assert.match(api, /\/opportunities/);
});
