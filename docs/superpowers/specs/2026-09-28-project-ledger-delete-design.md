# 项目台账删除功能设计

> 日期：2026-09-28
> 范围：项目台账列表的删除入口与两步确认

## 背景

项目台账已有软删除接口 `DELETE /api/v1/projects/{pid}`：仅管理员可调用，把项目
写入 `deleted_at`（移入回收站），关联数据保留、可恢复。但入口只藏在「编辑项目」
弹窗里，且 `doing`（进行中）/ `filed`（已立项）状态被后端硬性拒绝删除。

本次要让台账列表直接可见删除入口，并放开状态限制。

## 决策（已与用户确认）

1. **删除语义不变**：仍是软删除（移入回收站），关联的任务、支出、附件、跟进、
   审批记录全部保留，仅管理员可在「系统管理 → 回收站」恢复。不做物理/级联删除。
2. **入口**：项目台账列表的每一行（桌面表格操作列 + 手机端卡片操作区）都提供
   「删除」按钮，仅管理员可见。
3. **二次确认**：连续两个确认弹窗。第一步说明影响，点「继续删除」；第二步做最终
   确认，点「确认删除」才真正执行。防止误点一步删掉。
4. **放开状态限制**：任意状态（含进行中 / 已立项）均可删除。删除只进回收站，
   因此不需要先取消或归档。

## 实现

### 后端 `api/routers/projects.py`

`delete_project` 移除 `if p.status in ("doing", "filed")` 的 400 分支；保留
`require_admin`、软删除与审计 `delete_project`，响应不变。无数据库迁移。

### 前端

- `web/app/(dashboard)/projects/ProjectsListContent.tsx`：新增 `canDelete` /
  `onDelete` 两个 prop，在表格行与卡片操作区按 `canDelete` 渲染「删除」按钮。
  表格按钮 `stopPropagation`，避免触发整行进入详情。
- `web/app/(dashboard)/projects/ProjectDeleteDialogs.tsx`（新增）：把两步确认
  抽成独立组件，由调用方传入 `target` / `step` / 回调。三个删除入口
  （列表行、详情抽屉、编辑弹窗）复用同一流程。
- `web/app/(dashboard)/projects/page.tsx`：新增 `deleteStep` 状态与
  `requestDelete` / `closeDelete` / `confirmDelete`；列表、详情抽屉、编辑弹窗的
  删除入口统一走 `requestDelete`，并去掉前端的状态守卫。

### 测试

- `tests/test_mvp.py`：原来断言 `filed` 删除返回 400 的用例改为 200，并补充
  删除 `filed` / `doing` 项目后进入回收站、恢复后可再删的断言。
- `web/lib/projectsDeleteFlow.dom.vitest.test.tsx`（新增）：验证删除按钮仅管理员
  可见、点击回调传入项目；以及两步确认「第一步只进入下一步、第二步才执行」。

## 非目标

- 不实现物理删除 / 级联清除关联数据（与 ADR-007「软删除而不物理删除业务聚合」一致）。
- 不改动回收站的恢复流程。
