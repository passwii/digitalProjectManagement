"""全表模型。"""
from datetime import datetime, timezone
from sqlalchemy import (Boolean, Column, Date, DateTime, Float, ForeignKey, Index,
                        Integer, String, Text)
from sqlalchemy.orm import relationship

from ..core.database import Base


def _now():
    return datetime.now(timezone.utc)


class Department(Base):
    __tablename__ = "departments"
    id = Column(Integer, primary_key=True)
    name = Column(String(64), unique=True, nullable=False)
    parent_id = Column(Integer, ForeignKey("departments.id"), nullable=True)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    pwd_hash = Column(String(255), nullable=False)
    real_name = Column(String(64), default="")
    status = Column(String(16), default="active")  # active/locked/disabled
    dept_id = Column(Integer, ForeignKey("departments.id"), nullable=True)
    failed_count = Column(Integer, default=0)
    locked_until = Column(DateTime, nullable=True)
    must_change_pwd = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_now)
    roles = relationship("Role", secondary="user_roles", back_populates="users")


class Role(Base):
    __tablename__ = "roles"
    id = Column(Integer, primary_key=True)
    code = Column(String(32), unique=True, nullable=False)
    name = Column(String(64), nullable=False)
    users = relationship("User", secondary="user_roles", back_populates="roles")


