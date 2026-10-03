# 超级管理员与功能模块权限简化实施计划

> **面向执行者：** 实施前使用 `subagent-driven-development`（推荐）或 `executing-plans` 技能；按任务逐项执行并在每个任务后检查。每一步使用复选框跟踪。

**目标：** 将系统权限收敛为唯一不可被普通用户管理 API 变更的超级管理员，以及由超级管理员按功能模块授予普通用户的访问权限；财务以一个功能模块统一控制。

**架构：** 在 `users.is_super_admin` 中持久化唯一超级管理员身份，以 PostgreSQL 部分唯一索引防止重复；RBAC 模块目录移除可分配的系统管理模块并加入财务模块。系统管理 API 只认超级管理员；业务路由使用共享模块判定；财务不再由账套成员或财务角色授权，但保留账套、期间、项目可见范围及凭证等业务校验。前端分别以超级管理员身份控制系统管理、以模块集合控制业务入口和财务操作。

**技术栈：** FastAPI、SQLAlchemy、Alembic、PostgreSQL、pytest、Next.js 14、React 18、TypeScript、Vitest、Node.js `node:test`。

## 全局约束

- 唯一超级管理员由 `api/seed.py` 中的 `INITIAL_ADMIN_USERNAME` 确定；新标记默认 `false`，数据库只允许至多一行 `true`。
- 普通请求不能设置超级管理员身份，普通用户不能通过 `admin` 角色或模块获取系统管理权；超级管理员账号不能被停用。
- 可分配模块为 `opportunities/projects/assets/reports/contacts/partners/approvals/finance`；`admin` 不进入可分配模块目录。
- 新用户创建时显式分配空模块；已有 `modules_assigned=true` 用户保留除 `admin` 外的有效业务模块，未显式分配用户继续使用四个基础模块。
- `finance` 模块控制财务模块及全部活动账套访问，不通过 `account_book_members` 或财务角色筛用户；历史成员记录保留但不再用于授权。
- 保留项目参与范围、审批状态机、账套软删除、会计期间状态、凭证借贷平衡及其他业务数据校验。
- 所有 Git 提交信息使用中文；若产生 PR，标题与分节标题均使用中文。
- 不新增依赖；数据库测试必须使用隔离 PostgreSQL 的 `TEST_DATABASE_URL`，不能把跳过视为通过。

---

## 文件职责

