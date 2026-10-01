"""全表模型。

时间列约定（BLF-1138）：所有 `DateTime` 列是 `timestamp without time zone`，存
**`Asia/Shanghai` 的 naive 墙钟值**。统一走 `core/timeutil.py` 的 `app_now()`，
不要在这里写 `datetime.now(timezone.utc)` —— 那会被 PG 按会话时区二次折算。
"""

from datetime import datetime

from sqlalchemy import (
  JSON,
  Boolean,
  CheckConstraint,
  Column,
  Date,
  DateTime,
  Float,
  ForeignKey,
  ForeignKeyConstraint,
  Index,
  Integer,
  func,
  Numeric,
  String,
  Text,
  UniqueConstraint,
)
from sqlalchemy.orm import relationship

from ..core.database import Base
from ..core.timeutil import app_now


def _now() -> datetime:
  """DateTime 列的默认值：北京时间 naive 墙钟（见 core/timeutil.py）。"""
  return app_now()


class AccountBook(Base):
  """财务账套：独立于项目管理中的 Project。"""

  __tablename__ = "account_books"
  id = Column(Integer, primary_key=True)
  code = Column(String(32), unique=True, nullable=False, index=True)
  name = Column(String(128), nullable=False)
  base_currency = Column(String(3), nullable=False, default="CNY", server_default="CNY")
  currencies = Column(
    JSON, nullable=False, default=lambda: ["CNY"], server_default='["CNY"]'
  )
  fiscal_year_start = Column(
    String(5), nullable=False, default="01-01", server_default="01-01"
  )
  status = Column(String(16), nullable=False, default="active", server_default="active")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  deleted_at = Column(DateTime, nullable=True, index=True)
  deleted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  __table_args__ = (
    CheckConstraint("status IN ('active','archived')", name="ck_book_status"),
    CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="ck_book_currency"),
  )


class AccountBookMember(Base):
  """账套授权；管理员由应用层视为全局可访问。"""

  __tablename__ = "account_book_members"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False
  )
  user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
  role = Column(String(32), nullable=False, default="member", server_default="member")
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "user_id", name="uq_book_member"),
    Index("ix_book_members_user", "user_id"),
  )


class AccountingPeriod(Base):
  __tablename__ = "accounting_periods"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer,
    ForeignKey("account_books.id", ondelete="CASCADE"),
    nullable=False,
    index=True,
  )
  year = Column(Integer, nullable=False)
  month = Column(Integer, nullable=False)
  period_index = Column(Integer, nullable=False)
  is_adjustment = Column(Boolean, nullable=False, default=False, server_default="false")
  status = Column(String(16), nullable=False, default="open", server_default="open")
  start_date = Column(Date, nullable=False)
  end_date = Column(Date, nullable=False)
  closed_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  closed_at = Column(DateTime, nullable=True)
  version = Column(Integer, nullable=False, default=1, server_default="1")
  __table_args__ = (
    UniqueConstraint("account_book_id", "id", name="uq_period_book_id"),
    UniqueConstraint(
      "account_book_id", "year", "month", name="uq_period_book_year_month"
    ),
    UniqueConstraint("account_book_id", "period_index", name="uq_period_book_index"),
    CheckConstraint("month BETWEEN 1 AND 13", name="ck_period_month"),
    CheckConstraint("(month = 13) = is_adjustment", name="ck_period_adjustment"),
    CheckConstraint("start_date <= end_date", name="ck_period_range"),
    CheckConstraint("status IN ('open','closed','locked')", name="ck_period_status"),
    Index("ix_periods_book_status", "account_book_id", "status"),
  )


class Account(Base):
  __tablename__ = "accounts"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer,
    ForeignKey("account_books.id", ondelete="CASCADE"),
    nullable=False,
    index=True,
  )
  code = Column(String(32), nullable=False)
  name = Column(String(128), nullable=False)
  level = Column(Integer, nullable=False)
  parent_id = Column(Integer, nullable=True)
  direction = Column(String(1), nullable=False)
  category = Column(String(16), nullable=False)
  aux_flags = Column(JSON, nullable=False, default=dict, server_default="{}")
  subject_version = Column(String(16), nullable=False, default="2022", server_default="2022")
  is_leaf = Column(Boolean, nullable=False, default=True, server_default="true")
  is_active = Column(Boolean, nullable=False, default=True, server_default="true")
  __table_args__ = (
    UniqueConstraint("account_book_id", "id", name="uq_accounts_book_id"),
    UniqueConstraint("account_book_id", "code", name="uq_account_book_code"),
    ForeignKeyConstraint(
      ["account_book_id", "parent_id"],
      ["accounts.account_book_id", "accounts.id"],
      name="fk_accounts_parent_same_book",
    ),
    CheckConstraint("level BETWEEN 1 AND 4", name="ck_account_level"),
    CheckConstraint("direction IN ('D','C')", name="ck_account_direction"),
    CheckConstraint(
      "category IN ('资产','负债','权益','成本','损益')", name="ck_account_category"
    ),
    CheckConstraint("code ~ '^[0-9]{4}([0-9]{2}){0,3}$'", name="ck_account_code"),
    CheckConstraint("json_typeof(aux_flags) = 'object'", name="ck_account_aux_flags"),
    Index("ix_accounts_book_parent", "account_book_id", "parent_id"),
  )