class UserRole(Base):
    __tablename__ = "user_roles"
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role_id = Column(Integer, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True)
    code = Column(String(32), unique=True, nullable=False, index=True)  # PJ-2026-0001 或用户录入编号
    name = Column(String(128), unique=True, nullable=False)
    type = Column(String(32), default="")
    dept_id = Column(Integer, ForeignKey("departments.id"), nullable=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    owner_name = Column(String(64), default="")
    plan_start = Column(Date, nullable=True)
    plan_end = Column(Date, nullable=True)
    budget_total = Column(Float, default=0)
    priority = Column(String(16), default="中")
    client = Column(String(128), default="")
    description = Column(Text, default="")
    contract_status = Column(String(16), default="")  # 已签订 / 未签订
    forward_contract = Column(String(128), default="")  # 前向合同（甲方）
    backward_contract = Column(String(128), default="")  # 后向合同（乙方）
    status = Column(String(16), default="draft", index=True)
    # draft草稿/filed已立项/doing进行中/paused暂停/done已完成/archived已归档/cancelled已取消
    progress = Column(Float, default=0)
    deleted_at = Column(DateTime, nullable=True, index=True)  # 软删除（Stage 2）
    # 演示数据标记：由 scripts/seed_mock.py 写入；受系统参数 demo_data_on 控制是否显示
    is_demo = Column(Boolean, default=False, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")


class ProjectMember(Base):
    __tablename__ = "project_members"
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    project = relationship("Project", back_populates="members")


class ProjectChange(Base):
    __tablename__ = "project_changes"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    field = Column(String(64), default="")
    old = Column(Text, default="")
    new = Column(Text, default="")
    by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    at = Column(DateTime, default=_now)


class Attachment(Base):
    __tablename__ = "attachments"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    filename = Column(String(255), default="")
    path = Column(String(512), default="")
    size = Column(Integer, default=0)
    content_type = Column(String(128), default="")
    uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    uploaded_at = Column(DateTime, default=_now)
    # 归属对象（Stage 4A）：空 = 项目级附件；ref_type="expense" + ref_id = 支出凭证
    ref_type = Column(String(32), default="")
    ref_id = Column(Integer, nullable=True)
    __table_args__ = (Index("ix_attachments_ref", "ref_type", "ref_id"),)


class Followup(Base):
    __tablename__ = "followups"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    happened_at = Column(DateTime, default=_now)
    method = Column(String(32), default="")
    content = Column(Text, default="")
    next_step = Column(Text, default="")
    remind_at = Column(DateTime, nullable=True, index=True)
    created_at = Column(DateTime, default=_now)
    # 跟进提醒的可追踪状态（Stage 4A）：pending 待处理 / done 已处理 / dismissed 已忽略
    remind_state = Column(String(16), default="pending", index=True)
    reminded_at = Column(DateTime, nullable=True, index=True)
    handled_at = Column(DateTime, nullable=True)
    handled_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    handle_note = Column(Text, default="")


class Milestone(Base):
    __tablename__ = "milestones"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name = Column(String(128), nullable=False)
    plan_date = Column(Date, nullable=True)
    actual_date = Column(Date, nullable=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    status = Column(String(16), default="open")  # open/closed
    created_at = Column(DateTime, default=_now)
    __table_args__ = (Index("ix_milestones_proj_status", "project_id", "status"),)


class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    parent_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
    level = Column(Integer, default=1)
    name = Column(String(128), nullable=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    plan_start = Column(Date, nullable=True)
    plan_end = Column(Date, nullable=True)
    weight = Column(Float, default=1)
    progress = Column(Float, default=0)
    status = Column(String(16), default="todo", index=True)  # todo/doing/done/paused
    predecessor_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (Index("ix_tasks_proj_status", "project_id", "status"),)


class ProgressLog(Base):
    __tablename__ = "progress_logs"
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    progress = Column(Float, default=0)
    note = Column(Text, default="")
    remaining_days = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_now)
    __table_args__ = (Index("ix_logs_proj_created", "project_id", "created_at"),)


class Budget(Base):
    __tablename__ = "budgets"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    subject = Column(String(32), nullable=False)  # 人工/采购/外包/差旅/其他
    amount = Column(Float, nullable=False, default=0)
    period_start = Column(Date, nullable=True)
    period_end = Column(Date, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)
    __table_args__ = (Index("ix_budgets_proj_subject", "project_id", "subject"),)


class BudgetAdjust(Base):
    __tablename__ = "budget_adjusts"
    id = Column(Integer, primary_key=True)
    budget_id = Column(Integer, ForeignKey("budgets.id", ondelete="CASCADE"))
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"))
    old_amount = Column(Float, default=0)
    new_amount = Column(Float, default=0)
    reason = Column(Text, default="")
    status = Column(String(16), default="pending")  # pending/approved/rejected
    by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    # 审批意见与决策时间（Stage 4A）：申请人可查的状态变化来源
    decision_reason = Column(Text, default="")
    decided_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)


class Expense(Base):
    __tablename__ = "expenses"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    subject = Column(String(32), default="")
    amount = Column(Float, nullable=False)
    exp_date = Column(Date, nullable=True)
    note = Column(Text, default="")
    status = Column(String(16), default="approved", index=True)
    # approved已通过/pending待审批/rejected已驳回/exception特批通过
    by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    # 审批意见与决策时间（Stage 4A）：驳回原因对申请人可见，重新提交后清空
    decision_reason = Column(Text, default="")
    decided_at = Column(DateTime, nullable=True)
    resubmit_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=_now)
    __table_args__ = (Index("ix_expenses_proj_subject", "project_id", "subject"),
                      Index("ix_expenses_proj_status", "project_id", "status"))


class ApprovalRecord(Base):
    """审批时间线（Stage 4A）：支出 / 预算调整 / 立项的统一状态变化留痕。

    每条记录 = 一次状态变化（提交、重提、通过、驳回、特批），带申请人、决策人、意见与时间，
    使「申请人可查的状态变化」不依赖审计日志（审计面向管理员，本表面向业务当事人）。
    """
    __tablename__ = "approval_records"
    id = Column(Integer, primary_key=True)
    kind = Column(String(32), nullable=False, index=True)   # expense/budget_adjust/project_filing
    ref_id = Column(Integer, nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    action = Column(String(32), default="")                 # submit/resubmit/approve/reject/exception
    from_status = Column(String(16), default="")
    to_status = Column(String(16), default="")
    actor_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    reason = Column(Text, default="")
    created_at = Column(DateTime, default=_now, index=True)
    __table_args__ = (Index("ix_approval_records_ref", "kind", "ref_id", "id"),)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    action = Column(String(64), index=True)
    resource = Column(String(64), default="")
    resource_id = Column(String(64), default="")
    detail = Column(Text, default="")
    ip = Column(String(64), default="")
    created_at = Column(DateTime, default=_now, index=True)


class SysParam(Base):
    __tablename__ = "sys_params"
    id = Column(Integer, primary_key=True)
    key = Column(String(64), unique=True, nullable=False)
    value = Column(String(255), default="")
    desc = Column(String(255), default="")


class Dict(Base):
    __tablename__ = "dicts"
    id = Column(Integer, primary_key=True)
    type = Column(String(32), index=True)
    code = Column(String(32))
    label = Column(String(64))
    sort = Column(Integer, default=0)


class TokenBlacklist(Base):
    __tablename__ = "token_blacklist"
    id = Column(Integer, primary_key=True)
    jti = Column(String(64), unique=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)


class Notification(Base):
    """站内通知（Stage 3）：预警/审批/提醒统一落库，支持已读与历史。"""
    __tablename__ = "notifications"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    type = Column(String(32), index=True)          # overdue_task/milestone/stagnant/budget/followup/approval/expense
    title = Column(String(128), default="")
    body = Column(Text, default="")
    channel = Column(String(16), default="inapp")  # inapp（预留 email/wecom）
    ref_type = Column(String(32), default="")      # project/task/milestone/expense/budget_adjust
    ref_id = Column(Integer, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    dedup_key = Column(String(128), index=True)    # 去重：同 key 同日不重复推送
    read_at = Column(DateTime, nullable=True, index=True)
    # 处理状态（Stage 4A）：pending 待处理 / done 已处理 / ignored 已忽略
    state = Column(String(16), default="pending", index=True)
    handled_at = Column(DateTime, nullable=True)
    handled_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    handle_note = Column(Text, default="")
    created_at = Column(DateTime, default=_now, index=True)
    __table_args__ = (Index("ix_notif_user_read", "user_id", "read_at"),)