- `api/alembic/versions/0034_superadmin_modules.py`：增加超级管理员标志，回填种子账号，清理旧 admin 身份关联和不可分配模块关联，添加部分唯一索引。
- `api/models/__init__.py`：在 `User` 上声明超级管理员字段及 metadata 部分唯一索引，保证测试建表和线上迁移结构一致。
- `api/seed.py`：新建或补齐种子账号时设置 `is_super_admin=True`；不从旧角色推导身份。
- `api/core/rbac.py`：将全局管理员判定改为超级管理员字段；维护不含 `admin` 的可分配模块目录和 `finance` 权限；统一模块检查。
- `api/routers/admin.py`：集中保护系统管理接口；用户数据返回超级管理员标记；禁止角色写入、超级管理员字段写入和停用超级管理员；新用户默认空模块。
- `api/main.py`、`api/routers/projects.py`、`api/routers/project_receivables.py`：将路由级菜单门禁改为超级管理员判定或业务模块判定，消除对 `MODULE_ADMIN` 的依赖。
- `api/routers/meta.py`：按实际功能模块返回菜单，系统管理入口只附加给超级管理员，财务菜单只按 `finance` 模块产生。
- `api/routers/finance.py`、`api/routers/finance_accounting.py`：以 finance 模块作为统一财务访问边界；移除账套成员 CRUD 路由及财务角色授权检查；保留业务状态校验。
- `tests/conftest.py`：将集成测试夹具的固定 `admin` 测试身份标记为超级管理员，不再依赖 `admin` 角色表达权限。
- `tests/test_migration_revision_ids.py`：验证新迁移 head、回填、部分唯一性和对旧关联的清理。
- `tests/test_user_modules.py`、新增 `tests/test_super_admin.py`：覆盖模块目录、唯一超级管理员、系统管理后端门禁、不可停用、旧 admin 角色无权和角色/身份篡改拒绝。
- `tests/test_finance_vouchers.py`、`tests/test_finance_project_expense_voucher.py` 及 `tests/` 中其他命中财务成员/角色授权断言的文件：把旧账套角色矩阵测试改为模块授权矩阵，同时保留数据范围与会计业务规则验证。
- `web/lib/api.ts`：扩展 `MenuResp`、`AdminUser` 的超级管理员字段和 finance 模块契约，移除账套成员 API 客户端。
- `web/lib/useMeta.ts`：向现有权限 hook 暴露 `isSuperAdmin`；兼容用到 `isAdmin` 的旧 UI 时保证它只映射后端超级管理员标志；`canFinance` 只来自 finance 模块。
- `web/app/(dashboard)/admin/page.tsx`、`web/app/(dashboard)/admin/UserDialog.tsx`：系统管理页只允许超级管理员；去掉角色页签与角色配置；列表展示超级管理员标签并隐藏其停用按钮；弹窗仅配置模块，新用户默认不勾选模块。
- `web/app/(dashboard)/finance/page.tsx`、`web/app/(dashboard)/finance/ArapPanel.tsx`、`web/app/(dashboard)/finance/BookMembersDialog.tsx`：所有已分配财务模块的用户使用相同财务操作；去掉账套成员权限 UI 与管理员/角色专属动作判断。
- `web/lib/userModuleAssignment.test.ts`、`web/lib/finance*` 测试：锁定新管理页、模块权限和财务模块 UI 契约。

## Task 1: 超级管理员身份与数据库迁移

**文件：**
- 新建：`api/alembic/versions/0034_superadmin_modules.py`
- 修改：`api/models/__init__.py`
- 修改：`api/seed.py`
- 修改：`tests/conftest.py`
- 修改：`tests/test_migration_revision_ids.py`
- 测试：新增 `tests/test_super_admin.py`

**接口约定：**
- `User.is_super_admin: bool`，数据库 `NOT NULL DEFAULT false`。
- PostgreSQL 唯一索引：`uq_users_single_super_admin`，表达式目标为 `is_super_admin`，谓词为 `is_super_admin IS TRUE`。
- Alembic revision 使用 `0034_superadmin_modules`，父 revision 为 `0033_project_receivable_updaters`，revision 长度不超过 32。
- 迁移只把用户名等于 `INITIAL_ADMIN_USERNAME` 的用户标成超级管理员；删除其他用户 `admin` 角色关系和 `user_modules.module='admin'` 行，不转换账套成员权限、不自动扩展模块授权。