class OpeningBalance(Base):
  __tablename__ = "opening_balances"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer,
    ForeignKey("account_books.id", ondelete="CASCADE"),
    nullable=False,
    index=True,
  )
  account_id = Column(Integer, nullable=False)
  aux_key = Column(String(128), nullable=False, default="", server_default="")
  aux_detail = Column(JSON, nullable=False, default=dict, server_default="{}")
  debit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  credit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  __table_args__ = (
    UniqueConstraint(
      "account_book_id", "account_id", "aux_key", name="uq_opening_book_account_aux"
    ),
    ForeignKeyConstraint(
      ["account_book_id", "account_id"],
      ["accounts.account_book_id", "accounts.id"],
      name="fk_opening_account_same_book",
    ),
    CheckConstraint("debit >= 0 AND credit >= 0", name="ck_opening_nonneg"),
    CheckConstraint("NOT (debit > 0 AND credit > 0)", name="ck_opening_one_side"),
  )


class AuxiliaryItem(Base):
  """账套内辅助核算主数据：客户、供应商、部门、员工、项目、现金流项目。"""

  __tablename__ = "auxiliary_items"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer,
    ForeignKey("account_books.id", ondelete="CASCADE"),
    nullable=False,
    index=True,
  )
  kind = Column(String(16), nullable=False)
  code = Column(String(64), nullable=False)
  name = Column(String(128), nullable=False)
  extra_data = Column(
    "metadata", JSON, nullable=False, default=dict, server_default="{}"
  )
  is_active = Column(Boolean, nullable=False, default=True, server_default="true")
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "kind", "code", name="uq_aux_book_kind_code"),
    # Required by the composite FK from account_auxiliaries.  PostgreSQL
    # requires the referenced column pair to be covered by a unique key.
    UniqueConstraint("account_book_id", "id", name="uq_auxiliary_items_book_id"),
    CheckConstraint(
      "kind IN ('customer','vendor','department','employee','project','cashflow')",
      name="ck_aux_kind",
    ),
  )


class AccountAuxiliary(Base):
  __tablename__ = "account_auxiliaries"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False
  )
  account_id = Column(Integer, nullable=False)
  auxiliary_item_id = Column(Integer, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "id", name="uq_account_auxiliaries_book_id"),
    ForeignKeyConstraint(
      ["account_book_id", "account_id"],
      ["accounts.account_book_id", "accounts.id"],
      name="fk_account_auxiliary_account_same_book",
      ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
      ["account_book_id", "auxiliary_item_id"],
      ["auxiliary_items.account_book_id", "auxiliary_items.id"],
      name="fk_account_auxiliary_item_same_book",
      ondelete="CASCADE",
    ),
    UniqueConstraint(
      "account_book_id",
      "account_id",
      "auxiliary_item_id",
      name="uq_account_auxiliary_link",
    ),
    Index("ix_account_auxiliary_book", "account_book_id"),
  )


class AccountBalance(Base):
  """Persisted period totals used by account deactivation guards."""

  __tablename__ = "account_balances"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(
    Integer,
    ForeignKey("account_books.id", ondelete="CASCADE"),
    nullable=False,
    index=True,
  )
  period_id = Column(Integer, nullable=False)
  account_id = Column(Integer, nullable=False)
  aux_key = Column(String(128), nullable=False, default="", server_default="")
  opening_debit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  opening_credit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  debit_total = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  credit_total = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  ending_debit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  ending_credit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  __table_args__ = (
    UniqueConstraint("account_book_id", "id", name="uq_account_balance_book_id"),
    UniqueConstraint(
      "account_book_id", "period_id", "account_id", "aux_key",
      name="uq_account_balance_scope",
    ),
    ForeignKeyConstraint(
      ["account_book_id", "period_id"],
      ["accounting_periods.account_book_id", "accounting_periods.id"],
      name="fk_account_balance_period_same_book",
      ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
      ["account_book_id", "account_id"],
      ["accounts.account_book_id", "accounts.id"],
      name="fk_account_balance_account_same_book",
      ondelete="CASCADE",
    ),
    CheckConstraint(
      "opening_debit >= 0 AND opening_credit >= 0 AND "
      "debit_total >= 0 AND credit_total >= 0 AND "
      "ending_debit >= 0 AND ending_credit >= 0",
      name="ck_account_balance_nonneg",
    ),
    Index("ix_account_balances_account", "account_book_id", "account_id"),
  )


class Voucher(Base):
  """财务凭证头：账簿、期间和状态是所有会计事实的边界。"""

  __tablename__ = "vouchers"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  period_id = Column(Integer, nullable=False)
  voucher_no = Column(String(32), nullable=False)
  voucher_date = Column(Date, nullable=False)
  status = Column(String(16), nullable=False, default="draft", server_default="draft", index=True)
  source = Column(String(16), nullable=False, default="manual", server_default="manual")
  source_expense_id = Column(
    Integer,
    ForeignKey(
      "expenses.id",
      name="fk_vouchers_source_expense_id_expenses",
      ondelete="RESTRICT",
    ),
    nullable=True,
  )
  summary = Column(String(255), nullable=False, default="", server_default="")
  total_debit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  total_credit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  reviewed_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  posted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  voided_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  reversal_of = Column(Integer, ForeignKey("vouchers.id"), nullable=True)
  decision_reason = Column(Text, nullable=False, default="", server_default="")
  created_at = Column(DateTime, default=_now, nullable=False)
  updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "period_id", "voucher_no", name="uq_voucher_book_period_no"),
    UniqueConstraint("account_book_id", "id", name="uq_voucher_book_id"),
    UniqueConstraint("source_expense_id", name="uq_vouchers_source_expense_id"),
    ForeignKeyConstraint(
      ["account_book_id", "period_id"],
      ["accounting_periods.account_book_id", "accounting_periods.id"],
      name="fk_voucher_period_same_book",
      ondelete="CASCADE",
    ),
    CheckConstraint("status IN ('draft','pending','posted','void')", name="ck_voucher_status"),
    CheckConstraint("total_debit >= 0 AND total_credit >= 0 AND total_debit = total_credit", name="ck_voucher_balanced"),
  )


