"""记录项目应收与回款的最后修改人。"""

import sqlalchemy as sa
from alembic import op

revision = "0033_project_receivable_updaters"
down_revision = "0032_project_receivables"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()

    def has_column(table: str, column: str) -> bool:
        return column in {item["name"] for item in sa.inspect(bind).get_columns(table)}

    if not has_column("project_receivables", "updated_by"):
        op.add_column(
            "project_receivables",
            sa.Column("updated_by", sa.Integer(), nullable=True),
        )
    if not has_column("project_receivable_payments", "updated_by"):
        op.add_column(
            "project_receivable_payments",
            sa.Column("updated_by", sa.Integer(), nullable=True),
        )
    fk_names = {
        fk["name"]
        for table in ("project_receivables", "project_receivable_payments")
        for fk in sa.inspect(bind).get_foreign_keys(table)
    }
    if "fk_project_receivables_updated_by_users" not in fk_names:
        op.create_foreign_key(
            "fk_project_receivables_updated_by_users", "project_receivables", "users",
            ["updated_by"], ["id"], ondelete="RESTRICT",
        )
    if "fk_project_receivable_payments_updated_by_users" not in fk_names:
        op.create_foreign_key(
            "fk_project_receivable_payments_updated_by_users", "project_receivable_payments", "users",
            ["updated_by"], ["id"], ondelete="RESTRICT",
        )
    op.execute("UPDATE project_receivables SET updated_by = created_by")
    op.execute("UPDATE project_receivable_payments SET updated_by = created_by")
    op.alter_column(
        "project_receivables", "updated_by", existing_type=sa.Integer(), nullable=False,
    )
    op.alter_column(
        "project_receivable_payments", "updated_by", existing_type=sa.Integer(), nullable=False,
    )


def downgrade():
    op.drop_constraint(
        "fk_project_receivable_payments_updated_by_users",
        "project_receivable_payments",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_project_receivables_updated_by_users",
        "project_receivables",
        type_="foreignkey",
    )
    op.drop_column("project_receivable_payments", "updated_by")
    op.drop_column("project_receivables", "updated_by")
