# 应收应付手工指定与拆分核销实施计划

> **面向执行代理：** 本计划由当前任务内联执行。每项按测试先行、小步验证；无须新增数据库迁移。

**目标：** 在现有应收收款/应付付款流程中支持指定一张或多张工作台往来单据核销，并保持 FIFO 为默认兼容行为。

**架构：** 扩展现有 `ARAPPaymentIn`，通过可选 `allocations` 明细表达用户指定的目标和金额；服务端在锁定目标往来行后执行账套、类别、主体、科目、状态、日期和余额校验。前端收付款弹窗复用当前台账数据，增加 FIFO/指定单据切换和金额分配明细；沿用 `ARAPAllocation` 与现有凭证释放生命周期。

**技术栈：** FastAPI、Pydantic、SQLAlchemy、PostgreSQL、pytest、Next.js、React、TypeScript、Vitest。

## 全局约束

- 所有请求沿用 `X-Account-Book`；账务金额以 CNY 两位小数十进制字符串提交和展示。
- `allocations` 缺省时保持既有 FIFO 行为；传入时必须指定至少一条，明细总额必须等于收付款总额。
- 目标必须是同一账套、同类往来、同主体、同往来科目的已过账单据；凭证日期不得晚于收付款日期，原单不得冲销中或已冲销。
- 多目标按 `(transaction_date, id)` 顺序锁定；后端校验是最终边界，前端校验只改善操作反馈。
- 不支持预收预付、超额收付、未分配余额、跨主体/科目核销、普通凭证核销或期初辅助余额导入。
- 不新增数据库迁移；成功时仍即时占用核销额并创建待审核收付款草稿凭证。

---

### Task 1：先写手工核销 API 回归测试

**文件：** `tests/test_finance_vouchers.py`

**测试数据准备：** 复用文件中的 `_auth`、`_book`、`_scoped`、`_accounts`。在测试内建账、创建同一客户的两张应收单（分别 60.00 和 40.00），逐张提交、审核、过账；再创建另一客户的一张应收单，留作越权目标。所有单据使用同一应收科目。

- [x] 新增拆分测试：收款 50.00，手工指定首张 20.00、第二张 30.00；断言响应分配 ID/金额准确，三张单据余额分别为 40.00、10.00、100.00。
- [x] 新增应付测试：创建并过账同供应商的两张应付单，付款请求只指定第二张；断言第一张未变化、第二张余额按指定金额减少。
- [x] 新增无副作用校验测试：分别传入重复目标、总额不相等、超额分配、另一主体的目标；每次断言 400 结构化错误，`/finance/vouchers` 数量不变，所有 `applied_amount` 不变。
- [x] 增加资格边界：草稿目标、凭证日期晚于收付款日期、正在冲销和已冲销目标均不能指定。
- [x] 在隔离临时 PostgreSQL 上运行新增测试，确认其因服务端忽略/不支持 `allocations` 而失败，再实现 API。

**请求契约样例：**

```python
body = {
    "period_id": period["id"],
    "transaction_date": period["start_date"],
    "customer_id": customer["id"],
    "amount": "50.00",
    "cash_account_id": accounts["10020101"]["id"],
    "account_id": accounts["11220101"]["id"],
    "cashflow_item": "C01",
    "summary": "按单据指定收款",
    "allocations": [
        {"target_id": first_receivable_id, "amount": "20.00"},
        {"target_id": second_receivable_id, "amount": "30.00"},
    ],
}
```

### Task 2：实现后端指定分配与服务端校验

**文件：** `api/routers/finance_accounting.py`、`tests/test_finance_vouchers.py`

- [x] 增加请求类型并让旧请求默认保持 FIFO：

```python
class ARAPAllocationIn(BaseModel):
    target_id: int = Field(gt=0)
    amount: Decimal


class ARAPPaymentIn(BaseModel):
    period_id: int
    transaction_date: date
    party_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    amount: Decimal
    cash_account_id: int
    account_id: int | None = None
    cashflow_item: str | None = None
    summary: str = Field(default="", max_length=255)
    allocations: list[ARAPAllocationIn] | None = None
```