class VoucherEntry(Base):
  """凭证分录：每行只能有借方或贷方，辅助核算保存在账套内 JSON 快照。"""

  __tablename__ = "voucher_entries"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, nullable=False)
  voucher_id = Column(Integer, ForeignKey("vouchers.id", ondelete="CASCADE"), nullable=False, index=True)
  line_no = Column(Integer, nullable=False)
  account_id = Column(Integer, nullable=False)
  summary = Column(String(255), nullable=False, default="", server_default="")
  debit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  credit = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  aux_detail = Column(JSON, nullable=False, default=dict, server_default="{}")
  cashflow_item = Column(String(32), nullable=True)
  __table_args__ = (
    UniqueConstraint("voucher_id", "line_no", name="uq_voucher_entry_line"),
    ForeignKeyConstraint(
      ["account_book_id", "voucher_id"],
      ["vouchers.account_book_id", "vouchers.id"],
      name="fk_voucher_entry_voucher_same_book",
      ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
      ["account_book_id", "account_id"],
      ["accounts.account_book_id", "accounts.id"],
      name="fk_voucher_entry_account_same_book",
    ),
    CheckConstraint("debit >= 0 AND credit >= 0", name="ck_voucher_entry_nonneg"),
    CheckConstraint("(debit > 0) <> (credit > 0)", name="ck_voucher_entry_one_side"),
  )


class VoucherTemplate(Base):
  __tablename__ = "voucher_templates"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  code = Column(String(32), nullable=False)
  name = Column(String(128), nullable=False)
  lines = Column(JSON, nullable=False, default=list, server_default="[]")
  is_active = Column(Boolean, nullable=False, default=True, server_default="true")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "code", name="uq_voucher_template_book_code"),
  )


class CashTransaction(Base):
  __tablename__ = "cash_transactions"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  period_id = Column(Integer, nullable=False)
  kind = Column(String(16), nullable=False)
  transaction_date = Column(Date, nullable=False)
  amount = Column(Numeric(18, 2), nullable=False)
  account_id = Column(Integer, nullable=False)
  offset_account_id = Column(Integer, nullable=False)
  summary = Column(String(255), nullable=False, default="", server_default="")
  counterparty = Column(String(128), nullable=False, default="", server_default="")
  cashflow_item = Column(String(32), nullable=True)
  status = Column(String(16), nullable=False, default="draft", server_default="draft")
  voucher_id = Column(Integer, ForeignKey("vouchers.id"), nullable=True)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    CheckConstraint("kind IN ('receipt','payment','expense')", name="ck_cash_transaction_kind"),
    CheckConstraint("amount > 0", name="ck_cash_transaction_amount"),
    ForeignKeyConstraint(["account_book_id", "period_id"], ["accounting_periods.account_book_id", "accounting_periods.id"], name="fk_cash_transaction_period_same_book"),
    ForeignKeyConstraint(["account_book_id", "account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_cash_transaction_account_same_book"),
    ForeignKeyConstraint(["account_book_id", "offset_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_cash_transaction_offset_same_book"),
  )


class BankStatement(Base):
  __tablename__ = "bank_statements"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  period_id = Column(Integer, nullable=False)
  external_id = Column(String(128), nullable=False)
  transaction_date = Column(Date, nullable=False)
  direction = Column(String(16), nullable=False)
  amount = Column(Numeric(18, 2), nullable=False)
  account_code = Column(String(32), nullable=False, default="", server_default="")
  summary = Column(String(255), nullable=False, default="", server_default="")
  counterparty = Column(String(128), nullable=False, default="", server_default="")
  status = Column(String(16), nullable=False, default="unmatched", server_default="unmatched")
  matched_voucher_id = Column(Integer, ForeignKey("vouchers.id"), nullable=True)
  matched_at = Column(DateTime, nullable=True)
  matched_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "external_id", name="uq_bank_statement_book_external"),
    CheckConstraint("direction IN ('inflow','outflow')", name="ck_bank_statement_direction"),
    CheckConstraint("amount > 0", name="ck_bank_statement_amount"),
    CheckConstraint("status IN ('unmatched','matched','ignored')", name="ck_bank_statement_status"),
  )


