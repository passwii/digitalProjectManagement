# 财务往来工作台实施计划

> **面向执行代理：** 按本计划逐项推进；步骤使用复选框跟踪。此阶段由当前任务直接执行。

**目标：** 在财务工作台接入现有应收、应付、FIFO 收付款核销和应付账龄 API。

**架构：** API 类型与调用留在 `web/lib/api.ts`；新的往来面板与对话框放在财务路由目录中；主财务页面只负责账套/期间/权限上下文和页签挂载。继续使用账套辅助资料作为客户、供应商与现金流项目主数据，不新增服务端路由或迁移。

**技术栈：** Next.js 14、React 18、TypeScript、现有 `useAsyncData`、财务 API 封装、通用 Dialog/Toast/PageState 组件。

## 全局约束

- 所有财务读写均传递 `X-Account-Book`，金额提交为十进制字符串。
- 当前开放期间是新单据和收付款凭证的期间；不存在开放期间时禁用写操作。
- 往来主体从当前账套 `auxiliary-items` 的 customer/vendor 类型中选择；只显示有效记录。
- 应收科目要求 customer 辅助核算，应付科目要求 vendor 辅助核算；付款/收款使用启用现金流核算的末级现金科目与现金流项目编码。
- 收款/付款写入 FIFO 分配并生成草稿凭证；界面说明余额立即被占用、凭证仍待审核/过账。
- 往来列表返回 `account_id`；收付款可选传入 `account_id` 限定 FIFO 科目范围，旧调用不传时保留原行为。
- 不提供收付款撤销，不把项目客户或友商实体拼接为财务主体。
- 不新增或运行测试；完成代码后只做静态检查和差异审阅。

---

### 任务一：补齐财务往来 API 类型与调用

**文件：**

- 修改：`web/lib/api.ts`

**接口：**

- 新增辅助资料、往来记录、账龄汇总和创建表单的 TypeScript 类型。
- `financeApi` 增加读写 `auxiliary-items`、`receivables`、`payables`、`receivable-collections`、`payable-payments`、`payables/aging` 的方法，均复用现有 scoped request helper。
- 请求契约：

```ts
interface FinanceAuxiliaryItem {
  id: number;
  kind: "customer" | "vendor" | "cashflow";
  code: string;
  name: string;
  metadata: Record<string, unknown>;
  is_active: boolean;
}

interface FinanceARAPItem {
  id: number;
  period_id: number;
  transaction_date: string;
  party_id: number;
  account_id: number;
  amount: string;
  applied_amount: string;
  outstanding: string;
  summary: string;
  voucher_id: number | null;
  voucher_no: string | null;
}

interface FinanceARAPAging {
  as_of: string;
  total_outstanding: string;
  buckets: { "0_30": string; "31_60": string; "61_90": string; "90_plus": string };
}
```

- [x] 增加与后端 JSON 一致的类型，金额均为字符串，主体 ID 与科目 ID 为数字。
- [x] 实现辅助资料 list/create，并使用 `{kind}` 查询参数。
- [x] 实现应收/应付 list/create、收款/付款及以 `as_of` 为参数的应付账龄读取。
- [x] 对照 `api/routers/finance.py` 与 `api/routers/finance_accounting.py` 的字段名审阅每个 payload。

具体路由和主体字段：

```text
GET  /finance/auxiliary-items?kind=customer|vendor|cashflow
POST /finance/auxiliary-items                          { kind, code, name, metadata }
GET  /finance/receivables                              -> { total, items }
POST /finance/receivables                              { period_id, transaction_date, customer_id, amount, receivable_account_id, revenue_account_id, summary }
GET  /finance/payables                                 -> { total, items }
POST /finance/payables                                 { period_id, transaction_date, vendor_id, amount, payable_account_id, expense_account_id, summary }
POST /finance/receivable-collections                   { period_id, transaction_date, customer_id, amount, cash_account_id, account_id?, cashflow_item, summary }
POST /finance/payable-payments                         { period_id, transaction_date, vendor_id, amount, cash_account_id, account_id?, cashflow_item, summary }
GET  /finance/payables/aging?as_of=YYYY-MM-DD          -> FinanceARAPAging
```

