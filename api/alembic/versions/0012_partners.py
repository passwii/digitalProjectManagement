"""我的友商模块三张表（BLF-1152）：partners / partner_members / partner_contracts。

  · `partners`：友商主数据（名称全局唯一，类型为可配自由文本，
    取值建议来自 dicts(type='partner_type')，见 api/seed.py）；
  · `partner_members`：人员子表，`partner_id` 级联删除；
  · `partner_contracts`：业绩合同子表（项目名/金额/时间），`partner_id` 级联删除；
  · 资质证书及其他附件复用 `attachments` 表（`ref_type='partner'`），无需新表。

默认空串 / 0 —— 存量库（无友商数据）无需回填即自洽。
幂等：建表前先查存在性，重复执行不报错（与本仓库既有迁移一致）。
"""

import sqlalchemy as sa

from alembic import op

revision = "0012_partners"
down_revision = "0011_project_client_fields"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade():
    if not _has_table("partners"):
        op.create_table(
            "partners",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("name", sa.String(128), nullable=False),
            sa.Column("partner_type", sa.String(32), server_default=""),
            sa.Column("contact_name", sa.String(64), server_default=""),
            sa.Column("phone", sa.String(64), server_default=""),
            sa.Column("email", sa.String(128), server_default=""),
            sa.Column("address", sa.String(255), server_default=""),
            sa.Column("remark", sa.Text(), server_default=""),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
            sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id")),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_partners_name", "partners", ["name"], unique=True)
        op.create_index("ix_partners_partner_type", "partners", ["partner_type"])

    if not _has_table("partner_members"):
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
        op.create_index(
            "ix_partner_members_partner_id", "partner_members", ["partner_id"]
        )

    if not _has_table("partner_contracts"):
        op.create_table(
            "partner_contracts",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "partner_id",
                sa.Integer(),
                sa.ForeignKey("partners.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("project_name", sa.String(128), nullable=False, server_default=""),
            sa.Column("amount", sa.Float(), server_default="0"),
            sa.Column("signed_date", sa.Date(), nullable=True),
            sa.Column("remark", sa.Text(), server_default=""),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_partner_contracts_partner_id", "partner_contracts", ["partner_id"]
        )


def downgrade():
    for table, indexes in (
        ("partner_contracts", ["ix_partner_contracts_partner_id"]),
        ("partner_members", ["ix_partner_members_partner_id"]),
        ("partners", ["ix_partners_partner_type", "ix_partners_name"]),
    ):
        if not _has_table(table):
            continue
        bind = op.get_bind()
        existing = {ix["name"] for ix in sa.inspect(bind).get_indexes(table)}
        for ix in indexes:
            if ix in existing:
                op.drop_index(ix, table_name=table)
        op.drop_table(table)