class FixedAsset(Base):
  __tablename__ = "fixed_assets"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  code = Column(String(64), nullable=False)
  name = Column(String(128), nullable=False)
  category = Column(String(64), nullable=False, default="")
  acquisition_date = Column(Date, nullable=False)
  original_cost = Column(Numeric(18, 2), nullable=False)
  residual_rate = Column(Numeric(8, 6), nullable=False, default=0, server_default="0")
  useful_life_months = Column(Integer, nullable=False)
  asset_account_id = Column(Integer, nullable=False)
  depreciation_account_id = Column(Integer, nullable=False)
  expense_account_id = Column(Integer, nullable=False)
  accumulated_depreciation = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  status = Column(String(16), nullable=False, default="active", server_default="active")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "code", name="uq_fixed_asset_book_code"),
    UniqueConstraint("account_book_id", "id", name="uq_fixed_asset_book_id"),
    CheckConstraint("original_cost > 0", name="ck_fixed_asset_cost"),
    CheckConstraint("residual_rate >= 0 AND residual_rate < 1", name="ck_fixed_asset_residual_rate"),
    CheckConstraint("useful_life_months > 0", name="ck_fixed_asset_life"),
    CheckConstraint("status IN ('active','disposed')", name="ck_fixed_asset_status"),
    ForeignKeyConstraint(["account_book_id", "asset_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_fixed_asset_asset_account"),
    ForeignKeyConstraint(["account_book_id", "depreciation_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_fixed_asset_depreciation_account"),
    ForeignKeyConstraint(["account_book_id", "expense_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_fixed_asset_expense_account"),
  )


class AssetDepreciation(Base):
  __tablename__ = "asset_depreciations"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  asset_id = Column(Integer, ForeignKey("fixed_assets.id", ondelete="CASCADE"), nullable=False)
  period_id = Column(Integer, nullable=False)
  amount = Column(Numeric(18, 2), nullable=False)
  voucher_id = Column(Integer, ForeignKey("vouchers.id"), nullable=True)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    UniqueConstraint("account_book_id", "asset_id", "period_id", name="uq_asset_depreciation_period"),
    ForeignKeyConstraint(["account_book_id", "asset_id"], ["fixed_assets.account_book_id", "fixed_assets.id"], name="fk_asset_depreciation_asset_same_book", ondelete="CASCADE"),
    ForeignKeyConstraint(["account_book_id", "period_id"], ["accounting_periods.account_book_id", "accounting_periods.id"], name="fk_asset_depreciation_period_same_book", ondelete="CASCADE"),
    CheckConstraint("amount > 0", name="ck_asset_depreciation_amount"),
  )


class ARAPTransaction(Base):
  __tablename__ = "arap_transactions"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  period_id = Column(Integer, nullable=False)
  kind = Column(String(16), nullable=False)
  transaction_date = Column(Date, nullable=False)
  party_id = Column(Integer, nullable=False)
  amount = Column(Numeric(18, 2), nullable=False)
  applied_amount = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
  account_id = Column(Integer, nullable=False)
  offset_account_id = Column(Integer, nullable=False)
  summary = Column(String(255), nullable=False, default="", server_default="")
  voucher_id = Column(Integer, ForeignKey("vouchers.id"), nullable=True)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (
    CheckConstraint("kind IN ('receivable','payable')", name="ck_arap_kind"),
    CheckConstraint("amount > 0 AND applied_amount >= 0 AND applied_amount <= amount", name="ck_arap_amounts"),
    ForeignKeyConstraint(["account_book_id", "period_id"], ["accounting_periods.account_book_id", "accounting_periods.id"], name="fk_arap_period_same_book"),
  )


class ARAPAllocation(Base):
  __tablename__ = "arap_allocations"
  id = Column(Integer, primary_key=True)
  account_book_id = Column(Integer, ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False, index=True)
  source_id = Column(Integer, nullable=False)
  target_id = Column(Integer, nullable=False)
  amount = Column(Numeric(18, 2), nullable=False)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False)
  released_at = Column(DateTime, nullable=True, index=True)
  released_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  release_reason = Column(Text, nullable=False, default="", server_default="")
  release_voucher_id = Column(Integer, ForeignKey("vouchers.id"), nullable=True)
  __table_args__ = (
    UniqueConstraint("account_book_id", "source_id", "target_id", name="uq_arap_allocation_pair"),
    CheckConstraint("amount > 0", name="ck_arap_allocation_amount"),
  )


class Department(Base):
  __tablename__ = "departments"
  id = Column(Integer, primary_key=True)
  name = Column(String(64), unique=True, nullable=False)
  parent_id = Column(Integer, ForeignKey("departments.id"), nullable=True)


class User(Base):
  __tablename__ = "users"
  id = Column(Integer, primary_key=True)
  username = Column(String(64), unique=True, nullable=False, index=True)
  pwd_hash = Column(String(255), nullable=False)
  real_name = Column(String(64), default="")
  status = Column(String(16), default="active")  # active/locked/disabled
  dept_id = Column(Integer, ForeignKey("departments.id"), nullable=True)
  failed_count = Column(Integer, default=0)
  locked_until = Column(DateTime, nullable=True)
  must_change_pwd = Column(Boolean, default=False)
  session_version = Column(Integer, nullable=False, default=0, server_default="0")
  # 功能模块分配（Stage 5）：是否已显式分配过模块。False（存量/未分配用户）走默认
  # 业务模块；True 时以 user_modules 行为准（允许显式分配为空）。
  modules_assigned = Column(Boolean, default=False, server_default="false")
  created_at = Column(DateTime, default=_now)
  roles = relationship("Role", secondary="user_roles", back_populates="users")
  modules = relationship(
    "UserModule", back_populates="user", cascade="all, delete-orphan"
  )