- [x] **步骤 1：先写迁移契约测试**。在 `tests/test_migration_revision_ids.py` 新增 revision 父链断言和 PostgreSQL 最小表迁移测试：创建 `users(id, username)`、`roles(id, code)`、`user_roles(user_id, role_id)`、`user_modules(user_id, module)`；插入初始账号 `15796280534`、普通账号 `13900000001`、admin role 及两人的 admin 角色关系，并为普通账号插入 `user_modules(admin)`；加载新迁移模块并执行 `upgrade()`；断言只给初始账号设 true、普通用户 admin role 和 admin module 已清除、唯一索引存在；再尝试插入第二个 `true` 用户并断言 `IntegrityError`。迁移回滚后断言 `is_super_admin` 列与索引不存在。无 `TEST_DATABASE_URL` 时该集成用例必须报告 skip，CI 缺失数据库仍由 `conftest.py` 失败。
- [x] **步骤 2：运行迁移测试确认先失败**。运行 `pytest tests/test_migration_revision_ids.py -q`；预期新 revision 文件缺失导致失败，旧用例结果用于基线。
- [x] **步骤 3：补用户模型和 migration**。在 `User` 增加 `is_super_admin = Column(Boolean, nullable=False, default=False, server_default="false")`；在模型 metadata 使用 PostgreSQL partial unique index。创建 revision `0034_superadmin_modules`，按次序添加默认 false 字段、按 `INITIAL_ADMIN_USERNAME` 对既有用户回填 true、清理非初始用户 admin 角色关系、清理 `user_modules` 中 `admin` 行、创建部分唯一索引。downgrade 只删除索引和新列，不恢复旧 admin 角色或模块关联，避免重新授出旧特权。
- [x] **步骤 4：更新 seed 和测试夹具**。在 `api/seed.py` 中无论种子账号新建还是已存在，都确保 `admin.is_super_admin = True`；只保留/补齐初始账号的 `admin` 角色作为旧系统兼容字段，不由该角色判权。测试夹具 `mk()` 增加显式身份参数，并只在创建测试登录名 `admin` 时传 `is_super_admin=True`；其他账号即使后续带有 admin role 也维持 false。
- [x] **步骤 5：验证迁移和模型**。运行 `pytest tests/test_migration_revision_ids.py -q`，并在配置 `TEST_DATABASE_URL` 时执行完整 migration test；运行 `alembic heads`，预期唯一 head 为 `0034_superadmin_modules`；用 Python/SQLAlchemy 检查 `Base.metadata.create_all()` 能建立 `uq_users_single_super_admin`，重复超级管理员写入被数据库拒绝。
- [x] **步骤 6：提交身份 schema 单元**。运行 `git diff --check` 后提交相关文件，中文提交标题示例：`权限：增加唯一超级管理员身份`。

## Task 2: 后端 RBAC、管理 API 与系统管理门禁

**文件：**
- 修改：`api/core/rbac.py`
- 修改：`api/main.py`
- 修改：`api/routers/admin.py`
- 修改：`api/routers/meta.py`
- 修改：`api/routers/projects.py`
- 修改：`api/routers/project_receivables.py`
- 修改：`tests/test_user_modules.py`
- 新建：`tests/test_super_admin.py`

**接口约定：**
- `is_admin(user) -> bool` 与 `is_super_admin(user) -> bool` 均只返回 `bool(user.is_super_admin)`；`require_admin(user)` 仅允许超级管理员，拒绝信息为“仅超级管理员可操作”。
- `MODULE_ADMIN` 从可分配目录和 `ALL_MODULES` 中移除；`MODULE_FINANCE = "finance"` 加入 `MODULE_CATALOG`，标签“财务管理”，路由 `/finance`。
- 超级管理员 `effective_modules()` 返回 `ALL_MODULES`；普通用户按显式模块集合或既有四个默认业务模块计算。`admin` 不能作为有效普通模块。
- `/meta/me/menus` 返回 `is_super_admin`，兼容返回值 `is_admin` 也等于超级管理员身份；`menus` 只包含实际功能模块，超级管理员额外收到仅后端附加的 `/admin` 菜单项；`can_finance` 为 finance 模块判定，`can_toggle_demo` 为超级管理员身份。
- 用户创建/编辑请求不支持 `roles` 或 `is_super_admin` 写入；创建请求模型使用 Pydantic `extra="forbid"`，传入任一字段返回 400，不静默忽略；PATCH 对这两个键显式返回 400。`modules` 含 `admin` 返回 400。超级管理员状态 `disabled` 返回 409；状态 `active` 可恢复。

