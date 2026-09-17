"""通讯录花名册扩展档案。"""
from alembic import op
import sqlalchemy as sa

revision = "0008_contact_profiles"
down_revision = "0007_project_contracts"
branch_labels = None
depends_on = None


def _has_table(table: str) -> bool:
    return table in sa.inspect(op.get_bind()).get_table_names()


def _has_column(table: str, col: str) -> bool:
    return col in [c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)]


def upgrade():
    if not _has_column("attachments", "category"):
        op.add_column("attachments", sa.Column("category", sa.String(32), server_default=""))
    if _has_table("contact_profiles"):
        return
    op.create_table(
        "contact_profiles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("employee_no", sa.String(32), nullable=True),
        sa.Column("position", sa.String(64), server_default=""),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("employment_type", sa.String(32), server_default="正式"),
        sa.Column("employment_status", sa.String(16), server_default="active"),
        sa.Column("hire_date", sa.Date(), nullable=True),
        sa.Column("regular_date", sa.Date(), nullable=True),
        sa.Column("leave_date", sa.Date(), nullable=True),
        sa.Column("work_email", sa.String(128), server_default=""),
        sa.Column("office_phone", sa.String(32), server_default=""),
        sa.Column("work_location", sa.String(128), server_default=""),
        sa.Column("contract_type", sa.String(32), server_default=""),
        sa.Column("contract_start", sa.Date(), nullable=True),
        sa.Column("contract_end", sa.Date(), nullable=True),
        sa.Column("gender", sa.String(8), server_default=""),
        sa.Column("birth_date", sa.Date(), nullable=True),
        sa.Column("id_card_no", sa.String(32), server_default=""),
        sa.Column("native_place", sa.String(64), server_default=""),
        sa.Column("political_status", sa.String(32), server_default=""),
        sa.Column("marital_status", sa.String(16), server_default=""),
        sa.Column("address", sa.String(255), server_default=""),
        sa.Column("highest_education", sa.String(32), server_default=""),
        sa.Column("school", sa.String(128), server_default=""),
        sa.Column("major", sa.String(128), server_default=""),
        sa.Column("graduation_date", sa.Date(), nullable=True),
        sa.Column("degree", sa.String(32), server_default=""),
        sa.Column("emergency_contact", sa.String(64), server_default=""),
        sa.Column("emergency_relation", sa.String(32), server_default=""),
        sa.Column("emergency_phone", sa.String(32), server_default=""),
        sa.Column("remark", sa.Text(), server_default=""),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_contact_profiles_user_id", "contact_profiles", ["user_id"], unique=True)
    op.create_index("ix_contact_profiles_employee_no", "contact_profiles", ["employee_no"], unique=True)
    op.create_index("ix_contact_profiles_manager_id", "contact_profiles", ["manager_id"])
    op.create_index("ix_contact_profiles_employment_status", "contact_profiles", ["employment_status"])


def downgrade():
    if _has_table("contact_profiles"):
        op.drop_table("contact_profiles")
    if _has_column("attachments", "category"):
        op.drop_column("attachments", "category")
