"""为财务凭证增加项目支出来源关联。"""

import sqlalchemy as sa
from alembic import op


revision = "0026_finance_project_expense_voucher"
down_revision = "0025_finance_lifecycle"
branch_labels = None
depends_on = None


def _voucher_state() -> tuple[set[str], set[str], set[str]] | None:
    inspector = sa.inspect(op.get_bind())
    if "vouchers" not in inspector.get_table_names():
        return None
    columns = {column["name"] for column in inspector.get_columns("vouchers")}
    unique_constraints = {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("vouchers")
    }
    foreign_keys = {
        constraint["name"]
        for constraint in inspector.get_foreign_keys("vouchers")
    }
    return columns, unique_constraints, foreign_keys


def upgrade():
    state = _voucher_state()
    if state is None:
        return
    columns, unique_constraints, foreign_keys = state
    if "source_expense_id" not in columns:
        op.add_column(
            "vouchers", sa.Column("source_expense_id", sa.Integer(), nullable=True)
        )
    if "uq_vouchers_source_expense_id" not in unique_constraints:
        op.create_unique_constraint(
            "uq_vouchers_source_expense_id", "vouchers", ["source_expense_id"]
        )
    if "fk_vouchers_source_expense_id_expenses" not in foreign_keys:
        op.create_foreign_key(
            "fk_vouchers_source_expense_id_expenses",
            "vouchers",
            "expenses",
            ["source_expense_id"],
            ["id"],
            ondelete="RESTRICT",
        )


def downgrade():
    state = _voucher_state()
    if state is None:
        return
    columns, unique_constraints, foreign_keys = state
    if "fk_vouchers_source_expense_id_expenses" in foreign_keys:
        op.drop_constraint(
            "fk_vouchers_source_expense_id_expenses", "vouchers", type_="foreignkey"
        )
    if "uq_vouchers_source_expense_id" in unique_constraints:
        op.drop_constraint(
            "uq_vouchers_source_expense_id", "vouchers", type_="unique"
        )
    if "source_expense_id" in columns:
        op.drop_column("vouchers", "source_expense_id")
