# 项目支出转财务凭证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for task-by-task implementation and review. Steps use checkbox syntax for tracking.

**目标：** 在财务工作台逐笔把已批准项目支出转换为带来源关联的草稿凭证，保留账套/项目权限边界并阻止重复入账。

**架构：** Voucher.source_expense_id 以数据库唯一外键保存项目支出来源；财务 API 在事务中按源金额创建凭证并检查开放期间、角色、项目范围、科目与辅助资料。新增 ProjectExpensePanel 负责来源支出浏览与逐笔表单，主财务页只挂载新页签和提供当前账套、期间上下文。

**技术栈：** FastAPI、SQLAlchemy、Alembic、PostgreSQL、pytest、Next.js 14、React 18、TypeScript、现有 financeApi、useAsyncData、通用表格/弹窗/分页组件。

## 全局约束

- 项目成本与财务账保持两个独立域；禁止根据 Expense.subject 自动推导会计科目。
- 来源支出状态仅允许 approved 和 exception；金额由服务端读取，客户端不可指定。
- 每次转换只生成一张草稿凭证，不自动提交、审核或过账。
- 同一项目支出全局最多关联一张凭证；账套上下文使用 X-Account-Book，并尊重项目可见范围。
- 金额统一 Decimal / NUMERIC(18,2)；所选科目必需的辅助资料必须来自当前账套。
- 迁移升级/降级验证使用隔离 PostgreSQL schema；不连接或迁移任何非临时数据库。

---

### Task 1：来源关联字段与迁移

**文件：**

- 修改：api/models/__init__.py 的 Voucher
- 新建：api/alembic/versions/0026_finance_project_expense_voucher.py
- 新建：tests/test_finance_project_expense_voucher.py
- 验证：临时 schema 上的 migration upgrade/downgrade 脚本

**接口：**

- Voucher.source_expense_id: int | None，外键到 expenses.id，ondelete="RESTRICT" 且唯一；普通凭证保持 NULL。
- 迁移 revision="0026_finance_project_expense_voucher"，down_revision="0025_finance_lifecycle"；增加显式命名的唯一约束 uq_vouchers_source_expense_id 和外键 fk_vouchers_source_expense_id_expenses；降级先移除两项约束再删除列。

- [x] **步骤 1：先增加来源约束的模型回归用例。** 在 tests/test_finance_project_expense_voucher.py 增加 test_voucher_source_expense_id_is_unique_fk_in_metadata，断言 Voucher 元数据含 source_expense_id 外键并带唯一约束。
- [x] **步骤 2：运行新用例确认失败原因。** 运行 pytest tests/test_finance_project_expense_voucher.py::test_voucher_source_expense_id_is_unique_fk_in_metadata -q；预期断言因来源列/约束尚不存在而失败。
- [x] **步骤 3：实现模型与迁移。** 模型新增唯一外键；迁移检查 vouchers 是否存在、列是否已存在，幂等增加/删除 source_expense_id，为已有普通凭证保留 NULL。
- [x] **步骤 4：验证迁移升降级。** 用随机临时 schema 建立最小 expenses/vouchers 表，运行新迁移 upgrade()，检查列、外键、唯一约束；运行 downgrade() 后确认列不存在，再删除 schema。不得对共享 TEST_DATABASE_URL 直接运行 alembic upgrade head。
- [x] **步骤 5：运行回归用例确认模型约束生效。** 再运行同一 pytest 用例，预期列外键目标与唯一约束名称均匹配迁移契约。
- [x] **步骤 6：提交持久化改动。** 使用中文提交标题：财务：为凭证添加项目支出来源关联。

### Task 2：受权限保护的项目支出查询与凭证生成 API

**文件：**

- 修改：api/routers/finance_accounting.py
- 修改：api/models/__init__.py（如新增响应字段）
- 修改：tests/test_finance_project_expense_voucher.py

**接口：**

    GET /api/v1/finance/project-expenses
    query: project_id?, status?, date_from?, date_to?, page=1, size=20
    result: {total, page, size, items:[expense + project + source_voucher_summary]}

    POST /api/v1/finance/project-expenses/{expense_id}/voucher
    body: {
      period_id: int, voucher_date: date, summary: str,
      debit: {account_id: int, aux_detail: dict, cashflow_item: str | null},
      credit: {account_id: int, aux_detail: dict, cashflow_item: str | null}
    }
    result: existing FinanceVoucher fields + source_expense_id

