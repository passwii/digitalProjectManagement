"""Stage 4A：进度成本审批通知闭环。

补齐三处「状态无来源、无去向」的缺口：

1. `attachments.ref_type/ref_id` —— 支出凭证附件关联（原先附件只能挂在项目上）；
2. `expenses.decision_reason/decided_at/resubmit_count` 与
   `budget_adjusts.decision_reason/decided_at` —— 审批意见与决策时间，驳回后申请人可查；
3. `followups.remind_state/reminded_at/handled_at/handled_by/handle_note` ——
   跟进提醒的可追踪通知/处理状态（原先只有 remind_at，无法区分「已通知」与「已处理」）。

另建 `approval_records` 审批时间线表：支出 / 预算调整 / 立项的统一状态变化留痕，
供申请人（非管理员）查看自己单据的完整流转，而不是只能读管理员专属的审计日志。

存量数据回填：已决策的支出与调整单写一条 approval_records（来源可追溯），
跟进记录按 remind_at 是否已过期回填 remind_state。
"""
from alembic import op
import sqlalchemy as sa

revision = "0006_closure_loop"
down_revision = "0005_project_is_demo"
branch_labels = None
depends_on = None


def _has_table(table: str) -> bool:
    return table in sa.inspect(op.get_bind()).get_table_names()


def _has_column(table: str, col: str) -> bool:
    return col in [c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)]


def _has_index(table: str, name: str) -> bool:
    return name in [i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)]