- [x] **步骤 1：编写后端失败测试**。在 `tests/test_super_admin.py` 用 `db` 创建一个普通账号并关联旧 `admin` role；断言 `/admin/users`、`/admin/params` 返回 403，`/meta/me/menus` 的 `is_super_admin`/`is_admin` 均为 false，且没有 `/admin` 菜单；同文件测试超级管理员 `PATCH {"status":"disabled"}` 返回 409、数据库状态未变；测试新建请求提交 `roles:["admin"]`、`is_super_admin:true` 或 patch 这两个字段均 400，提交 `modules:["admin"]` 400，数据库不会出现被提权用户。更新 `tests/test_user_modules.py`：模块目录含 finance、不含 admin，普通用户显式空模块时没有 admin 菜单，旧 admin role 不改变菜单或模块集合。
- [x] **步骤 2：运行新增用例确认失败**。运行 `pytest tests/test_super_admin.py tests/test_user_modules.py -q`；预期失败点应显示当前代码仍从 role 授权或未返回 `is_super_admin`，而非测试语法/数据库错误。
- [x] **步骤 3：重构 RBAC 模块目录和身份函数**。把 `is_admin()` 改为读取 `is_super_admin`，提供同义 `is_super_admin()`；`require_admin()` 报“仅超级管理员可操作”。删除 `MODULE_ADMIN` 与“系统管理”目录项，新增 finance 常量和目录项。`effective_modules()` 对超级管理员返回所有业务模块、对普通用户丢弃/不识别 admin 键；保留既有普通用户默认模块规则；`can_approve()` 继续仅取 approvals 模块。
- [x] **步骤 4：固定 admin API 的身份边界和写载荷**。为 `api/routers/admin.py` 增加统一依赖 `_require_super_admin(user=Depends(get_current_user))`，绑定至整个 router，保留单个路由显式调用 `_admin` 时统一改为同一个身份函数，避免未来新增接口漏鉴权。`_u()` 返回 `is_super_admin`。`create_user()` 将 `modules=None` 规范成 `[]` 并调用 `_apply_modules()` 使新账号 `modules_assigned=True`；创建/patch 若传角色字段或 `is_super_admin` 返回 400；`_apply_modules()` 在发现 `admin` 时返回 400；`update_user()` 在赋值状态前先检查超级管理员是否要停用，拒绝后不改任何列、不写审计；普通状态恢复时清空锁定计数。
- [x] **步骤 5：更新菜单及路由级系统管理权限**。在 `api/routers/meta.py` 菜单列表按有效模块过滤模块目录，再仅对超级管理员附加 `{"key":"admin","label":"系统管理","href":"/admin"}`；输出 finance 的 `can_finance` 只根据有效模块。`api/main.py` 不再将 admin router 与 `MODULE_ADMIN` 绑定；由 admin router 自己的超级管理员依赖保护。项目台账/应收路由级模块列表去掉 `MODULE_ADMIN`，超级管理员仍因 `effective_modules()` 拥有所有业务模块；端点内部所有现有 `require_module(..., MODULE_ADMIN)` 改为 `require_admin()`。
- [x] **步骤 6：验证 RBAC 与用户管理**。运行 `pytest tests/test_super_admin.py tests/test_user_modules.py tests/test_mvp.py -q`；新增超管和模块用例必须通过；检查老 `admin` role 的测试用户仍不能访问全局端点。运行 `rg -n 'MODULE_ADMIN' api`，预期无可分配模块常量遗留，只有必要的系统管理身份代码不得以模块形式授权。
- [x] **步骤 7：提交后端身份与模块边界**。审阅新增 admin dependency 覆盖所有路由、拒绝角色/身份 payload 在任何写入前发生，再用中文提交标题：`权限：将系统管理限制为唯一超级管理员`。

## Task 3: 前端系统管理只配置功能模块

**文件：**
- 修改：`web/lib/api.ts`
- 修改：`web/lib/useMeta.ts`
- 修改：`web/app/(dashboard)/admin/page.tsx`
- 修改：`web/app/(dashboard)/admin/UserDialog.tsx`
- 修改：`web/lib/userModuleAssignment.test.ts`
- 修改：`web/lib/identityCore.ts` 与 `web/lib/identityCore.test.ts`（仅在旧身份文案依赖角色名而需要删除时）