class ContactProfile(Base):
  """通讯录花名册：人员主数据，可选关联一个系统登录账号。"""

  __tablename__ = "contact_profiles"
  id = Column(Integer, primary_key=True)
  user_id = Column(
    Integer,
    ForeignKey("users.id", ondelete="CASCADE"),
    nullable=True,
    unique=True,
    index=True,
  )
  name = Column(String(64), nullable=False, default="")
  mobile = Column(String(32), default="")
  dept_id = Column(Integer, ForeignKey("departments.id"), nullable=True, index=True)
  employee_no = Column(String(32), unique=True, nullable=True, index=True)
  position = Column(String(64), default="")
  manager_id = Column(
    Integer, ForeignKey("contact_profiles.id"), nullable=True, index=True
  )
  employment_type = Column(String(32), default="正式")
  employment_status = Column(String(16), default="active", index=True)
  hire_date = Column(Date, nullable=True)
  regular_date = Column(Date, nullable=True)
  leave_date = Column(Date, nullable=True)
  work_email = Column(String(128), default="")
  office_phone = Column(String(32), default="")
  work_location = Column(String(128), default="")
  contract_type = Column(String(32), default="")
  contract_start = Column(Date, nullable=True)
  contract_end = Column(Date, nullable=True)
  gender = Column(String(8), default="")
  birth_date = Column(Date, nullable=True)
  id_card_no = Column(String(32), default="")
  native_place = Column(String(64), default="")
  political_status = Column(String(32), default="")
  marital_status = Column(String(16), default="")
  address = Column(String(255), default="")
  highest_education = Column(String(32), default="")
  school = Column(String(128), default="")
  major = Column(String(128), default="")
  graduation_date = Column(Date, nullable=True)
  degree = Column(String(32), default="")
  emergency_contact = Column(String(64), default="")
  emergency_relation = Column(String(32), default="")
  emergency_phone = Column(String(32), default="")
  remark = Column(Text, default="")
  updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now)
  updated_at = Column(DateTime, default=_now, onupdate=_now)


class Role(Base):
  __tablename__ = "roles"
  id = Column(Integer, primary_key=True)
  code = Column(String(32), unique=True, nullable=False)
  name = Column(String(64), nullable=False)
  users = relationship("User", secondary="user_roles", back_populates="roles")


class UserRole(Base):
  __tablename__ = "user_roles"
  user_id = Column(
    Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
  )
  role_id = Column(
    Integer, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
  )


class UserModule(Base):
  """用户功能模块分配（Stage 5）：按用户勾选的页面模块决定导航与接口访问。

  与角色解耦：管理员仍天然拥有全部模块（见 core.rbac）；普通用户以本表为准，
  未显式分配（users.modules_assigned=False）时回落到默认业务模块，保证存量平滑。
  """

  __tablename__ = "user_modules"
  user_id = Column(
    Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
  )
  module = Column(String(32), primary_key=True)
  user = relationship("User", back_populates="modules")


class Project(Base):
  __tablename__ = "projects"
  id = Column(Integer, primary_key=True)
  code = Column(
    String(32), unique=True, nullable=False, index=True
  )  # PJ-2026-0001 或用户录入编号
  name = Column(String(128), unique=True, nullable=False)
  type = Column(String(32), default="")
  dept_id = Column(Integer, ForeignKey("departments.id"), nullable=True, index=True)
  owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
  owner_name = Column(String(64), default="")
  plan_start = Column(Date, nullable=True)
  plan_end = Column(Date, nullable=True)
  budget_total = Column(Float, default=0)
  priority = Column(String(16), default="中")
  client = Column(String(128), default="")
  client_contact = Column(String(64), default="")  # 客户联系人（BLF-1150）
  client_phone = Column(String(64), default="")  # 联系方式（BLF-1150）
  description = Column(Text, default="")
  contract_status = Column(String(16), default="")  # 已签订 / 未签订
  status = Column(String(16), default="draft", index=True)
  # draft草稿/filed已立项/doing进行中/paused暂停/done已完成/archived已归档/cancelled已取消
  progress = Column(Float, default=0)
  deleted_at = Column(DateTime, nullable=True, index=True)  # 软删除（Stage 2）
  # 演示数据标记：由 scripts/seed_mock.py 写入；受系统参数 demo_data_on 控制是否显示
  is_demo = Column(Boolean, default=False, index=True)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now)
  updated_at = Column(DateTime, default=_now, onupdate=_now)
  members = relationship(
    "ProjectMember", back_populates="project", cascade="all, delete-orphan"
  )


class Opportunity(Base):
  """商机管理主数据：沿用项目台账的列表 / 分页口径，先提供轻量 CRUD。"""

  __tablename__ = "opportunities"
  id = Column(Integer, primary_key=True)
  code = Column(String(32), unique=True, nullable=False, index=True)
  name = Column(String(128), nullable=False)
  client = Column(String(128), default="")
  owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
  owner_name = Column(String(64), default="")
  budget_total = Column(Float, default=0)
  stage = Column(String(16), default="new", index=True)
  expected_close = Column(Date, nullable=True)
  description = Column(Text, default="")
  deleted_at = Column(DateTime, nullable=True, index=True)
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now)
  updated_at = Column(DateTime, default=_now, onupdate=_now)


class ProjectMember(Base):
  __tablename__ = "project_members"
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
  )
  user_id = Column(
    Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
  )
  project = relationship("Project", back_populates="members")