- [ ] **步骤 1：先写 API 行为用例。** 在新测试文件增加以下断言型用例：管理员只能列活动项目中的 approved/exception 支出；生成金额必须取源 Expense.amount 且状态为 draft；客户端传入的 amount 被忽略；pending/rejected、关账期间、跨账套辅助资料均被拒绝；凭证号满足期间唯一约束；重复来源提交最多成功一次；财务角色只能读取自己可访问项目的来源支出；非制单/主管财务角色不能生成。
- [ ] **步骤 2：运行目标用例观察预期失败。** pytest tests/test_finance_project_expense_voucher.py -q；预期新路由返回 404，确认失败由功能缺失导致。
- [ ] **步骤 3：新增请求模型与安全查询。** 增加 ProjectExpenseLineIn 和 ProjectExpenseVoucherIn；读取端要求 require_finance，加入当前活动项目、来源状态与日期筛选，并用 can_read_project/现有可见性查询过滤非管理员项目范围。
- [ ] **步骤 4：新增原子转换服务。** 校验财务角色为 finance_clerk 或 finance_manager（管理员通过）；对期间行加锁并确认开放；锁定源支出并确认状态、活动项目权限和未关联；从当前账套读取启用末级借贷科目并验证所需辅助项 ID 属于当前账套且类型匹配；用 Decimal(str(expense.amount)).quantize(Decimal("0.01")) 作为唯一金额来源；按期间已有 记-#### 编号生成下一个编号；调用 _build_draft_voucher 写入 source="project-expense" 与 source_expense_id，事务内写审计记录。
- [ ] **步骤 5：正确处理冲突和回滚。** 若查询已发现来源关联，返回 409 F-PROJECT-EXPENSE-LINKED 并包含当前用户可见的凭证摘要；唯一约束竞争输的一方回滚并返回同一冲突语义；其他账套的凭证仅返回“已在其他账套转换”，不泄露账套或凭证详情。无效科目、缺辅助资料、期间关闭和日期越界必须无凭证写入。
- [ ] **步骤 6：运行 API 用例。** pytest tests/test_finance_project_expense_voucher.py -q，预期所有新用例通过。
- [ ] **步骤 7：提交后端改动。** 使用中文提交标题：财务：支持项目支出生成草稿凭证。

### Task 3：财务工作台项目支出入账页签

**文件：**

- 修改：web/lib/api.ts
- 新建：web/app/(dashboard)/finance/ProjectExpensePanel.tsx
- 修改：web/app/(dashboard)/finance/page.tsx
- 新建：web/lib/financeProjectExpense.dom.vitest.test.tsx

**接口：**

- financeApi.projectExpenses(book, query, signal) 返回 Paged<FinanceProjectExpense>。
- financeApi.createExpenseVoucher(book, expenseId, body) 只提交期间/日期/摘要/借贷科目/辅助资料，不提交金额或账套 ID。
- FinanceAuxiliaryKind 扩展为 customer、vendor、department、employee、project、cashflow。
- ProjectExpensePanel 接收 {book: FinanceBook, periods: FinancePeriod[], accounts: FinanceAccount[], onVoucherCreated(): void}。

- [ ] **步骤 1：先写组件行为断言。** 在 web/lib/financeProjectExpense.dom.vitest.test.tsx 用测试服务器响应模拟账套可见支出与生成结果，断言可读到源支出金额/项目/账套、金额只读、生成后显示草稿状态和需要审核过账的提示；先运行该测试并确认因面板缺失而失败。
- [ ] **步骤 2：实现分页来源列表。** 按当前账套、项目筛选、状态筛选和日期区间加载；切换账套/筛选时通过 useAsyncData 重置；显示项目/支出信息、已链接凭证状态、加载失败重试与空状态。
- [ ] **步骤 3：实现逐笔转换弹窗。** 展示当前账套、项目、来源支出日期/金额/说明和审批状态；只允许选择开放期间、该期间内日期、启用末级科目；依据科目 aux_flags 显示当前账套对应类型辅助资料和现金流下拉框；金额只读；提交期间禁用重复动作。
- [ ] **步骤 4：接入结果刷新与误操作提示。** 成功提示“草稿凭证已生成，需继续审核和过账”，刷新来源列表和凭证列表；遇到已转换冲突时显示服务端返回的来源凭证摘要；账套切换使用 key={book.id} 隔离组件实例。
- [ ] **步骤 5：运行前端检查。** 在 web/ 执行 ./node_modules/.bin/vitest run lib/financeProjectExpense.dom.vitest.test.tsx、./node_modules/.bin/tsc --noEmit --target es2018 --incremental false 与 npm run build（顺序执行，避免 Next.js 重建 .next/types 时造成类型检查竞争）。
- [ ] **步骤 6：提交前端改动。** 使用中文提交标题：财务：增加项目支出入账工作台。

### Task 4：整体验收与提交 PR

**文件：**

- 更新：docs/superpowers/specs/2026-09-24-finance-project-expense-voucher-design.md 中如实现差异导致的契约说明
- 更新：本实施计划复选框

- [ ] **步骤 1：跑 API 定向测试和迁移临时 schema 升降级。** 使用前述命令；不得对用户开发库或共享环境做迁移。
- [ ] **步骤 2：运行 TypeScript 检查、前端生产构建、git diff --check。** 阅读完整命令输出并记录已有的非本次 lint 警告。
- [ ] **步骤 3：复核权限与账务安全项。** 逐项检查当前账套头、项目可见性、财务角色、金额单一来源、辅助核算账套归属、并发防重、草稿状态、审计和源关联。
- [ ] **步骤 4：用中文提交剩余文档，并推送分支。** 分支名为 codex/finance-project-cost-voucher；所有提交标题使用中文。
- [ ] **步骤 5：创建中文 PR。** 标题“财务：支持项目支出可追溯转入凭证”；正文使用中文分节标题，注明 API、数据约束、验证结果及未执行的验证。
- [ ] **步骤 6：PR 创建后附加到当前任务，并确认 PR 可查看。** 本计划不授权自动合并新 PR。
