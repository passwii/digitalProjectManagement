"""用户功能模块分配（Stage 5）：user_modules 表 + users.modules_assigned 标记。

  · `user_modules(user_id, module)`：按用户勾选的页面模块，决定导航与接口访问；
    模块键取值见 core.rbac.MODULE_CATALOG（opportunities/projects/assets/reports/
    contacts/partners/approvals/admin）。
  · `users.modules_assigned`：是否已显式分配过模块。默认 false 表示存量/未分配用户，
    运行时回落到默认业务模块（四个基础导航模块），保证升级后既有普通用户行为不变、无需回填。
  · 管理员天然拥有全部模块，不在本表落行；财务（/finance）沿用账套成员授权，不在此列。

幂等：建表/加列前先查存在性，重复执行不报错（与本仓库既有迁移一致）。
"""

import sqlalchemy as sa

from alembic import op

revision = "0029_user_modules"
down_revision = "0028_equipment_acceptance"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade():
    if not _has_table("user_modules"):
        op.create_table(
            "user_modules",
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("module", sa.String(32), primary_key=True),
        )

    if not _has_column("users", "modules_assigned"):
        op.add_column(
            "users",
            sa.Column(
                "modules_assigned",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade():
    if _has_column("users", "modules_assigned"):
        op.drop_column("users", "modules_assigned")
    if _has_table("user_modules"):
        op.drop_table("user_modules")
