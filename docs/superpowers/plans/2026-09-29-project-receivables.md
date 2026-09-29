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

### Task 1：项目应收与回款后端

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

- [x] **步骤 1：先写 API 失败测试**。覆盖应收新增/分页/修改、逐笔部分回款和汇总状态、足额后禁止超收、应收金额不得低于已收、管理员软删除与非管理员 403、非项目成员 403、归档项目只读、软删除回款不计入余额、软删除项目不可读取、金额/日期非法、审计日志产生；另加列表回款汇总查询次数回归。
- [x] **步骤 2：确认测试因端点不存在而失败**。隔离 PostgreSQL 临时 schema 中，首轮新增的 5 项按预期因 `/projects/{pid}/receivables` 尚不存在而返回 404。
- [x] **步骤 3：实现模型与迁移**。新增应收/回款表及约束、索引，外键使用 RESTRICT 保留业务历史；迁移 revision `0032_project_receivables` 下接 `0031_equipment_batch_names`，独立 schema 执行 upgrade 成功。
- [x] **步骤 4：实现路由与事务校验**。使用 `check_project_access`，拒绝已归档项目写入；写操作先锁项目行 `SELECT … FOR UPDATE`，再校验有效回款；使用 `Decimal` 与 `app_today()`。回款分页汇总改为一次 `GROUP BY receivable_id`，防止列表 N+1 查询。
- [x] **步骤 5：重新运行后端定向测试**。使用本机 Unix socket PostgreSQL 执行 `pytest tests/test_project_receivables.py -q`，结果 13 passed。
- [x] **步骤 6：静态检查**。`python -m compileall -q api`、`git diff --check` 通过。

### Task 2：年份筛选与页签深链

**文件：**
- 修改：`web/lib/projectYear.ts`
- 修改：`web/lib/projectYear.test.ts`
- 修改：`web/lib/projectTabs.ts`
- 修改：`web/lib/projectTabs.test.ts`

**接口：**
- `buildYearOptions(now?, selectedYear?)` 返回固定 `2027, 2026, 2025, 2024, 2023`。
- `parseYearParam(raw)` 只接受上述五年，其他值返回空字符串。
- 当前页签为 `文档 | 合同 | 进度 | 成本 | 应收 | 日志`；旧值 `支出` 映射到 `成本`，旧值 `变更` 映射到 `日志`。

- [x] **步骤 1：先调整纯逻辑测试**，覆盖固定年份顺序、范围外年份、页签全集、旧值映射与历史 alias。
- [x] **步骤 2：运行定向 `npm run test:unit` 命令**，观察到原实现返回 2020–2028、页签仍用旧值的预期失败。
- [x] **步骤 3：更新两个纯逻辑模块**，固定年份常量和有效年份集合，保留旧页签名映射。
- [x] **步骤 4：运行同一命令及消费端契约测试**；年份/页签单测、详情页内容分支契约通过。

### Task 3：应收 UI 与项目详情整合

**文件：**
- 修改：`web/lib/api.ts`
- 新建：`web/app/(dashboard)/projects/[id]/ProjectReceivablesPanel.tsx`
- 新建：`web/app/(dashboard)/projects/[id]/ProjectReceivableDialogs.tsx`
- 修改：`web/app/(dashboard)/projects/[id]/page.tsx`
- 测试：`web/lib/projectReceivables.dom.vitest.test.tsx`

**接口：**
- `projectsApi.receivables(id, signal?)`、`createReceivable(id, body)`、`updateReceivable(id, rid, body)`、`deleteReceivable(id, rid)`、`receivablePayments(id, rid, signal?)`、`createReceivablePayment(id, rid, body)`、`updateReceivablePayment(id, rid, paymentId, body)`、`deleteReceivablePayment(id, rid, paymentId)`。
- 独立面板接收 `projectId`、`canWrite`、`canDelete`；面板在保存后刷新自己的应收/回款数据并显示操作反馈。

- [x] **步骤 1：先写面板 DOM 测试**，覆盖汇总字段/状态、应收与回款 payload、逐笔历史和新增/删除权限。
- [x] **步骤 2：运行定向 Vitest**，初始因面板模块未创建而按预期失败。
- [x] **步骤 3：实现 API 类型与客户端方法**，金额为十进制字符串，URL/字段与后端契约一致。
- [x] **步骤 4：实现应收与回款弹窗/面板**，复用现有 UI 组件，含 loading、error、empty 与成功提示。
- [x] **步骤 5：整合详情页**。“支出”改“成本”，“变更”改“日志”，增加独立应收页签；写权限基于本人/负责人/成员/管理员，归档项目只读；回款读取可取消。
- [x] **步骤 6：面板 DOM 5 项通过；`npm test` 235 unit + 297 Vitest 通过；`npm run build` 通过。桌面/手机回款明细分别用表格/卡片呈现，避免隐藏视图重复进入屏幕阅读器顺序。**

### Task 4：整体验证与变更自检

**文件：**
- 检查：`api/`、`web/`、`tests/`
- 检查：`docs/superpowers/specs/2026-09-29-project-receivables-design.md`

- [x] 运行 `python -m compileall -q api`。
- [x] 运行 `pytest -q`；全套报告为 333 passed / 87 failed，失败均集中于平板浏览器 fixture：默认端口 3017 未服务或与并行 Next build 争用 `.next` 后静态资源 404。改用隔离 fixture 对应项目表格的两个浏览器用例重跑为 2 passed；后续单独服务检查应收页面桌面/移动布局、页签、汇总、按钮和页面错误无误。
- [x] 运行 `cd web && npm test`（235 unit + 297 Vitest）、`npm run lint`、`npm run build`。lint 仅有仓库既有警告；build 最终单独重跑通过。
- [x] 检查迁移链：`0032_project_receivables (head)`；`git diff --check` 通过；旧年份回落与旧页签兼容有测试保护。
- [x] 审阅最终 diff，确认无财务 ARAP 写入、无历史应收导入、无全局支出文案范围外更改。
