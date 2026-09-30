import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/** 前端模块分配接线契约：权限与模块目录来自后端，系统管理只认超级管理员身份。 */
const root = process.cwd();
const dialog = readFileSync(join(root, "app/(dashboard)/admin/UserDialog.tsx"), "utf8");
const adminPage = readFileSync(join(root, "app/(dashboard)/admin/page.tsx"), "utf8");
const useMeta = readFileSync(join(root, "lib/useMeta.ts"), "utf8");
const api = readFileSync(join(root, "lib/api.ts"), "utf8");
const layout = readFileSync(join(root, "app/(dashboard)/layout.tsx"), "utf8");
const menuResp = api.slice(api.indexOf("export interface MenuResp"), api.indexOf("export interface FinanceBook"));
const adminUser = api.slice(api.indexOf("export interface AdminUser"), api.indexOf("/** 功能模块目录"));

function contains(source: string, pattern: RegExp, message: string) {
  assert.ok(pattern.test(source), message);
}
function excludes(source: string, pattern: RegExp, message: string) {
  assert.ok(!pattern.test(source), message);
}

test("用户弹窗具备模块分配并随创建/编辑一起提交", () => {
  contains(dialog, /功能模块（可多选/, "弹窗应展示功能模块分配");
  contains(dialog, /pickedModules/, "弹窗应维护所选模块");
  contains(dialog, /modules: pickedModules/, "新增和编辑载荷应提交模块数组");
  contains(dialog, /adminApi\.updateUser\(user!\.id, payload\)/, "编辑应提交用户载荷");
  contains(dialog, /adminApi\.createUser\(\{/, "新增应提交用户载荷");
});

test("模块目录驱动弹窗并包含财务说明，不默认分配业务模块或选择角色", () => {
  contains(api, /modules: \(signal\?: AbortSignal\) => apiGet<ModuleItem\[]>\("\/admin\/modules"/, "目录应来自模块 API");
  contains(dialog, /modules\.map\(\(mod\)/, "弹窗应展示 API 返回的目录");
  contains(dialog, /财务模块包含全部活动账套/, "应解释财务模块的账套访问范围");
  excludes(dialog, /modules\.filter\(|key\s*===\s*["']admin["']/, "模块目录应原样展示，系统管理不作为可分配模块");
  contains(dialog, /useState<string\[]>\(\[\]\)/, "初始所选模块应为空");
  contains(dialog, /user\s*\?\s*user\.modules\s*:\s*\[\]/, "新增用户应显式使用空模块数组");
  excludes(dialog, /DEFAULT_MODULE_KEYS|roles\s*:|角色/, "弹窗不得含默认业务模块或角色选择");
});

test("用户弹窗不编辑角色，也不在用户载荷中提交 roles", () => {
  const submit = dialog.slice(dialog.indexOf("async function submit()"), dialog.indexOf("\n  const modulesDirty"));
  excludes(submit, /\broles\s*:/, "创建和编辑载荷均不得包含 roles");
  excludes(dialog, /\broles\s*:|setPicked\(|picked\.length|请至少选择一个角色/, "弹窗不得接受或校验角色");
});

test("系统管理面仅由超级管理员身份门禁且不再加载角色页", () => {
  contains(adminPage, /isSuperAdmin/, "管理页门禁应使用超级管理员身份");
  excludes(adminPage, /hasModule\("admin"\)|adminApi\.roles\(|\broleItems\b|\broles=\{/, "管理页不得把 admin 当模块或加载角色数据");
  contains(adminUser, /is_super_admin: boolean/, "用户 API 类型应包含超级管理员标志");
  contains(adminPage, /超级管理员/, "用户身份应显示超级管理员徽标");
  contains(adminPage, /普通用户/, "其他用户应显示普通用户身份");
  contains(adminPage, /title="仅限超级管理员"/, "无权限说明应明确系统管理的身份门槛");
  contains(adminPage, /!u\.is_super_admin/, "超级管理员不得显示停用操作");
  contains(adminPage, /const TABS = \["用户", "字典", "参数", "日志", "回收站"\]/, "页签应固定为用户、字典、参数、日志、回收站");
});

test("系统管理仍然从后端模块目录加载功能模块", () => {
  contains(adminPage, /adminApi\.modules\(signal\)/, "管理页应读取后端模块目录");
  contains(adminPage, /modules=\{moduleItems\}/, "模块目录应传给用户弹窗");
});

test("超级管理员菜单身份是唯一来源，旧 isAdmin 只是兼容别名", () => {
  contains(menuResp, /is_super_admin: boolean/, "菜单响应应要求 is_super_admin");
  contains(menuResp, /is_admin: boolean/, "菜单响应继续保留 is_admin 兼容字段");
  contains(useMeta, /isSuperAdmin: boolean/, "菜单状态应暴露 isSuperAdmin");
  contains(useMeta, /isSuperAdmin:\s*Boolean\(data\?\.is_super_admin\)/, "isSuperAdmin 应源自 is_super_admin");
  contains(useMeta, /isAdmin:\s*Boolean\(data\?\.is_super_admin\)/, "isAdmin 兼容别名应源自 is_super_admin");
  contains(useMeta, /canFinance:\s*!!data\?\.can_finance/, "财务权限应源自菜单接口标志");
  excludes(useMeta, /isAdmin:\s*Boolean\(data\?\.is_admin\)/, "不得继续将旧 is_admin 作为权限来源");
});

test("useMenus 暴露 hasModule，导航不再按管理员分组", () => {
  contains(useMeta, /hasModule: \(key: string\) =>/, "菜单 hook 应暴露模块判断");
  excludes(layout, /ADMIN_HREFS/, "导航不得按管理员角色分组");
  excludes(layout, /仅管理员可见/, "导航文案不得依赖管理员角色");
});