**接口约定：**
- `MenuResp` 新增必需 `is_super_admin: boolean`；为兼容旧消费者继续解析 `is_admin`，但其语义固定为超级管理员。
- `MenuState` 新增 `isSuperAdmin: boolean`；旧 `isAdmin` 只能由 `is_super_admin` 映射。`canFinance` 只来自菜单接口 finance 判定。
- `AdminUser` 增加 `is_super_admin: boolean`；角色字段可以保留只读兼容但不得有任何管理页编辑能力。
- `admin/page.tsx` 的权限门禁使用 `isSuperAdmin`；tab 固定为“用户、字典、参数、日志、回收站”，删除“角色”页签和 `adminApi.roles()` 加载。
- `UserDialog` props 不再接收 roles，payload 不再携带 roles，新账号初始 `pickedModules=[]`，modules 传空数组保持显式无权限。

- [x] **步骤 1：先更新前端源契约测试**。修改 `web/lib/userModuleAssignment.test.ts`：断言模块目录和弹窗含 finance、不含 `DEFAULT_MODULE_KEYS` 默认业务模块与角色选择；新用户初始 `pickedModules` 为空；管理页使用 `isSuperAdmin` 而不是 `hasModule("admin")`；用户列表包含超级管理员身份判断且不会对超级管理员渲染停用动作。先运行 `cd web && npm run test:unit` 并确认新增断言因旧实现失败。
- [x] **步骤 2：补类型与菜单 hook**。在 `MenuResp`、`AdminUser` 添加 `is_super_admin`/`is_super_admin` 类型；`MenuState` 暴露 `isSuperAdmin` 并通过 `Boolean(data?.is_super_admin)` 返回；`isAdmin` 兼容别名等于 `isSuperAdmin`。`canFinance` 继续取 API 的 finance 标志，但确保此字段是菜单模块推导，不进行任何本地角色推断。
- [x] **步骤 3：简化系统管理用户页面**。`TABS` 移除“角色”；移除 roles `useAsyncData`、`roleItems` 及 `UserDialog roles` 参数；用户卡片和表格将“角色”列替换为“身份”，超级管理员显示“超级管理员”徽标，其余显示“普通用户”。`userActions(u)` 保留编辑，但超级管理员不得显示停用按钮；超级管理员自己在前端仍可编辑个人姓名或密码，但不能提交停用状态。
- [x] **步骤 4：简化用户编辑弹窗**。移除 `roles` prop、`picked` 状态、角色校验和角色按钮；初始 `pickedModules` 设为 `[]`，打开新用户时清空模块勾选；保留编辑时对当前 modules 回填。新增和编辑 payload 只发送姓名、部门、密码（有输入时）与 `modules`，角色不会被传给后端。模块提示明确“模块控制可访问功能，财务模块包含全部活动账套；系统管理仅超级管理员可用”。
- [x] **步骤 5：验证用户管理界面**。运行 `cd web && npm run test:unit` 与 `cd web && npm run test:motion -- lib/userModuleAssignment.test.ts`；运行 `cd web && npx tsc --noEmit --incremental false`；确认 0 TS 错误，源契约断言不再要求 `/admin` 是普通模块。
- [x] **步骤 6：提交管理 UI 单元**。运行 `git diff --check`，中文提交标题示例：`前端：用户管理改为超级管理员与模块分配`。

## Task 4: 后端财务模块统一授权

**文件：**
- 修改：`api/core/rbac.py`
- 修改：`api/main.py`
- 修改：`api/routers/meta.py`
- 修改：`api/routers/finance.py`
- 修改：`api/routers/finance_accounting.py`
- 修改：`tests/test_finance_vouchers.py`
- 修改：`tests/test_finance_project_expense_voucher.py`
- 修改：`tests/` 中所有由财务成员/角色作用户访问门槛的其他测试文件，以 `rg -n 'AccountBookMember|finance_clerk|finance_reviewer|finance_manager|仅管理员可访问财务模块' tests` 结果为准

