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
    code = Column(String(32), unique=True, nullable=False, index=True)  # PJ-2026-0001
    name = Column(String(128), unique=True, nullable=False)
    type = Column(String(32), default="")
    dept_id = Column(Integer, ForeignKey("departments.id"), nullable=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    plan_start = Column(Date, nullable=True)
    plan_end = Column(Date, nullable=True)
    budget_total = Column(Float, default=0)
    priority = Column(String(16), default="中")
    client = Column(String(128), default="")
    description = Column(Text, default="")
    status = Column(String(16), default="draft", index=True)
    # draft草稿/filed已立项/doing进行中/paused暂停/done已完成/archived已归档/cancelled已取消
    progress = Column(Float, default=0)
    deleted_at = Column(DateTime, nullable=True, index=True)  # 软删除（Stage 2）
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
    created_at = Column(DateTime, default=_now)
    __table_args__ = (Index("ix_expenses_proj_subject", "project_id", "subject"),
                      Index("ix_expenses_proj_status", "project_id", "status"))


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
    created_at = Column(DateTime, default=_now, index=True)
    __table_args__ = (Index("ix_notif_user_read", "user_id", "read_at"),)
