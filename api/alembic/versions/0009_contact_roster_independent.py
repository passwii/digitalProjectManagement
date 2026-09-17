"""通讯录改为人员主数据，账号变为可选关联。"""
from alembic import op
import sqlalchemy as sa

revision = "0009_contact_roster_independent"
down_revision = "0008_contact_profiles"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    return col in [c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)]


def _foreign_key(table: str, column: str) -> str | None:
    for fk in sa.inspect(op.get_bind()).get_foreign_keys(table):
        if column in (fk.get("constrained_columns") or []):
            return fk.get("name")
    return None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column("contact_profiles", "name"):
        op.add_column("contact_profiles", sa.Column("name", sa.String(64), nullable=False,
                                                    server_default=""))
    if not _has_column("contact_profiles", "mobile"):
        op.add_column("contact_profiles", sa.Column("mobile", sa.String(32), server_default=""))
    if not _has_column("contact_profiles", "dept_id"):
        op.add_column("contact_profiles", sa.Column(
            "dept_id", sa.Integer(), sa.ForeignKey("departments.id"), nullable=True))
        op.create_index("ix_contact_profiles_dept_id", "contact_profiles", ["dept_id"])

    # 原档案从关联账号回填姓名、手机号和部门。
    bind.exec_driver_sql(
        "UPDATE contact_profiles cp "
        "SET name = COALESCE(NULLIF(cp.name, ''), NULLIF(u.real_name, ''), u.username), "
        "    mobile = COALESCE(NULLIF(cp.mobile, ''), u.username), "
        "    dept_id = COALESCE(cp.dept_id, u.dept_id) "
        "FROM users u WHERE cp.user_id = u.id"
    )

    # 原系统用户全部转成通讯录人员，保证已有账号不会从花名册消失。
    bind.exec_driver_sql(
        "INSERT INTO contact_profiles "
        "(user_id, name, mobile, dept_id, employment_type, employment_status, created_at, updated_at) "
        "SELECT u.id, COALESCE(NULLIF(u.real_name, ''), u.username), u.username, u.dept_id, "
        "       '正式', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP "
        "FROM users u "
        "WHERE NOT EXISTS (SELECT 1 FROM contact_profiles cp WHERE cp.user_id = u.id)"
    )

    # manager_id 从 users.id 迁到 contact_profiles.id。
    if not _has_column("contact_profiles", "manager_user_id"):
        op.add_column("contact_profiles", sa.Column("manager_user_id", sa.Integer(), nullable=True))
    bind.exec_driver_sql(
        "UPDATE contact_profiles SET manager_user_id = manager_id "
        "WHERE manager_user_id IS NULL AND manager_id IS NOT NULL"
    )
    old_fk = _foreign_key("contact_profiles", "manager_id")
    if old_fk:
        op.drop_constraint(old_fk, "contact_profiles", type_="foreignkey")
    bind.exec_driver_sql(
        "UPDATE contact_profiles cp SET manager_id = mgr.id "
        "FROM contact_profiles mgr "
        "WHERE cp.manager_user_id IS NOT NULL AND mgr.user_id = cp.manager_user_id"
    )
    bind.exec_driver_sql(
        "UPDATE contact_profiles SET manager_id = NULL "
        "WHERE manager_user_id IS NOT NULL AND NOT EXISTS ("
        "  SELECT 1 FROM contact_profiles mgr WHERE mgr.id = contact_profiles.manager_id)"
    )
    op.create_foreign_key("fk_contact_profiles_manager_contact", "contact_profiles",
                          "contact_profiles", ["manager_id"], ["id"])
    op.drop_column("contact_profiles", "manager_user_id")

    # 通讯录附件原以 users.id 归属，统一改为主档案 contact_profiles.id。
    bind.exec_driver_sql(
        "UPDATE attachments a SET ref_id = cp.id "
        "FROM contact_profiles cp "
        "WHERE a.ref_type = 'contact' AND cp.user_id IS NOT NULL AND a.ref_id = cp.user_id"
    )

    op.alter_column("contact_profiles", "user_id", existing_type=sa.Integer(), nullable=True)


def downgrade():
    bind = op.get_bind()
    if _has_column("contact_profiles", "user_id"):
        bind.exec_driver_sql(
            "UPDATE attachments a SET ref_id = cp.user_id "
            "FROM contact_profiles cp "
            "WHERE a.ref_type = 'contact' AND cp.user_id IS NOT NULL AND a.ref_id = cp.id"
        )
    if not _has_column("contact_profiles", "manager_user_id"):
        op.add_column("contact_profiles", sa.Column("manager_user_id", sa.Integer(), nullable=True))
    bind.exec_driver_sql(
        "UPDATE contact_profiles cp SET manager_user_id = mgr.user_id "
        "FROM contact_profiles mgr WHERE cp.manager_id = mgr.id"
    )
    new_fk = _foreign_key("contact_profiles", "manager_id")
    if new_fk:
        op.drop_constraint(new_fk, "contact_profiles", type_="foreignkey")
    bind.exec_driver_sql("UPDATE contact_profiles SET manager_id = manager_user_id")
    op.create_foreign_key("contact_profiles_manager_id_fkey", "contact_profiles",
                          "users", ["manager_id"], ["id"])
    op.drop_column("contact_profiles", "manager_user_id")
    if _has_column("contact_profiles", "dept_id"):
        indexes = [i["name"] for i in sa.inspect(bind).get_indexes("contact_profiles")]
        if "ix_contact_profiles_dept_id" in indexes:
            op.drop_index("ix_contact_profiles_dept_id", table_name="contact_profiles")
        op.drop_column("contact_profiles", "dept_id")
    for column in ("mobile", "name"):
        if _has_column("contact_profiles", column):
            op.drop_column("contact_profiles", column)