class ProjectReceivable(Base):
    """项目级应收台账；删除采用软删除以保留项目与回款历史。"""

    __tablename__ = "project_receivables"
    id = Column(Integer, primary_key=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name = Column(String(128), nullable=False)
    amount = Column(Numeric(18, 2), nullable=False)
    receivable_date = Column(Date, nullable=False)
    due_date = Column(Date, nullable=False)
    note = Column(Text, nullable=False, default="", server_default="")
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at = Column(DateTime, default=_now, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)
    deleted_at = Column(DateTime, nullable=True, index=True)
    deleted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    __table_args__ = (
        UniqueConstraint("project_id", "id", name="uq_project_receivables_project_id"),
        CheckConstraint("amount > 0", name="ck_project_receivable_amount"),
        CheckConstraint(
            "due_date >= receivable_date",
            name="ck_project_receivable_date_range",
        ),
    )


class ProjectReceivablePayment(Base):
    """应收下的逐笔回款；通过复合外键保证项目与应收路径一致。"""

    __tablename__ = "project_receivable_payments"
    id = Column(Integer, primary_key=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    receivable_id = Column(Integer, nullable=False, index=True)
    amount = Column(Numeric(18, 2), nullable=False)
    payment_date = Column(Date, nullable=False)
    note = Column(Text, nullable=False, default="", server_default="")
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at = Column(DateTime, default=_now, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)
    deleted_at = Column(DateTime, nullable=True, index=True)
    deleted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "receivable_id"],
            ["project_receivables.project_id", "project_receivables.id"],
            name="fk_project_receivable_payment_parent",
            ondelete="RESTRICT",
        ),
        CheckConstraint("amount > 0", name="ck_project_receivable_payment_amount"),
    )


class ProjectChange(Base):
  __tablename__ = "project_changes"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  field = Column(String(64), default="")
  old = Column(Text, default="")
  new = Column(Text, default="")
  by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  at = Column(DateTime, default=_now)


class Attachment(Base):
  __tablename__ = "attachments"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  filename = Column(String(255), default="")
  path = Column(String(512), default="")
  size = Column(Integer, default=0)
  content_type = Column(String(128), default="")
  uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  uploaded_at = Column(DateTime, default=_now)
  # 归属对象（Stage 4A）：空 = 项目级附件；ref_type="expense" + ref_id = 支出凭证
  ref_type = Column(String(32), default="")
  ref_id = Column(Integer, nullable=True)
  # 细分分类：项目合同、支出凭证、通讯录证件/合同等共用附件表时用于前端分组
  category = Column(String(32), default="")
  # 存储坐标（BLF-1136）：正文在哪个后端、对象键是什么、指纹是多少。
  # `path` 语义随后端变化：local = 磁盘路径；r2 = 对象公开 URL（便于排查）。
  storage_backend = Column(String(16), default="local", server_default="local")
  object_key = Column(String(512), default="")
  etag = Column(String(128), default="")
  __table_args__ = (Index("ix_attachments_ref", "ref_type", "ref_id"),)


class Followup(Base):
  __tablename__ = "followups"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
  happened_at = Column(DateTime, default=_now)
  method = Column(String(32), default="")
  content = Column(Text, default="")
  next_step = Column(Text, default="")
  remind_at = Column(DateTime, nullable=True, index=True)
  created_at = Column(DateTime, default=_now)
  # 跟进提醒的可追踪状态（Stage 4A）：pending 待处理 / done 已处理 / dismissed 已忽略
  remind_state = Column(String(16), default="pending", index=True)
  reminded_at = Column(DateTime, nullable=True, index=True)
  handled_at = Column(DateTime, nullable=True)
  handled_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  handle_note = Column(Text, default="")


class Milestone(Base):
  __tablename__ = "milestones"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  name = Column(String(128), nullable=False)
  plan_date = Column(Date, nullable=True)
  actual_date = Column(Date, nullable=True)
  owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  status = Column(String(16), default="open")  # open/closed
  created_at = Column(DateTime, default=_now)
  __table_args__ = (Index("ix_milestones_proj_status", "project_id", "status"),)


class Task(Base):
  __tablename__ = "tasks"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  parent_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
  level = Column(Integer, default=1)
  name = Column(String(128), nullable=False)
  owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  plan_start = Column(Date, nullable=True)
  plan_end = Column(Date, nullable=True)
  weight = Column(Float, default=1)
  progress = Column(Float, default=0)
  status = Column(String(16), default="todo", index=True)  # todo/doing/done/paused
  predecessor_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
  created_at = Column(DateTime, default=_now)
  updated_at = Column(DateTime, default=_now, onupdate=_now)
  __table_args__ = (Index("ix_tasks_proj_status", "project_id", "status"),)


class ProgressLog(Base):
  __tablename__ = "progress_logs"
  id = Column(Integer, primary_key=True)
  task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  progress = Column(Float, default=0)
  note = Column(Text, default="")
  remaining_days = Column(Integer, nullable=True)
  created_at = Column(DateTime, default=_now)
  __table_args__ = (Index("ix_logs_proj_created", "project_id", "created_at"),)


class Budget(Base):
  __tablename__ = "budgets"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  subject = Column(String(32), nullable=False)  # 人工/采购/外包/差旅/其他
  amount = Column(Float, nullable=False, default=0)
  period_start = Column(Date, nullable=True)
  period_end = Column(Date, nullable=True)
  created_at = Column(DateTime, default=_now)
  updated_at = Column(DateTime, default=_now, onupdate=_now)
  __table_args__ = (Index("ix_budgets_proj_subject", "project_id", "subject"),)


