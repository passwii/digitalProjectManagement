# Stage 0 DDL 设计（冻结版，P0-A/B/C 建表以此为准）

> 约定：PostgreSQL；金额一律 `NUMERIC(18,2)`；时间列沿用全库约定
> （`timestamp without time zone` 存 Asia/Shanghai naive 墙钟，走 `app_now()`）；
> 表名复数小写；所有财务业务表携带 `account_book_id`。

## 1. 账套与期间

```sql
CREATE TABLE account_books (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(32)  NOT NULL UNIQUE,          -- 如 AB-2026-001
  name          VARCHAR(128) NOT NULL,
  base_currency CHAR(3)      NOT NULL DEFAULT 'CNY',  -- 产品范围仅人民币 CNY
  currencies    JSONB        NOT NULL DEFAULT '["CNY"]', -- 既有字段保留兼容，不启用多币种
  fiscal_year_start CHAR(5)  NOT NULL DEFAULT '01-01', -- 会计年度起始（月-日）
  status        VARCHAR(16)  NOT NULL DEFAULT 'active', -- active/archived
  created_by    INTEGER      REFERENCES users(id),
  created_at    TIMESTAMP    NOT NULL DEFAULT now(),
  CONSTRAINT ck_book_status CHECK (status IN ('active','archived')),
  CONSTRAINT ck_book_currency CHECK (base_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE accounting_periods (
  id            SERIAL PRIMARY KEY,
  account_book_id INTEGER NOT NULL REFERENCES account_books(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  month         SMALLINT NOT NULL,                     -- 1..12，调整期记 13
  period_index  INTEGER NOT NULL,                      -- year*100+month，全局连续
  is_adjustment BOOLEAN NOT NULL DEFAULT FALSE,        -- 调整期（13 期）
  status        VARCHAR(16) NOT NULL DEFAULT 'open',   -- open/closed/locked
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  closed_by     INTEGER REFERENCES users(id),
  closed_at     TIMESTAMP,
  version       INTEGER NOT NULL DEFAULT 1,            -- 结账乐观锁
  UNIQUE (account_book_id, year, month),
  UNIQUE (account_book_id, period_index),
  CONSTRAINT ck_period_month CHECK (month BETWEEN 1 AND 13),
  CONSTRAINT ck_period_adj CHECK ((month = 13) = is_adjustment),
  CONSTRAINT ck_period_range CHECK (start_date <= end_date),
  CONSTRAINT ck_period_status CHECK (status IN ('open','closed','locked'))
);
CREATE INDEX ix_periods_book_status ON accounting_periods(account_book_id, status);
```

期间规则：自然月建账，允许跨年连续建账（`period_index` 自增不断）；
调整期仅用于审计调整，须主管审批且不得自动结转下期；`closed` 只读，
`locked` 为年结后锁定，反结账必须**倒序**（后一期间为 open 才可反结前一期间）。

## 2. 科目体系（2022 版准则，4-2-2）

```sql
CREATE TABLE accounts (
  id            SERIAL PRIMARY KEY,
  account_book_id INTEGER NOT NULL REFERENCES account_books(id) ON DELETE CASCADE,
  code          VARCHAR(32) NOT NULL,                  -- 4-2-2：1002/100201/10020101
  name          VARCHAR(128) NOT NULL,
  level         SMALLINT NOT NULL,                     -- 1..4
  parent_id     INTEGER REFERENCES accounts(id),
  direction     CHAR(1) NOT NULL,                      -- D 借 / C 贷
  category      VARCHAR(16) NOT NULL,                  -- 资产/负债/权益/成本/损益
  aux_flags     JSONB NOT NULL DEFAULT '{}',           -- {customer:bool,vendor:bool,dept:bool,employee:bool,project:bool,cashflow:bool}
  is_leaf       BOOLEAN NOT NULL DEFAULT TRUE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (account_book_id, code),
  CONSTRAINT ck_acct_level CHECK (level BETWEEN 1 AND 4),
  CONSTRAINT ck_acct_dir CHECK (direction IN ('D','C')),
  CONSTRAINT ck_acct_cat CHECK (category IN ('资产','负债','权益','成本','损益')),
  CONSTRAINT ck_acct_code CHECK (code ~ '^[0-9]{4}([0-9]{2}){0,3}$')
);
CREATE INDEX ix_accounts_book_parent ON accounts(account_book_id, parent_id);
```

