# 项目台账应收与回款实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加与财务隔离的项目应收/回款跟踪，并完成项目详情页签和年份筛选调整。

**Architecture:** FastAPI 新增项目应收子路由、独立 ORM 表与 Alembic 迁移；回款总额始终从有效回款行计算，并在项目行锁保护的同一事务中校验。Next.js 项目详情使用独立应收面板；旧页签深链保留别名，年份筛选由纯函数限定在 2023–2027。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、PostgreSQL、Next.js 14、React 18、TypeScript、pytest、Node test、Vitest。

## 全局约束

- 应收是项目管理独立子账，不读写财务凭证，不导入历史财务应收。
- 金额列使用 `NUMERIC(18,2)`，API 金额返回两位小数字符串。
- 有效回款累计不得超过应收金额；服务端事务必须在项目行锁后重新汇总并校验。
- 项目负责人/成员及管理员可写，只有管理员可软删除；软删除保留数据与审计，不级联物理删除。
- 项目详情“支出”只改为“成本”，“变更”只改为“日志”；其余全局文案不改。
- 年份选项为固定 `2023` 至 `2027`，范围外 URL 年份回落为全部年份。
- Git 标题及 PR 分节抬头统一使用中文。
- 行为改动遵循 TDD：先新增测试、观察预期失败，再实现并复测。

---

### 任务一：项目应收与回款后端

**文件：**
- 修改：`api/models/__init__.py`
- 新建：`api/alembic/versions/0032_project_receivables.py`
- 新建：`api/routers/project_receivables.py`
- 修改：`api/main.py`
- 测试：`tests/test_project_receivables.py`

**接口：**
- `GET /api/v1/projects/{pid}/receivables?page=1&size=20` 返回分页应收项，含 `amount`、`received_amount`、`outstanding_amount`、`status`、日期与回款数。
- `POST /api/v1/projects/{pid}/receivables` 创建应收；`PATCH /api/v1/projects/{pid}/receivables/{rid}` 修改。
- `DELETE /api/v1/projects/{pid}/receivables/{rid}` 管理员软删除应收。
- `GET|POST /api/v1/projects/{pid}/receivables/{rid}/payments` 读取/新增回款。
- `PATCH|DELETE /api/v1/projects/{pid}/receivables/{rid}/payments/{payment_id}` 修改/管理员软删除回款。
- 所有写入将业务行与审计行通过 `commit_audited()` 原子提交；应收/回款只能属于路径对应的活动项目与应收记录。

- [ ] **步骤 1：先写 API 失败测试**。覆盖应收新增/分页/修改、逐笔部分回款和汇总状态、足额后禁止超收、应收金额不得低于已收、管理员软删除与非管理员 403、非项目成员 403、归档项目只读、软删除回款不计入余额、软删除项目不可读取、金额/日期非法、审计日志产生。
- [ ] **步骤 2：确认测试因端点不存在而失败**。运行 `pytest tests/test_project_receivables.py -q`，预期因 `/projects/{pid}/receivables` 尚不存在而失败。
- [ ] **步骤 3：实现模型与迁移**。增加两个表；应收金额/日期/到期日/名称/说明及回款金额/日期/备注均有明确类型、约束和项目/父子索引；外键删除规则不得物理级联抹去业务历史。迁移 revision `0032_project_receivables` 下接 `0031_equipment_batch_names`。
- [ ] **步骤 4：实现路由与事务校验**。使用 `check_project_access`，拒绝已归档项目写入；写操作先锁项目行 `SELECT … FOR UPDATE`，再锁/读取应收并汇总未软删除回款；用 `Decimal` 校验正数、最多两位小数与累计上限。逾期状态基于 `app_today()` 动态计算。
- [ ] **步骤 5：重新运行后端定向测试**。运行 `pytest tests/test_project_receivables.py -q`；若没有 `TEST_DATABASE_URL`，保留完整测试并记录数据库 fixture 跳过。
- [ ] **步骤 6：静态检查**。运行 `python -m compileall -q api` 与 `git diff --check`。

### 任务二：年份筛选与页签深链

**文件：**
- 修改：`web/lib/projectYear.ts`
- 修改：`web/lib/projectYear.test.ts`
- 修改：`web/lib/projectTabs.ts`
- 修改：`web/lib/projectTabs.test.ts`