def upgrade():
    # 1) 支出凭证附件：附件归属对象
    if not _has_column("attachments", "ref_type"):
        op.add_column("attachments", sa.Column("ref_type", sa.String(32), server_default=""))
    if not _has_column("attachments", "ref_id"):
        op.add_column("attachments", sa.Column("ref_id", sa.Integer(), nullable=True))
    if not _has_index("attachments", "ix_attachments_ref"):
        op.create_index("ix_attachments_ref", "attachments", ["ref_type", "ref_id"])

    # 2) 支出：审批意见 / 决策时间 / 重提次数
    if not _has_column("expenses", "decision_reason"):
        op.add_column("expenses", sa.Column("decision_reason", sa.Text(), server_default=""))
    if not _has_column("expenses", "decided_at"):
        op.add_column("expenses", sa.Column("decided_at", sa.DateTime(), nullable=True))
    if not _has_column("expenses", "resubmit_count"):
        op.add_column("expenses", sa.Column("resubmit_count", sa.Integer(), server_default="0"))

    # 3) 预算调整单：审批意见 / 决策时间
    if not _has_column("budget_adjusts", "decision_reason"):
        op.add_column("budget_adjusts", sa.Column("decision_reason", sa.Text(), server_default=""))
    if not _has_column("budget_adjusts", "decided_at"):
        op.add_column("budget_adjusts", sa.Column("decided_at", sa.DateTime(), nullable=True))

    # 4) 跟进提醒：通知/处理状态
    if not _has_column("followups", "remind_state"):
        op.add_column("followups", sa.Column("remind_state", sa.String(16), server_default="pending"))
        op.create_index("ix_followups_remind_state", "followups", ["remind_state"])
    if not _has_column("followups", "reminded_at"):
        op.add_column("followups", sa.Column("reminded_at", sa.DateTime(), nullable=True))
        op.create_index("ix_followups_reminded_at", "followups", ["reminded_at"])
    if not _has_column("followups", "handled_at"):
        op.add_column("followups", sa.Column("handled_at", sa.DateTime(), nullable=True))
    if not _has_column("followups", "handle_note"):
        op.add_column("followups", sa.Column("handle_note", sa.Text(), server_default=""))
    # 带外键的列必须用 batch 模式：SQLite 不支持 ALTER 加约束，batch 会以「复制重建」方式落地 FK，
    # 保证「全新库 create_all」与「存量库迁移」得到结构一致的 schema。
    # batch 复制重建时约束必须有名字，显式给出 FK 名称（与 naming_convention 不冲突）。
    if not _has_column("followups", "handled_by"):
        with op.batch_alter_table("followups") as batch:
            batch.add_column(sa.Column("handled_by", sa.Integer(),
                                       sa.ForeignKey("users.id", name="fk_followups_handled_by_users"),
                                       nullable=True))

    # 5) 通知：处理状态（把「已推送」与「已处理」区分开，供可追踪闭环）
    if not _has_column("notifications", "state"):
        op.add_column("notifications", sa.Column("state", sa.String(16), server_default="pending"))
        op.create_index("ix_notifications_state", "notifications", ["state"])
    if not _has_column("notifications", "handled_at"):
        op.add_column("notifications", sa.Column("handled_at", sa.DateTime(), nullable=True))
    if not _has_column("notifications", "handle_note"):
        op.add_column("notifications", sa.Column("handle_note", sa.Text(), server_default=""))
    if not _has_column("notifications", "handled_by"):
        with op.batch_alter_table("notifications") as batch:
            batch.add_column(sa.Column("handled_by", sa.Integer(),
                                       sa.ForeignKey("users.id",
                                                     name="fk_notifications_handled_by_users"),
                                       nullable=True))

    # 6) 审批时间线
    if not _has_table("approval_records"):
        op.create_table(
            "approval_records",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("kind", sa.String(32), nullable=False),
            sa.Column("ref_id", sa.Integer(), nullable=False),
            sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"),
                      nullable=True),
            sa.Column("action", sa.String(32), server_default=""),
            sa.Column("from_status", sa.String(16), server_default=""),
            sa.Column("to_status", sa.String(16), server_default=""),
            sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("reason", sa.Text(), server_default=""),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_approval_records_kind", "approval_records", ["kind"])
        op.create_index("ix_approval_records_ref_id", "approval_records", ["ref_id"])
        op.create_index("ix_approval_records_project_id", "approval_records", ["project_id"])
        op.create_index("ix_approval_records_created_at", "approval_records", ["created_at"])
        op.create_index("ix_approval_records_ref", "approval_records",
                        ["kind", "ref_id", "id"])

    # ---- 存量回填：让历史单据也有时间线来源，不留「无来源的当前状态」 ----
    bind = op.get_bind()
    if _has_table("approval_records"):
        bind.exec_driver_sql(
            "INSERT INTO approval_records (kind, ref_id, project_id, action, from_status, "
            "to_status, actor_id, reason, created_at) "
            "SELECT 'expense', e.id, e.project_id, "
            "       CASE e.status WHEN 'approved' THEN 'approve' "
            "                      WHEN 'rejected' THEN 'reject' "
            "                      WHEN 'exception' THEN 'exception' ELSE 'submit' END, "
            "       '', e.status, e.approved_by, COALESCE(e.decision_reason, ''), "
            "       COALESCE(e.decided_at, e.created_at) "
            "FROM expenses e "
            "WHERE e.status <> 'pending' AND NOT EXISTS ("
            "  SELECT 1 FROM approval_records r WHERE r.kind='expense' AND r.ref_id=e.id)"
        )
        bind.exec_driver_sql(
            "INSERT INTO approval_records (kind, ref_id, project_id, action, from_status, "
            "to_status, actor_id, reason, created_at) "
            "SELECT 'expense', e.id, e.project_id, 'submit', '', e.status, e.by_id, '', e.created_at "
            "FROM expenses e "
            "WHERE NOT EXISTS (SELECT 1 FROM approval_records r "
            "                  WHERE r.kind='expense' AND r.ref_id=e.id AND r.action='submit')"
        )
        bind.exec_driver_sql(
            "INSERT INTO approval_records (kind, ref_id, project_id, action, from_status, "
            "to_status, actor_id, reason, created_at) "
            "SELECT 'budget_adjust', a.id, a.project_id, "
            "       CASE a.status WHEN 'approved' THEN 'approve' "
            "                      WHEN 'rejected' THEN 'reject' ELSE 'submit' END, "
            "       '', a.status, a.approved_by, COALESCE(a.decision_reason, a.reason, ''), "
            "       COALESCE(a.decided_at, a.created_at) "
            "FROM budget_adjusts a "
            "WHERE NOT EXISTS (SELECT 1 FROM approval_records r "
            "                  WHERE r.kind='budget_adjust' AND r.ref_id=a.id)"
        )
        bind.exec_driver_sql(
            "INSERT INTO approval_records (kind, ref_id, project_id, action, from_status, "
            "to_status, actor_id, reason, created_at) "
            "SELECT 'budget_adjust', a.id, a.project_id, 'submit', '', 'pending', a.by_id, "
            "       COALESCE(a.reason, ''), a.created_at "
            "FROM budget_adjusts a "
            "WHERE NOT EXISTS (SELECT 1 FROM approval_records r "
            "                  WHERE r.kind='budget_adjust' AND r.ref_id=a.id AND r.action='submit')"
        )

    if _has_column("followups", "remind_state"):
        # 无 remind_at 的跟进不参与提醒；已到期的标记为「已通知」，避免重启后被重复灌入
        bind.exec_driver_sql(
            "UPDATE followups SET remind_state = 'none' WHERE remind_at IS NULL"
        )
        bind.exec_driver_sql(
            "UPDATE followups SET remind_state = 'done', reminded_at = remind_at "
            "WHERE remind_at IS NOT NULL AND remind_at <= CURRENT_TIMESTAMP"
        )


def downgrade():
    if _has_table("approval_records"):
        op.drop_table("approval_records")
    for col in ("handle_note", "handled_by", "handled_at", "reminded_at", "remind_state"):
        if _has_column("followups", col):
            op.drop_column("followups", col)
    for col in ("handle_note", "handled_by", "handled_at", "state"):
        if _has_column("notifications", col):
            op.drop_column("notifications", col)
    for col in ("decided_at", "decision_reason"):
        if _has_column("budget_adjusts", col):
            op.drop_column("budget_adjusts", col)
    for col in ("resubmit_count", "decided_at", "decision_reason"):
        if _has_column("expenses", col):
            op.drop_column("expenses", col)
    if _has_column("attachments", "ref_id"):
        op.drop_column("attachments", "ref_id")
    if _has_column("attachments", "ref_type"):
        op.drop_column("attachments", "ref_type")