class BudgetAdjust(Base):
  __tablename__ = "budget_adjusts"
  id = Column(Integer, primary_key=True)
  budget_id = Column(Integer, ForeignKey("budgets.id", ondelete="CASCADE"))
  project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"))
  old_amount = Column(Float, default=0)
  new_amount = Column(Float, default=0)
  reason = Column(Text, default="")
  status = Column(String(16), default="pending")  # pending/approved/rejected
  by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  # 审批意见与决策时间（Stage 4A）：申请人可查的状态变化来源
  decision_reason = Column(Text, default="")
  decided_at = Column(DateTime, nullable=True)
  created_at = Column(DateTime, default=_now)


class Expense(Base):
  __tablename__ = "expenses"
  id = Column(Integer, primary_key=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True
  )
  subject = Column(String(32), default="")
  amount = Column(Float, nullable=False)
  exp_date = Column(Date, nullable=True)
  note = Column(Text, default="")
  status = Column(String(16), default="approved", index=True)
  # approved已通过/pending待审批/rejected已驳回/exception特批通过
  by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  # 审批意见与决策时间（Stage 4A）：驳回原因对申请人可见，重新提交后清空
  decision_reason = Column(Text, default="")
  decided_at = Column(DateTime, nullable=True)
  resubmit_count = Column(Integer, default=0)
  created_at = Column(DateTime, default=_now)
  __table_args__ = (
    Index("ix_expenses_proj_subject", "project_id", "subject"),
    Index("ix_expenses_proj_status", "project_id", "status"),
  )


class ApprovalRecord(Base):
  """审批时间线（Stage 4A）：支出 / 预算调整 / 立项的统一状态变化留痕。

  每条记录 = 一次状态变化（提交、重提、通过、驳回、特批），带申请人、决策人、意见与时间，
  使「申请人可查的状态变化」不依赖审计日志（审计面向管理员，本表面向业务当事人）。
  """

  __tablename__ = "approval_records"
  id = Column(Integer, primary_key=True)
  kind = Column(
    String(32), nullable=False, index=True
  )  # expense/budget_adjust/project_filing
  ref_id = Column(Integer, nullable=False, index=True)
  project_id = Column(
    Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True
  )
  action = Column(String(32), default="")  # submit/resubmit/approve/reject/exception
  from_status = Column(String(16), default="")
  to_status = Column(String(16), default="")
  actor_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  reason = Column(Text, default="")
  created_at = Column(DateTime, default=_now, index=True)
  __table_args__ = (Index("ix_approval_records_ref", "kind", "ref_id", "id"),)


class Partner(Base):
  """我的友商（BLF-1152）：竞对 / 陪标单位信息主数据，仅管理员维护。"""

  __tablename__ = "partners"
  id = Column(Integer, primary_key=True)
  name = Column(String(128), unique=True, nullable=False, index=True)
  contact_name = Column(String(64), default="")
  phone = Column(String(64), default="")
  email = Column(String(128), default="")
  address = Column(String(255), default="")
  remark = Column(Text, default="")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  created_at = Column(DateTime, default=_now)
  updated_at = Column(DateTime, default=_now, onupdate=_now)
  contracts = relationship(
    "PartnerContract", back_populates="partner", cascade="all, delete-orphan"
  )


class PartnerContract(Base):
  """友商业绩合同子表：项目名 / 金额 / 时间，随友商删除级联。"""

  __tablename__ = "partner_contracts"
  id = Column(Integer, primary_key=True)
  partner_id = Column(
    Integer, ForeignKey("partners.id", ondelete="CASCADE"), nullable=False, index=True
  )
  project_name = Column(String(128), nullable=False, default="")
  amount = Column(Float, default=0)
  signed_date = Column(Date, nullable=True)
  remark = Column(Text, default="")
  created_at = Column(DateTime, default=_now)
  partner = relationship("Partner", back_populates="contracts")


class AuditLog(Base):
  __tablename__ = "audit_logs"
  id = Column(Integer, primary_key=True)
  user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
  action = Column(String(64), index=True)
  resource = Column(String(64), default="")
  resource_id = Column(String(64), default="")
  detail = Column(Text, default="")
  ip = Column(String(64), default="")
  created_at = Column(DateTime, default=_now, index=True)


class SysParam(Base):
  __tablename__ = "sys_params"
  id = Column(Integer, primary_key=True)
  key = Column(String(64), unique=True, nullable=False)
  value = Column(String(255), default="")
  desc = Column(String(255), default="")


class Dict(Base):
  __tablename__ = "dicts"
  id = Column(Integer, primary_key=True)
  type = Column(String(32), index=True)
  code = Column(String(32))
  label = Column(String(64))
  sort = Column(Integer, default=0)


class EquipmentBatch(Base):
  """公司设备入库批次，与财务固定资产和项目均无关联。"""
  __tablename__ = "equipment_batches"
  id = Column(Integer, primary_key=True)
  name = Column(String(128), nullable=False)
  source = Column(String(255), nullable=False, default="")
  supplier = Column(String(255), nullable=False, default="")
  purchase_order_no = Column(String(128), nullable=False, default="")
  invoice_no = Column(String(128), nullable=False, default="")
  acceptance_status = Column(String(24), nullable=False, default="accepted")
  note = Column(Text, nullable=False, default="")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
  created_at = Column(DateTime, default=_now, nullable=False)
  __table_args__ = (Index("uq_equipment_batches_name_lower", func.lower(name), unique=True),)