### 任务二：建立往来面板与工作台上下文

**文件：**

- 创建：`web/app/(dashboard)/finance/ArapPanel.tsx`
- 修改：`web/app/(dashboard)/finance/page.tsx`

**接口：**

- 面板接收当前账套编码、当前开放期间、科目树和管理员状态。
- 面板独立加载两类往来、辅助资料和账龄；完成写入后刷新这些数据。
- 列表数据的主体字段按当前类别的辅助资料 ID 映射，显示往来科目和凭证编号；金额保持十进制字符串，汇总只用于展示。

- [x] 新增“应收应付”页签并把科目树加载条件扩展到该页签。
- [x] 挂载 `ArapPanel`，传入账套编码、`currentPeriod`、账户科目和 `isAdmin`。
- [x] 仅在应收应付页签挂载面板；面板数据用 `useAsyncData` 按账套加载，切换账套时重置。
- [x] 实现应收/应付切换、主体名称映射、主体/科目搜索、空状态、重试和财务摘要。
- [x] 应付分区显示可改截止日的四档账龄；不为应收伪造账龄数据。
- [x] 禁用无开放期间时的新建与收付款操作；切换账套时重置面板数据。

### 任务三：完成应收应付与 FIFO 收付款表单

**文件：**

- 创建：`web/app/(dashboard)/finance/ArapDialogs.tsx`
- 修改：`web/app/(dashboard)/finance/ArapPanel.tsx`

**接口：**

- 往来单创建表单按类型提交正确的主体字段与科目字段。
- 收付款表单绑定表格所选主体与往来科目；该范围内的 FIFO 分配完全由后端完成。
- 往来单创建载荷分别使用 `customer_id + receivable_account_id + revenue_account_id` 和 `vendor_id + payable_account_id + expense_account_id`。
- 核销载荷分别使用 `customer_id` 与 `vendor_id`，现金科目通过 `cash_account_id` 提交，并传入选中的往来科目 `account_id`。

- [x] 创建应收、应付 Dialog：选择客户/供应商、往来科目、对方科目、交易日期、正数金额和摘要。
- [x] 应收 POST body 形状为 `{ period_id, transaction_date, customer_id, amount, receivable_account_id, revenue_account_id, summary }`；应付将主体与科目字段替换为 `vendor_id`, `payable_account_id`, `expense_account_id`。
- [x] 只提供启用末级科目；筛掉会要求表单未提供辅助维度的对方科目。
- [x] 创建管理员可用的客户/供应商/现金流辅助资料 Dialog；提交后刷新辅助资料列表。
- [x] 创建收款、付款 Dialog：列出该主体与往来科目范围内的未核销余额，选择期间日期、现金科目、现金流项目、金额和摘要。
- [x] 收款 POST body 形状为 `{ period_id, transaction_date, customer_id, amount, cash_account_id, account_id, cashflow_item, summary }`；付款使用 `vendor_id`。
- [x] 禁止金额超过该主体与往来科目的剩余余额；服务端拒绝时保留表单并显示原始业务错误。
- [x] 成功后显示关联凭证编号及“待审核/过账，核销额度已占用”提示，并刷新列表和账龄。
- [x] 不显示撤销/冲回动作；说明该能力不在当前后端 API 契约中。

### 任务四：静态审阅与交付

**文件：**

- 审阅：`web/lib/api.ts`
- 审阅：`web/app/(dashboard)/finance/page.tsx`
- 审阅：`web/app/(dashboard)/finance/ArapPanel.tsx`
- 审阅：`web/app/(dashboard)/finance/ArapDialogs.tsx`

- [x] 执行 TypeScript 静态检查、API Python 语法编译与前端生产构建，不运行测试套件。
- [x] 检查差异、权限条件、金额字符串、账套隔离头、表单禁用条件与空/失败状态。
- [x] 确认用户界面没有把应收账龄、手工核销或收付款撤回描述为已支持。
- [x] 用中文提交标题提交设计、计划和实现成果，并向用户汇报生产只读核实结果与尚存后端限制。
