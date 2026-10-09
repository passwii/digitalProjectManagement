# 功能模块驱动项目数据范围（Stage 6）

日期：2026-10-09

## 背景与症状

Stage 5 把页面可见性与接口访问收敛为「功能模块手动分配」后，出现一个错位契约：

- 管理员给用户分配「项目台账」等基础模块后，**菜单出现了、接口也放行了**，但页面里的
  内容是空的——因为项目列表/统计还额外按「项目负责人或项目成员」过滤
  （`core.rbac.visible_project_condition`），被授权的用户不在任何项目里，自然什么都看不到。
- 管理员（`is_super_admin`）跳过该过滤，所以表现为「管理员全可见、被授权用户看不到内容」。

结论：模块授权只控制了「入口」，数据范围还停在旧的成员关系上，两层判定不一致。

## 新契约（用户确认）

**拥有任一项目内容模块（`opportunities` / `projects` / `assets` / `reports`）=
项目数据全局可读写。**

- 项目台账、支出报表、工作台的内容与其子资源（任务/预算/支出/里程碑/应收/附件/跟进）
  一律全局可见、全局可写，不再要求是负责人或成员。
- 未分配基础模块的用户回落到「负责人/成员」参与范围（项目内容入口由路由门禁 403）。
- 独立业务规则仍在项目范围之上，不被本次放大：
  进度填报只能报自己的任务、快照确认仅负责人、项目删除/回收站仅超级管理员、
  支出重提仅申请人本人、附件删除仅上传者或超级管理员、归档/解归档仍按负责人/超管。

## 实现

- `api/core/rbac.py`：新增 `PROJECT_SCOPE_MODULES` 与 `has_project_scope(user)`；
  `can_read_project` / `check_project_access` / `visible_project_condition` 的全局判定
  由 `is_admin(user)` 换成 `has_project_scope(user)`。这是本次唯一的作用点——
  项目列表、子表下推、应收、报表与工作台的过滤全部共用这三个函数。
- `api/routers/dashboard.py`：`my_projects` 的全局判定同样改用 `has_project_scope`，
  否则「我的项目」KPI 与看板其余数字自相矛盾。
- `api/main.py`：`projects` / `reports` / `project_receivables` 三门禁直接引用
  `PROJECT_SCOPE_MODULES`，保证「能进路由 ⇔ 拥有全局范围」，不留半开状态。
- `web/lib/useMeta.ts`：`useMenus` 新增 `hasProjectScope`（与后端同源，镜像模块 key）。
- `web/app/(dashboard)/projects/[id]/page.tsx`：写入口改用 `hasProjectScope`；
  删项目仍用 `isSuperAdmin`（后端 `require_admin`），避免放出必然 403 的按钮。

## 测试

- 新增 `tests/test_module_data_scope.py`：模块持有者全局读（列表/详情/子资源/报表/工作台）、
  全局写（任务/支出/跟进）与独立规则仍在（他人任务填报 403、非负责人确认快照 403）、
  零模块用户回落成员范围。
- 旧断言对齐新契约：`test_mvp.py`（5 项）、`test_project_receivables.py`（2 项）、
  `test_stage4a_closure.py`（1 项）、`test_blf1148_owner_dept.py`（1 项）中
  「非参与人 → 403」的用例改用显式的零模块用户——存量测试账号
  （`outsider`/`cost`/`exec`/`deptm`）默认流转四个基础模块，已属全局范围，
  不能再代表成员边界（这本身就是本次契约变化的直接后果）。
- 前端 `lib/userModuleAssignment.test.ts` 增加同源契约断言（前后端模块集合 + 页面判定）。

验证：后端 `pytest tests` 348 passed；前端 `npm run test:unit` 259 passed、
`npm run test:motion` 339 passed；`tsc` 本次改动零错误。