class EquipmentAsset(Base):
  """单件设备或库存记录的当前快照；数量流转另记 EquipmentEvent。"""
  __tablename__ = "equipment_assets"
  id = Column(Integer, primary_key=True)
  code = Column(String(40), nullable=False, unique=True, index=True)
  name = Column(String(128), nullable=False)
  category_code = Column(String(32), nullable=False, index=True)
  serial_number = Column(String(128), nullable=True, unique=True)
  brand = Column(String(128), nullable=False, default="")
  model = Column(String(128), nullable=False, default="")
  location = Column(String(128), nullable=False, default="")
  note = Column(Text, nullable=False, default="")
  purchase_date = Column(Date, nullable=True)
  purchase_price = Column(Numeric(14, 2), nullable=True)
  status = Column(String(20), nullable=False, default="available", index=True)
  holder_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
  due_date = Column(Date, nullable=True)
  batch_id = Column(Integer, ForeignKey("equipment_batches.id"), nullable=True, index=True)
  # 批量库存以此记录为一个入库来源，quantity 为入库量，available_quantity 为可出库余量。
  quantity = Column(Integer, nullable=False, default=1, server_default="1")
  available_quantity = Column(Integer, nullable=False, default=1, server_default="1")
  inventory_managed = Column(Boolean, nullable=False, default=False, server_default="false")
  created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
  created_at = Column(DateTime, default=_now, nullable=False)
  updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)
  __table_args__ = (
      CheckConstraint(
          "status IN ('pending_acceptance','available','claimed','borrowed','maintenance','scrapped','void')",
          name="ck_equipment_status",
      ),
      CheckConstraint("quantity > 0", name="ck_equipment_quantity_positive"),
      CheckConstraint(
          "available_quantity >= 0 AND available_quantity <= quantity",
          name="ck_equipment_available_quantity_range",
      ),
      CheckConstraint(
          "inventory_managed OR (quantity = 1 AND available_quantity = 1)",
          name="ck_equipment_single_asset_quantity",
      ),
  )


class EquipmentEvent(Base):
  """追加式业务流水；应用层只提供创建和查询。"""
  __tablename__ = "equipment_events"
  id = Column(Integer, primary_key=True)
  asset_id = Column(Integer, ForeignKey("equipment_assets.id"), nullable=False, index=True)
  batch_id = Column(Integer, ForeignKey("equipment_batches.id"), nullable=True)
  action = Column(String(24), nullable=False)
  from_status = Column(String(20), nullable=True)
  to_status = Column(String(20), nullable=False)
  actor_id = Column(Integer, ForeignKey("users.id"), nullable=False)
  holder_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  due_date = Column(Date, nullable=True)
  note = Column(Text, nullable=False, default="")
  # 出库流水扩展字段；普通生命周期事件为空，出库记录必须携带完整信息。
  quantity = Column(Integer, nullable=True)
  customer = Column(String(255), nullable=True)
  destination = Column(String(255), nullable=True)
  shipped_at = Column(DateTime, nullable=True)
  created_at = Column(DateTime, default=_now, nullable=False, index=True)
  __table_args__ = (
      CheckConstraint(
          "action <> 'outbound' OR (quantity > 0 AND shipped_at IS NOT NULL "
          "AND (length(trim(coalesce(customer, ''))) > 0 OR "
          "length(trim(coalesce(destination, ''))) > 0))",
          name="ck_equipment_outbound_details",
      ),
      Index("ix_equipment_events_outbound_time", "action", "shipped_at"),
  )


class TokenBlacklist(Base):
  __tablename__ = "token_blacklist"
  id = Column(Integer, primary_key=True)
  jti = Column(String(64), unique=True, nullable=False)
  user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
  expires_at = Column(DateTime, nullable=True)
  created_at = Column(DateTime, default=_now)


class Notification(Base):
  """站内通知（Stage 3）：预警/审批/提醒统一落库，支持已读与历史。"""

  __tablename__ = "notifications"
  id = Column(Integer, primary_key=True)
  user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
  type = Column(
    String(32), index=True
  )  # overdue_task/milestone/stagnant/budget/followup/approval/expense
  title = Column(String(128), default="")
  body = Column(Text, default="")
  channel = Column(String(16), default="inapp")  # inapp（预留 email/wecom）
  ref_type = Column(
    String(32), default=""
  )  # project/task/milestone/expense/budget_adjust
  ref_id = Column(Integer, nullable=True)
  project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
  dedup_key = Column(String(128), index=True)  # 去重：同 key 同日不重复推送
  read_at = Column(DateTime, nullable=True, index=True)
  # 处理状态（Stage 4A）：pending 待处理 / done 已处理 / ignored 已忽略
  state = Column(String(16), default="pending", index=True)
  handled_at = Column(DateTime, nullable=True)
  handled_by = Column(Integer, ForeignKey("users.id"), nullable=True)
  handle_note = Column(Text, default="")
  created_at = Column(DateTime, default=_now, index=True)
  __table_args__ = (Index("ix_notif_user_read", "user_id", "read_at"),)