- [x] 在 `_apply_arap_payment` 中先拒绝空明细和重复 ID；候选查询按现有账套、类别、主体、科目、已过账和凭证日期条件筛选，手工模式再限定目标 ID，并以 `(transaction_date, id)` 顺序只锁定 `ARAPTransaction` 行。
- [x] 锁定后复查非作废冲销凭证；手工目标必须全部存在于当前合格候选集合。每笔金额用 `_money` 归一并要求大于零；每笔不超过当前未核销额；明细和必须等于收付款金额。
- [x] FIFO 模式继续执行原日期顺序分配。手工模式将校验后的目标/金额转换为现有 `(target, amount)` 列表，再复用凭证创建、`applied_amount` 更新、`ARAPAllocation` 写入和审计路径。
- [x] 所有业务拒绝发生在创建凭证或修改目标余额之前，并使用结构化错误码；无效目标统一提示“目标单据不符合当前核销条件”，不泄露其他账套或主体数据。
- [x] 在隔离 PostgreSQL 上重跑任务一新增测试，确认全部通过；重跑既有 FIFO、冲销释放、并发锁、账龄和对账用例。

- [ ] 等待确认旧 API 在未传 `account_id` 时是否仍允许跨科目 FIFO；按确认结果更新契约、实现和回归。

### Task 3：增加 FIFO/指定单据前端操作

**文件：** `web/lib/api.ts`、`web/app/(dashboard)/finance/ArapPanel.tsx`、`web/app/(dashboard)/finance/ArapDialogs.tsx`、`web/lib/financeArap.dom.vitest.test.tsx`

- [x] 将可选明细加入 TypeScript 请求类型：

```ts
export interface FinanceARAPPaymentInput {
  period_id: number;
  transaction_date: string;
  amount: string;
  cash_account_id: number;
  account_id: number;
  cashflow_item?: string;
  summary: string;
  customer_id?: number;
  vendor_id?: number;
  allocations?: Array<{ target_id: number; amount: string }>;
}
```

- [x] 从 `ArapPanel` 将当前应收或应付明细传给 `ArapSettlementDialog`；对话框按主体、往来科目、凭证日期、`voucher_status === "posted"`、`is_reversing === false`、`is_reversed === false` 和正余额筛选目标。
- [x] 对话框默认“按单据日期先进先出”；切换到“指定单据”后显示凭证号、日期、摘要、剩余额、本次核销额输入和合计/差额。
- [x] 指定模式只提交正金额行；总额不等、超单据余额、无目标或无剩余额度时禁用提交并给出中文原因。交易日期变化时重新过滤候选并清除已输入的目标金额。
- [x] 成功时沿用现有成功提示和刷新流程；错误时保留用户输入并展示后端错误。FIFO 模式不发送 `allocations` 字段。
- [x] 在 DOM 测试中覆盖默认 FIFO、手工候选过滤、拆分合计和 API payload；运行新增 DOM 测试确认 RED，再实现并确认 GREEN。

### Task 4：最终验证、复审与 PR

- [x] 在隔离临时 PostgreSQL 上运行 `tests/test_finance_vouchers.py`、`tests/test_finance_project_expense_voucher.py`、`tests/test_finance_p0a_review.py`。
- [x] 在 `web` 运行 `npm test` 和 `npm run build`；运行 `git diff --check`。
- [x] 对照设计逐项复核旧 FIFO 兼容、手工金额守恒、主体/科目/日期/状态隔离、目标锁顺序、失败无副作用和 CNY 口径。
- [x] 完成只读独立复审并修复确定性问题；创建中文草稿 PR，待用户确认跨科目 FIFO 兼容口径后再关闭阻断项。


## 待用户确认：旧 API 跨科目 FIFO 兼容

旧调用省略 `allocations` 且不传 `account_id` 时，原 FIFO 可能把一个收付款金额分配到多个往来科目；现有凭证生成路径仅使用一个对方科目。当前实现限制该次收付款在一个科目内，保证核销台账与凭证科目一致，但这会改变上述旧调用的行为。

- 推荐：一次收付款只核销一个往来科目；跨科目分别登记。
- 兼容：保留跨科目 FIFO，并扩展凭证生成与测试，使一张收付款凭证含多条不同往来科目的分录。

用户选择后，更新设计/本计划和跨科目回归；选择“兼容”时实现多科目凭证分录。当前暂定行为会在草稿 PR 中标为阻断，不请求合并。
