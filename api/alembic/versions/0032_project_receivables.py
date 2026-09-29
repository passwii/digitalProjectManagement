"""增加项目级应收与逐笔回款台账。"""

import sqlalchemy as sa
from alembic import op

revision = "0032_project_receivables"
down_revision = "0031_equipment_batch_names"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "project_receivables",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("receivable_date", sa.Date(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column(
            "deleted_by",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "project_id",
            "id",
            name="uq_project_receivables_project_id",
        ),
        sa.CheckConstraint(
            "amount > 0",
            name="ck_project_receivable_amount",
        ),
        sa.CheckConstraint(
            "due_date >= receivable_date",
            name="ck_project_receivable_date_range",
        ),
    )
    op.create_index(
        "ix_project_receivables_project_id",
        "project_receivables",
        ["project_id"],
    )
    op.create_index(
        "ix_project_receivables_deleted_at",
        "project_receivables",
        ["deleted_at"],
    )

    op.create_table(
        "project_receivable_payments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("receivable_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("payment_date", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column(
            "deleted_by",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "receivable_id"],
            ["project_receivables.project_id", "project_receivables.id"],
            name="fk_project_receivable_payment_parent",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "amount > 0",
            name="ck_project_receivable_payment_amount",
        ),
    )
    op.create_index(
        "ix_project_receivable_payments_project_id",
        "project_receivable_payments",
        ["project_id"],
    )
    op.create_index(
        "ix_project_receivable_payments_receivable_id",
        "project_receivable_payments",
        ["receivable_id"],
    )
    op.create_index(
        "ix_project_receivable_payments_deleted_at",
        "project_receivable_payments",
        ["deleted_at"],
    )


def downgrade():
    op.drop_index(
        "ix_project_receivable_payments_deleted_at",
        table_name="project_receivable_payments",
    )
    op.drop_index(
        "ix_project_receivable_payments_receivable_id",
        table_name="project_receivable_payments",
    )
    op.drop_index(
        "ix_project_receivable_payments_project_id",
        table_name="project_receivable_payments",
    )
    op.drop_table("project_receivable_payments")
    op.drop_index(
        "ix_project_receivables_deleted_at",
        table_name="project_receivables",
    )
    op.drop_index(
        "ix_project_receivables_project_id",
        table_name="project_receivables",
    )
    op.drop_table("project_receivables")
