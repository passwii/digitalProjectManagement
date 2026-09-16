"""演示数据开关：projects.is_demo 标记 + 存量数据回填。

开关本身是系统参数 demo_data_on（0=隐藏，1=显示），不在此迁移中设置默认值，
由 api/seed.py 的 PARAMS 提供默认（0），管理员可在界面切换。
"""
from alembic import op
import sqlalchemy as sa

revision = "0005_project_is_demo"
down_revision = "0004_project_fts"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return col in [c["name"] for c in insp.get_columns(table)]


def upgrade():
    if not _has_column("projects", "is_demo"):
        # server_default 让存量行立刻有值（0=非演示），随后由回填写入演示标记
        op.add_column("projects", sa.Column("is_demo", sa.Boolean(), nullable=False,
                                            server_default=sa.false()))
        op.create_index("ix_projects_is_demo", "projects", ["is_demo"])

    # 存量回填：把早期由 seed_mock 写入的演示项目（编号 PJ-<年>-90xx）标记为演示数据。
    # 说明：seed_mock 早期版本没有 is_demo 字段，只能按编号区间识别；新版本会显式写入该字段。
    op.get_bind().exec_driver_sql(
        "UPDATE projects SET is_demo = TRUE WHERE code LIKE 'PJ-____-90__'"
    )


def downgrade():
    if _has_column("projects", "is_demo"):
        try:
            op.drop_index("ix_projects_is_demo", table_name="projects")
        except Exception:
            pass
        op.drop_column("projects", "is_demo")
