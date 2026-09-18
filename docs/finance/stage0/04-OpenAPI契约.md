# OpenAPI 契约（冻结版，P0 按此实现；后端先发布，前端对照开发）

Base path: `/api/v1/finance`；所有请求头携带 `X-Account-Book: <账套code>`；
金额一律字符串形式的 Decimal（`"1234.56"`），禁止浮点。

## 1. 账套 / 期间 / 科目 / 期初（P0-A）

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| POST / GET | `/books` / `/books/{id}` | 创建 / 查询账套（创建后自动建 12 个自然月期间 + 预置科目 seed） |
| GET / PATCH | `/periods?book=…` / `/periods/{id}/close` `/reopen` | 期间列表 / 结账 / 反结账（倒序校验） |
| GET / POST | `/accounts/tree?book=…` `/accounts` | 科目树 / 新增末级科目 |
| PATCH | `/accounts/{id}`（`active`） | 停用/启用（前置检查） |
| POST / GET | `/opening-balances` `/opening-balances/check` | 期初录入 / 借贷平衡检查 |

## 2. 凭证（P0-B）

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| POST / GET | `/vouchers`（`?status=&period=`） | 录入（draft）/ 列表查询 |
| GET / PATCH / DELETE | `/vouchers/{id}` | 详情 / 编辑（仅 draft）/ 删除（仅 draft） |
| POST | `/vouchers/{id}/submit` `/approve` `/post` `/reject` `/void` `/reverse` | 提交/审核/过账/驳回/作废/红字冲销 |
| POST | `/vouchers/import` | Excel 导入（错误定位到行，整体回滚） |
| GET | `/vouchers/gaps?period=` | 断号检测 |
| GET / POST | `/voucher-templates` `/vouchers/from-template` | 模板维护 / 按模板生成 |

## 3. 账簿 / 报表 / 结账（P0-C）

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| GET | `/ledger/general` `/ledger/detail` `/ledger/cash-daybook` `/balances` | 总账/明细账/日记账/余额表 |
| GET | `/reports/balance-sheet` `/reports/income` `/reports/cashflow` | 三大报表（`?period=`，多期 `?from=&to=`） |
| POST | `/close/check` `/close/run` `/close/reverse` | 结账检查（逐条阻断原因）/ 执行 / 反结账 |

## 4. 通用模型（摘录）

```yaml
Voucher:
  id: int; book: string; period: string  # YYYY-MM
  no: string                             # 记-0001
  date: date; status: draft|pending|posted|void
  lines: [{ line_no, account, summary, debit: string, credit: string, aux: {...}, cashflow: code|null }]
  totals: { debit: string, credit: string }
Error:
  code: string; message: string; details: [{ field, reason }]
```

## 5. 错误码（冻结）

| code | 含义 |
| ------ | ------ |
| `F-UNBALANCED` | 凭证借贷不平 |
| `F-PERIOD-CLOSED` | 期间已关/锁定 |
| `F-ACCT-INACTIVE` | 科目停用或非末级 |
| `F-DUP-VOUCHER-NO` | 凭证号重复 |
| `F-VOUCHER-GAP` | 断号未说明 |
| `F-SOD` | 不相容岗位（制单=审核等） |
| `F-NO-BOOK-ACCESS` | 无账套权限 |
| `F-CLOSE-BLOCKED` | 结账前置检查未通过（details 逐条） |
| `F-TAX-DIFF` | 账表差异超阈（1 元） |
| `F-REVERSE-ORDER` | 反结账非倒序 |