**接口：**
- `buildYearOptions(now?, selectedYear?)` 返回固定 `2027, 2026, 2025, 2024, 2023`。
- `parseYearParam(raw)` 只接受上述五年，其他值返回空字符串。
- 当前页签为 `文档 | 合同 | 进度 | 成本 | 应收 | 日志`；旧值 `支出` 映射到 `成本`，旧值 `变更` 映射到 `日志`。

- [ ] **步骤 1：先调整纯逻辑测试**，断言固定年份顺序、2028/2022 与非法年份均清空、现行页签全集、旧“支出/变更”映射及现有旧链接行为。
- [ ] **步骤 2：运行 `cd web && npm run test:unit -- --test-name-pattern='年度下拉选项|URL year 参数解析|档案页 Tab 解析'`**，确认固定年份与别名断言按预期失败。
- [ ] **步骤 3：更新两个纯逻辑模块**，固定年份常量和有效年份集合；页签采用中文用户可见值并在兼容表中保留旧名称。
- [ ] **步骤 4：运行同一命令**，确认有关用例通过。

### 任务三：应收 UI 与项目详情整合

**文件：**
- 修改：`web/lib/api.ts`
- 新建：`web/app/(dashboard)/projects/[id]/ProjectReceivablesPanel.tsx`
- 新建：`web/app/(dashboard)/projects/[id]/ProjectReceivableDialogs.tsx`
- 修改：`web/app/(dashboard)/projects/[id]/page.tsx`
- 测试：`web/lib/projectReceivables.dom.vitest.test.tsx`

**接口：**
- `projectsApi.receivables(id, signal?)`、`createReceivable(id, body)`、`updateReceivable(id, rid, body)`、`deleteReceivable(id, rid)`、`receivablePayments(id, rid, signal?)`、`createReceivablePayment(id, rid, body)`、`updateReceivablePayment(id, rid, paymentId, body)`、`deleteReceivablePayment(id, rid, paymentId)`。
- 独立面板接收 `projectId`、`canWrite`、`canDelete`；面板在保存后刷新自己的应收/回款数据并显示操作反馈。

- [ ] **步骤 1：先写面板 DOM 测试**，覆盖汇总字段/状态显示、打开新增应收、提交日期与金额、展开逐笔回款、新增回款、非管理员无删除按钮和无写权限无录入按钮。
- [ ] **步骤 2：运行 `cd web && npm run test:motion -- lib/projectReceivables.dom.vitest.test.tsx`**，确认因待测面板不存在而失败。
- [ ] **步骤 3：实现 API 类型与客户端方法**，响应金额定义为十进制字符串；所有 API URL/字段与任务一后端契约一致。
- [ ] **步骤 4：实现应收与回款弹窗/面板**，使用现有 `Dialog`、`Field`、`DatePicker`、`CardList`、`DesktopTable`、`Badge` 等组件；金额校验可在前端提示，但服务端仍是最终边界。
- [ ] **步骤 5：整合详情页**。成本区域沿用原支出页签；新增应收页签；日志保留变更列表；基于当前用户与项目成员信息计算 `canWrite`，管理员决定 `canDelete`；详情首屏按现有加载/取消模式加载项目数据，面板自行请求应收，避免每次详情加载重复取完整回款历史。
- [ ] **步骤 6：运行 DOM 测试、`cd web && npm run test:unit`、`cd web && npm run test:motion`**。

### 任务四：整体验证与变更自检

**文件：**
- 检查：`api/`、`web/`、`tests/`
- 检查：`docs/superpowers/specs/2026-09-29-project-receivables-design.md`

- [ ] 运行 `python -m compileall -q api`。
- [ ] 运行 `pytest -q`；如无 `TEST_DATABASE_URL`，记录跳过数量，不把跳过描述成通过。
- [ ] 运行 `cd web && npm test && npm run lint && npm run build`。
- [ ] 检查迁移链 `alembic heads` 和 `git diff --check`，确认年份和页签残留只出现在兼容逻辑/测试中。
- [ ] 审阅最终 diff，确认没有任何财务 ARAP 写入、历史应收自动导入或范围外的全局支出文案改动。