**接口约定：**
- `finance.router` 和 `finance_accounting.router` 在 `api/main.py` 统一以 `Depends(_module_guard(MODULE_FINANCE))` 挂载；未分配 finance 的用户在路径业务逻辑前收到 403。
- `_book_access(db, user, book_id)` 只要求账套存在且未软删除，不查询成员关系。
- `finance_accounting._role(db, user, book_id, allowed=None)` 改为校验 finance 模块（或者删除并将全部调用点替换为 `require_module(user, MODULE_FINANCE)`）；allowed 财务角色参数不再提供权限判定。
- 成员 API `GET/PUT/DELETE /finance/books/{book_id}/members...` 被移除；`account_book_members` 模型和历史行保留。
- 全部获得 finance 模块的账号具有相同财务模块访问权；期间开闭、凭证状态、借贷平衡、辅助资料一致性和可见项目限制继续执行。

- [x] **步骤 1：新增财务模块权限测试**。在 `tests/test_finance_vouchers.py` 新增测试：超级管理员创建一个账套后，普通用户在无 `AccountBookMember` 行时访问 `/finance/books` 返回 403；超级管理员通过 `/admin/users/{id}` 分配 `modules:["finance"]` 后，普通用户 `/meta/me/menus` 含 finance、`GET /finance/books` 返回全部活动账套、设置 `X-Account-Book` 后可读科目树；即使手工插入错误/无效 `AccountBookMember.role`，已分配 finance 的用户仍能读写符合业务状态的凭证。另断言历史成员行不能使未分配用户访问财务，并且 finance member CRUD 路由不再注册（请求非 404 以外的处理结果均失败）。在 `tests/test_finance_project_expense_voucher.py` 调整项目支出测试：给普通测试账号分配 finance 模块后，只让项目归属/可见范围决定该项目支出是否可生成凭证，旧 reviewer/clerk 角色变更不改变该判定。
- [x] **步骤 2：运行财务测试确认旧权限与新测试冲突**。运行 `pytest tests/test_finance_vouchers.py tests/test_finance_project_expense_voucher.py -q`；预期失败集中在旧账套角色门槛/成员可见性断言及新 finance 模块行为，不应有 fixture、金额或期间数据错误。
- [x] **步骤 3：把财务模块接入后端 router guard**。在 `api/main.py` 导入 `MODULE_FINANCE`，以模块依赖挂载 `finance.router` 和 `finance_accounting.router`；这些路由不再放入没有门禁的通用路由循环。更新文件顶部的 API 描述，说明用户访问由 finance 模块控制、业务状态校验保持不变。
- [x] **步骤 4：移除账套成员和角色准入**。`finance.py` 删除三个 members endpoint；`_book_access()` 保留活动账套查询并删除 `AccountBookMember` 分支；`list_books()` 返回所有未软删除账套；所有原先通过 `is_admin()` 阻止创建、删除、恢复、查看回收站和基础设置的判断，改为路由统一 finance guard，不再存在模块使用者不能操作的管理员角色分层。新建账套时可继续创建一条操作者历史 member 行，但不得从该行判定权限；推荐停止新建这类授权行，清理创建账套时自动插入 `AccountBookMember(owner)` 的逻辑。
- [x] **步骤 5：移除会计角色授权门槛**。`finance_accounting.py` 删除财务角色导入及基于 allowed role 集合的权限判断；把所有 `_role(db, user, book.id, {ROLE_...})` 替换为统一 finance 模块断言，并保留调用前的期间、凭证、数据范围和业务校验。将原由 `_admin()` 区分的会计操作统一开放给 finance 模块用户；移除 `_admin()` 身份分支，但不能移除后续的数据一致性与状态校验。
- [x] **步骤 6：验证财务授权与业务约束**。运行 `pytest tests/test_finance_vouchers.py tests/test_finance_project_expense_voucher.py tests/test_finance_p0a_review.py -q`，并运行 `rg -n 'AccountBookMember|_role\(db, user|ROLE_FINANCE_|ROLE_CASHIER|仅管理员可访问财务模块' api/routers/finance.py api/routers/finance_accounting.py`。预期成员模型只可留作未用于权限的引用（宜为 0），财务角色不参与 API allow/deny；凭证平衡、期间关闭和项目可见性回归测试仍通过。
- [x] **步骤 7：提交财务 API 权限边界**。审阅所有 finance router route 都受 `MODULE_FINANCE`，并确认 403 发生在任何账套数据读取前；中文提交标题示例：`权限：以财务功能模块统一控制账套访问`。

