"""移除友商类型字段和人员子表。"""

import sqlalchemy as sa

from alembic import op


revision = "0023_remove_partner_type_and_members"
down_revision = "0022_remove_project_directional_contracts"
branch_labels = None
depends_on = None


def _inspector():
    return sa.inspect(op.get_bind())


def upgrade():
    inspector = _inspector()
    table_names = set(inspector.get_table_names())
    if "partner_members" in table_names:
        op.drop_table("partner_members")
    if "partners" in table_names:
        columns = {item["name"] for item in inspector.get_columns("partners")}
        if "partner_type" in columns:
            indexes = {item["name"] for item in inspector.get_indexes("partners")}
            if "ix_partners_partner_type" in indexes:
                op.drop_index("ix_partners_partner_type", table_name="partners")
            op.drop_column("partners", "partner_type")
    if "dicts" in table_names:
        op.execute(sa.text("DELETE FROM dicts WHERE type = 'partner_type'"))


def downgrade():
    inspector = _inspector()
    table_names = set(inspector.get_table_names())
    if "partners" in table_names:
        columns = {item["name"] for item in inspector.get_columns("partners")}
        if "partner_type" not in columns:
            op.add_column(
                "partners",
                sa.Column("partner_type", sa.String(32), server_default=""),
            )
            op.create_index("ix_partners_partner_type", "partners", ["partner_type"])
    if "partner_members" not in table_names:
        op.create_table(
            "partner_members",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "partner_id",
                sa.Integer(),
                sa.ForeignKey("partners.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("name", sa.String(64), nullable=False, server_default=""),
            sa.Column("position", sa.String(64), server_default=""),
            sa.Column("phone", sa.String(64), server_default=""),
            sa.Column("email", sa.String(128), server_default=""),
            sa.Column("remark", sa.Text(), server_default=""),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_partner_members_partner_id", "partner_members", ["partner_id"])