约束（应用层 + DB 触发器/检查双保险，P0-A 落地）：

1. 编码层级：子科目 `code` 必须以前级 `code` 为前缀且长度 = 父长度 + 2。
2. 只允许**末级（`is_leaf`）**科目记账；有发生额/余额的科目不得新增下级。
3. 停用（`is_active=false`）前置：无子科目、本期零发生、期末零余额。
4. 方向：资产/成本/费用类为借，负债/权益/收入类为贷（应用层按准则模板校验）。

预置科目：一级全量 + 二级全量 + 常用三级（现金/银行明细、应收应付明细、
固定资产折旧、税费明细等），以签字版科目表为准，P0-A 以 seed 导入。

## 3. 期初余额

```sql
CREATE TABLE opening_balances (
  id            SERIAL PRIMARY KEY,
  account_book_id INTEGER NOT NULL REFERENCES account_books(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  aux_key       VARCHAR(128) NOT NULL DEFAULT '',      -- 辅助维度哈希，无辅助为空串
  aux_detail    JSONB NOT NULL DEFAULT '{}',
  debit         NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit        NUMERIC(18,2) NOT NULL DEFAULT 0,
  UNIQUE (account_book_id, account_id, aux_key),
  CONSTRAINT ck_open_nonneg CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT ck_open_one_side CHECK (NOT (debit > 0 AND credit > 0))
);
```

期初录入必须**全账套借贷平衡**（`SUM(debit)=SUM(credit)`），否则不允许启用首个期间。

## 4. 凭证与分录（P0-B 建表，DDL 在此冻结）

```sql
CREATE TABLE vouchers (
  id            SERIAL PRIMARY KEY,
  account_book_id INTEGER NOT NULL REFERENCES account_books(id) ON DELETE CASCADE,
  period_id     INTEGER NOT NULL REFERENCES accounting_periods(id),
  voucher_no    VARCHAR(32) NOT NULL,                  -- 期间内凭证号，如 记-0001
  voucher_date  DATE NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'draft',  -- draft/pending/posted/void
  source        VARCHAR(16) NOT NULL DEFAULT 'manual', -- manual/template/import/auto
  summary       VARCHAR(255) NOT NULL DEFAULT '',
  total_debit   NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_credit  NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  reviewed_by   INTEGER REFERENCES users(id),
  posted_by     INTEGER REFERENCES users(id),
  voided_by     INTEGER REFERENCES users(id),
  reversal_of   INTEGER REFERENCES vouchers(id),       -- 红字冲销指向原凭证
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (account_book_id, period_id, voucher_no),
  CONSTRAINT ck_v_status CHECK (status IN ('draft','pending','posted','void')),
  CONSTRAINT ck_v_balanced CHECK (total_debit = total_credit),
  CONSTRAINT ck_v_reviewer CHECK (reviewed_by IS NULL OR reviewed_by <> created_by)
);

CREATE TABLE voucher_entries (
  id            SERIAL PRIMARY KEY,
  voucher_id    INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no       SMALLINT NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  summary       VARCHAR(255) NOT NULL DEFAULT '',
  debit         NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit        NUMERIC(18,2) NOT NULL DEFAULT 0,
  aux_detail    JSONB NOT NULL DEFAULT '{}',           -- {customer_id,vendor_id,dept_id,employee_id,project_id}
  cashflow_item_id INTEGER,                            -- 见 §6，现金类科目必填
  UNIQUE (voucher_id, line_no),
  CONSTRAINT ck_e_nonneg CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT ck_e_one_side CHECK ((debit > 0) <> (credit > 0)) -- 借贷必居其一
);

CREATE TABLE voucher_templates (
  id            SERIAL PRIMARY KEY,
  account_book_id INTEGER NOT NULL REFERENCES account_books(id) ON DELETE CASCADE,
  code          VARCHAR(32) NOT NULL,
  name          VARCHAR(128) NOT NULL,
  lines         JSONB NOT NULL DEFAULT '[]',           -- 分录模板行（科目+借贷方向+取数公式）
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (account_book_id, code)
);
```