## Task 5: 前端财务统一授权与移除成员管理

**文件：**
- 修改：`web/lib/api.ts`
- 修改：`web/app/(dashboard)/finance/page.tsx`
- 修改：`web/app/(dashboard)/finance/ArapPanel.tsx`
- 删除：`web/app/(dashboard)/finance/BookMembersDialog.tsx`
- 修改：`web/lib/finance*` 中引用账套成员 API 或财务角色 UI 的现有测试

**接口约定：**
- 财务页渲染的权限入口为 `canFinance`，该值来自 finance 模块；没有 finance 模块时展示“未分配财务管理模块”的无权限说明。
- 新建/移入回收站/恢复账套、凭证等财务操作都对拥有 finance 模块的用户开放；“成员与权限”入口、弹窗和成员 CRUD 客户端全部移除。
- `ArapPanel` 不根据 `isAdmin` 隐藏成员可操作但财务模块已统一开放的应收应付功能；仍保留单据审批状态、数据关联和业务完整性提示。

- [x] **步骤 1：更新财务前端契约测试**。在适用的 `web/lib/finance*.test.*` 添加断言：finance module true 显示所有模块可用操作，普通用户也能看到新建账套；没有 finance module 显示无权限；代码不再含 `BookMembersDialog` 或 `financeApi.members/saveMember/removeMember`。运行对应 vitest 用例确认旧实现失败。
- [x] **步骤 2：删除成员授权 API 客户端**。从 `web/lib/api.ts` 移除 `FinanceRole`、`FinanceBookMember` 和 `financeApi.members/saveMember/removeMember`；保留其他财务 API 请求签名不变。
- [x] **步骤 3：改财务页所有权限条件**。移除 `isAdmin`，读取 `canFinance`；只有模块已获授权才显示财务页，财务页中的新建账套、回收站、恢复/删除和所有财务操作都不再按超级管理员隐藏。删除 `bookMembersOpen` 状态、成员按钮、移动端菜单项、弹窗 import/render 和授权变更提示。
- [x] **步骤 4：统一应收应付操作 UI**。从 `ArapPanel` props 删除 `isAdmin`，移除通过角色隐藏的配置/操作按钮；把“管理员需先补齐资料”改为任何 finance 用户都可以补齐或按同一业务校验提示操作。保持项目支出单据可见性说明和 API 403/404 反馈准确，不因 finance 模块扩权绕过项目数据范围。
- [x] **步骤 5：移除组件并回归 UI**。删除 `BookMembersDialog.tsx`，清理相应测试引用；运行 `cd web && npm run test:motion` 与 `cd web && npm run test:unit`；然后 `cd web && npx tsc --noEmit --incremental false`，预期组件 props/API 类型无错误。
- [x] **步骤 6：提交财务 UI 权限调整**。运行 `git diff --check`，中文提交标题示例：`前端：按财务模块开放统一操作并移除成员授权`。

## Task 6: 跨模块回归、迁移与交付验证

