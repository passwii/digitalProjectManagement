import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 功能模块手动分配（Stage 5）的前端接线契约。
 *
 * 这类断言只钉「接线是否还在」：模块目录来自后端、用户弹窗可分配、页面门禁走
 * hasModule/canApprove 而非 isAdmin。行为正确性由后端 tests/test_user_modules.py
 * 与 vitest 渲染用例覆盖。
 */
const root = process.cwd();
const dialog = readFileSync(join(root, "app/(dashboard)/admin/UserDialog.tsx"), "utf8");
const adminPage = readFileSync(join(root, "app/(dashboard)/admin/page.tsx"), "utf8");
const useMeta = readFileSync(join(root, "lib/useMeta.ts"), "utf8");
const api = readFileSync(join(root, "lib/api.ts"), "utf8");
const layout = readFileSync(join(root, "app/(dashboard)/layout.tsx"), "utf8");

test("用户弹窗具备模块分配并随创建/编辑一起提交", () => {
  assert.match(dialog, /功能模块（可多选/);
  assert.match(dialog, /pickedModules/);
  assert.match(dialog, /modules: pickedModules/);
  // 新增与编辑两条路径都要带上模块
  assert.match(dialog, /adminApi\.updateUser\(user!\.id, payload\)/);
  assert.match(dialog, /adminApi\.createUser\(\{/);
});

test("系统管理面用 hasModule 门禁并加载模块目录", () => {
  assert.match(adminPage, /hasModule\("admin"\)/);
  assert.match(adminPage, /adminApi\.modules\(signal\)/);
  assert.match(adminPage, /modules=\{moduleItems\}/);
  assert.match(api, /modules: \(signal\?: AbortSignal\) => apiGet<ModuleItem\[\]>\("\/admin\/modules"/);
});

test("useMenus 暴露 hasModule，导航不再按管理员分组", () => {
  assert.match(useMeta, /hasModule: \(key: string\) =>/);
  assert.doesNotMatch(layout, /ADMIN_HREFS/);
  assert.doesNotMatch(layout, /仅管理员可见/);
});
