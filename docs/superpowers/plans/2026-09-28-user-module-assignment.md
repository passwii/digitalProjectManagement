# 用户功能模块手动分配（Stage 5，基于 main）

日期：2026-09-28

## 背景与目标

原行为：`GET /meta/me/menus` 硬编码返回基础导航；只有 `admin` 角色额外拿到
`contacts / partners / approvals / admin` 四个管理类入口。页面可见性完全由 admin 角色推导。

目标（用户确认的三条决策）：

1. 取消「管理员可见性」页面设定，**导航模块全部可手动分配给用户**；
2. 用户被分配到某模块后，**后端接口同步放行**（不再只认 admin 角色）；
3. **admin 角色默认拥有全部模块**，其他用户完全按分配。

## 模块目录（对齐 main 当前导航）

| key | 名称 | 路由 |
| --- | --- | --- |
| opportunities | 商机管理 | /opportunities |
| projects | 项目台账 | /projects |
| assets | 资产管理 | /assets |
| reports | 支出报表 | /reports |
| contacts | 通讯录 | /contacts |
| partners | 我的友商 | /partners |
| approvals | 审批中心 | /approvals |
| admin | 系统管理 | /admin |

- 生效规则（`core.rbac.effective_modules`）：admin → 全部；已显式分配 → 按 `user_modules`；
  存量/未分配 → 默认四个基础模块（`opportunities/projects/assets/reports`）。
- **财务管理 `/finance` 不纳入手动模块**：沿用账套成员授权（`can_finance` / `require_finance`），
  避免把账套数据权限降级为普通页面开关。
- `/progress`、`/costs` 是项目详情/报表页的子页面，无独立导航模块，其子资源接口（tasks /
  milestones / budgets / expenses）保持开放。

## 后端改动

- `api/models/__init__.py`：新增 `UserModule(user_id, module)`；`users.modules_assigned`。
- `api/core/rbac.py`：`MODULE_CATALOG / ALL_MODULES / DEFAULT_MODULES`、
  `effective_modules / has_module / require_module`；`can_approve` 改为「拥有 approvals 模块」。
- `api/routers/meta.py`：`GET /meta/me/menus` 按生效模块过滤模块目录；finance 仍由账套决定。
- `api/routers/admin.py`：`_u` 回带 `modules`；`GET /admin/modules` 模块目录；
  `POST/PATCH /users` 支持 `modules` 写入（整表覆盖 + 标记已分配）。
- `api/main.py`：路由级模块门禁（`--module_guard`）：
  - admin/contacts/partners/approvals/opportunities → 各自模块；
  - equipment-assets → assets；reports → {reports, projects, opportunities, assets}；
  - projects → {opportunities, projects, assets, reports, admin}（跨模块选择器 + 回收站）；
  - tasks/milestones/budgets/expenses、finance/finance_accounting、auth/meta/dashboard/notifications 不设模块门禁。
- 端点内 `require_admin` → `require_module`：审批决策→approvals；回收站→admin 模块；
  设备资产受控写操作保留 admin 角色门禁（业务规则）。
- 迁移 `0029_user_modules`（幂等建表/加列，单 head）。

## 前端改动

- `lib/api.ts`：`AdminUser.modules`、`ModuleItem`、`adminApi.modules()`。
- `lib/useMeta.ts`：`useMenus` 暴露 `hasModule(key)`。
- `app/(dashboard)/layout.tsx`：删除「管理与审批」管理员可见分组与 `ADMIN_HREFS` 硬编码；
  空菜单是合法「未分配」，仅权限同步失败才退回基础入口；保留本地 Spark 入口。
- `app/(dashboard)/admin/page.tsx`：以 `hasModule("admin")` 取代 `isAdmin` 门禁；
  加载模块目录、用户列表（卡片 + 桌面表）新增「模块」列。
- `app/(dashboard)/admin/UserDialog.tsx`：新增「功能模块（可多选）」区块，新增/编辑均支持。
- `approvals/dashboard/Bell/MineSheet`：以 `canApprove` 取代 `isAdmin` 判定审批入口；
  「我的」抽屉身份标签用真实 admin 角色。
- `contacts/partners`：以 `hasModule` 取代 `isAdmin` 页面门禁。

## 验证

- 前端：`npm run test:unit`（191 passed）、`npm run test:motion` / `vitest run`（213 passed）。
- 后端：`TEST_DATABASE_URL=... pytest tests` → 262 passed，1 个 `test_partner_attachment_flow`
  预存在失败（已 stash 复现，与本次改动无关）；新增 `tests/test_user_modules.py` 5 项全过。
- 迁移：`alembic heads` 单 head `0029_user_modules`；`upgrade head → downgrade -1 → upgrade head` 在真实 PG 通过。