**文件：**
- 修改：`api/main.py` 中权限契约说明
- 修改：`api/core/rbac.py`、`api/routers/meta.py` 中过期注释
- 修改：`README.md` 中若仍说明 admin 角色为唯一管理角色、财务账套成员为访问授权的章节
- 修改：所有被完整套件指出仍依赖 `is_admin` = legacy role 或账套财务 role 的回归测试

**接口约定：**
- 文档对外语义为“唯一超级管理员 + 功能模块”；旧 `admin` role 字段保留不表示拥有超级管理员权限。
- 保留角色表、`user_roles`、`account_book_members` 模型是兼容性选择，不表示这些记录继续参与本次身份判定。
- 所有用户数据可见范围、业务状态规则在角色/模块权限变更后依旧由现有逻辑校验。

- [x] **步骤 1：运行完整后端测试并归因权限回归**。设置隔离的 `TEST_DATABASE_URL` 后运行 `pytest tests -q`；修正所有旧测试中把角色、账套成员当成导航/API授权的断言，不跳过未通过项；保留数据库必需测试的实际执行证据。
- [x] **步骤 2：运行前端完整验证**。运行 `cd web && npm run test:unit`、`cd web && npm run test:motion`、`cd web && npx tsc --noEmit --incremental false`、`cd web && npm run build`。任何 build 告警要区分既存警告和本改动导致的构建/类型失败。
- [x] **步骤 3：验证 Alembic 迁移链和幂等 seed**。运行 `alembic heads` 确认唯一 head；在隔离 PostgreSQL 数据库运行 `alembic upgrade head`，执行 `python -m api.seed` 两次，确认只有初始账号为超级管理员且唯一约束生效；再在一次性数据库验证 downgrade/upgrade。不得对开发或生产数据库做 downgrade。
- [x] **步骤 4：全量搜索权限残留**。运行 `rg -n 'MODULE_ADMIN|modules.*admin|can_finance|AccountBookMember|finance_clerk|finance_reviewer|finance_manager|is_admin\(' api web tests README.md`；逐条判断剩余命中是兼容类型/历史数据/业务身份用途还是遗漏的授权分支。确认不再有普通用户可配置 admin 模块或角色、不再有 financial role-based guards、不再有财务成员权限 UI。
- [x] **步骤 5：审阅差异与中文文档**。运行 `git diff --check`；检查 API 错误信息、权限文案和 README 章节使用中文；确认迁移 downgrade 没有重新授出或伪造任何角色授权。
- [x] **步骤 6：完成实现审查**。用 `requesting-code-review` 与 `verification-before-completion` 技能按风险审查差异并复跑失败修复后的定向测试；提交前总结迁移、后端/前端测试与 build 的真实结果，不把 skip 当通过。整分支复审发现审批通知与 approvals 模块授权范围不一致，已修复为通知超级管理员与已启用、显式分配 approvals 模块的用户；预算预警仍仅发给超级管理员。
- [x] **步骤 7：最终提交或 PR**。按仓库当前分支流程提交剩余变更，提交标题中文；如创建 PR，PR 标题为中文且正文全部采用中文分节标题。没有用户明确要求时不自行合并。

## 计划自检

- 设计中的唯一超级管理员标记、不可停用、系统管理独占、普通用户无角色写入、新账号空模块、老模块数据兼容、finance 模块统一放权、历史财务成员数据保留、业务校验保留均有对应任务。
- 后端和前端分别验证 UI/API 一致性；finance 访问测试明确覆盖有无成员行、admin 旧角色和已分配模块三种差异。
- 所有跨任务接口约定使用一致名称：`is_super_admin`、`isSuperAdmin`、`MODULE_FINANCE`、`finance`；数据库 migration 为 `0034_superadmin_modules`。
- 没有 TBD/TODO/占位实现步骤；数据库 skip 情况明确不等于测试通过。
