"""项目台账新增客户联系人 / 联系方式（BLF-1150）。

背景：项目编辑需录入 `客户联系人`、`联系方式`，台账列表与详情可读。

  · `projects.client_contact`：客户联系人姓名（String 64，默认空串）；
  · `projects.client_phone`：联系方式（电话/手机，String 64，默认空串）。

默认空串 —— 存量行无需回填即自洽；读写接口（`api/routers/projects.py`）同步放行，
变更留痕（ProjectChange）沿用通用字段白名单机制。

幂等：所有 `add_column` 都先查存在性，重复执行不报错（与本仓库既有迁移一致）。
"""

import sqlalchemy as sa

from alembic import op

revision = "0011_project_client_fields"
down_revision = "0010_attachment_storage"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    return col in [c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)]


def upgrade():
    if not _has_column("projects", "client_contact"):
        op.add_column(
            "projects",
            sa.Column("client_contact", sa.String(64), nullable=False, server_default=""),
        )
    if not _has_column("projects", "client_phone"):
        op.add_column(
            "projects",
            sa.Column("client_phone", sa.String(64), nullable=False, server_default=""),
        )


def downgrade():
    if _has_column("projects", "client_phone"):
        op.drop_column("projects", "client_phone")
    if _has_column("projects", "client_contact"):
        op.drop_column("projects", "client_contact")