凭证规则（详见 `02`）：不平不可保存；跨期/停用科目不可录入；
`posted` 不可 UPDATE/DELETE，只能红字冲销；`total_*` 由分录行汇总回写，
应用层与 DB CHECK 双重保证借贷平衡。

## 5. 余额表（P0-C 建表，过账同事务更新）

```sql
CREATE TABLE account_balances (
  id            SERIAL PRIMARY KEY,
  account_book_id INTEGER NOT NULL REFERENCES account_books(id) ON DELETE CASCADE,
  period_id     INTEGER NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  aux_key       VARCHAR(128) NOT NULL DEFAULT '',
  opening_debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  opening_credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  debit_total   NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_total  NUMERIC(18,2) NOT NULL DEFAULT 0,
  ending_debit  NUMERIC(18,2) NOT NULL DEFAULT 0,
  ending_credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  UNIQUE (account_book_id, period_id, account_id, aux_key),
  CONSTRAINT ck_b_nonneg CHECK (debit_total >= 0 AND credit_total >= 0)
);
```

过账流程：锁期间行（`SELECT … FOR UPDATE` + `version` 乐观锁）→ 插入分录 →
更新本期 `account_balances` → 回写 `vouchers.total_*` → 提交；**同一事务**。

## 6. 现金流项目

```sql
CREATE TABLE cashflow_items (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(32) NOT NULL UNIQUE,           -- 如 C01 销售商品收到现金
  name          VARCHAR(128) NOT NULL,
  category      VARCHAR(16) NOT NULL,                  -- 经营/投资/筹资
  direction     VARCHAR(8)  NOT NULL,                  -- 流入/流出
  rule          JSONB NOT NULL DEFAULT '{}',           -- 取数规则：{accounts:[], directions:[]}
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT ck_cf_cat CHECK (category IN ('经营','投资','筹资')),
  CONSTRAINT ck_cf_dir CHECK (direction IN ('流入','流出'))
);
```

现金流量表取数口径见 `05`；现金流项目为**全账套共享基础资料**（不分账套）。

## 7. 税务政策参数（版本化，结构冻结、数值待签字）

```sql
CREATE TABLE tax_policies (
  id            SERIAL PRIMARY KEY,
  tax_type      VARCHAR(32) NOT NULL,                  -- 增值税/企业所得税/个税/附加税费
  version       VARCHAR(32) NOT NULL,                  -- 如 VAT-2026-01
  effective_from DATE NOT NULL,
  effective_to  DATE,                                  -- NULL = 现行有效
  params        JSONB NOT NULL DEFAULT '{}',           -- 税率/扣除标准/级距
  status        VARCHAR(16) NOT NULL DEFAULT 'draft',  -- draft/effective/archived
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TIMESTAMP,
  UNIQUE (tax_type, version),
  CONSTRAINT ck_tax_status CHECK (status IN ('draft','effective','archived'))
);
```

版本化规则见 `06`：同税种日期重叠的 `effective` 版唯一（排除约束/应用层保证）；
`archived` 历史版不可 UPDATE/DELETE。

## 8. 迁移与可重复执行要求（验收项）

1. P0-A/B/C 迁移脚本遵循 AGENTS.md Alembic 约定：`alembic revision --rev-id <下一序号>`，
   单 head，`check_alembic.py` 全绿。
2. 迁移在空库可重复执行：`upgrade → downgrade → upgrade` 后表结构与约束一致。
3. 预置科目、现金流项目、税率占位参数以 seed 导入，seed 幂等（按 code/version 去重）。
