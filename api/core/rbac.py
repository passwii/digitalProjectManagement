"""RBAC：管理与审批边界（Stage 1 收敛版）。

已确认契约（BLF-1097）：
  · 管理员（admin）是唯一的管理与审批角色，也是唯一拥有全局数据范围的用户：跨部门、跨项目读写。
  · 非管理员不获得任何管理/审批能力：管理、审批、回收站等接口对非管理员稳定返回 403，
    且权限判定先于任何业务读写，拒绝时不会产生业务状态变更。
  · 普通用户仍按「项目负责人 / 项目成员」参与业务（立项、任务、进度填报、跟进、预算/支出登记），
    本轮不收敛该参与路径。
  · 以下角色编码仅作为未来扩展的结构字段保留，当前不参与任何授权判定：
    project_manager / dept_manager / member / cost_admin / executive。
    即不再有「部门隔离」「项目成员授权优先于部门隔离」「高层只读」「成本管理员独立全局权限」规则。
"""
from fastapi import HTTPException

from ..models import Project

ROLE_ADMIN = "admin"            # 系统管理员：唯一管理与审批角色，全局范围
ROLE_PM = "project_manager"     # 保留字段：未来扩展用，当前不授予额外权限
ROLE_DEPT = "dept_manager"      # 保留字段：同上
ROLE_MEMBER = "member"          # 保留字段：同上
ROLE_COST = "cost_admin"        # 保留字段：同上
ROLE_EXEC = "executive"         # 保留字段：同上

RESERVED_ROLES = [ROLE_PM, ROLE_DEPT, ROLE_MEMBER, ROLE_COST, ROLE_EXEC]
ALL_ROLES = [ROLE_ADMIN, *RESERVED_ROLES]


def role_codes(user) -> set:
    return {r.code for r in getattr(user, "roles", []) or []}


def is_admin(user) -> bool:
    return ROLE_ADMIN in role_codes(user)


def can_approve(user) -> bool:
    """审批资格：当前契约下唯一审批人 = 管理员。

    `GET /approvals/pending` 行内的 can_decide 与各决策入口共用本判定，
    保证「列表里能点」与「接口放行」永远一致，不出现按钮可见但接口 403 的错位契约。
    """
    return is_admin(user)


def require_admin(user) -> None:
    """管理/审批统一门禁：非管理员稳定 403（调用点必须在任何业务读写之前）。"""
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可操作")


def member_ids(project) -> set:
    """项目参与人 = 负责人 + 项目成员。普通用户参与业务的唯一依据。"""
    ids = {project.owner_id} if getattr(project, "owner_id", None) else set()
    for m in getattr(project, "members", []) or []:
        ids.add(m.user_id)
    return ids


def can_read_project(user, project, db=None) -> bool:
    """读权限：管理员全局；其他用户仅限自己负责或参与的项目。"""
    if is_admin(user):
        return True
    return user.id in member_ids(project)


def check_project_access(user, project, write: bool = False) -> None:
    """读：可见即可；写：管理员或项目参与人。"""
    if is_admin(user):
        return
    if not can_read_project(user, project):
        raise HTTPException(403, "无权访问该项目")
    if write and user.id not in member_ids(project):
        raise HTTPException(403, "仅项目成员可写")


def visible_project_condition(user):
    """把「可见项目」规则下推为 SQL 条件（避免全表载入后在 Python 过滤）。

    返回 None 表示无需过滤：仅管理员，全局可见（跨部门、跨项目、不限成员）。
    其余用户：负责人 或 项目成员；部门隔离规则已随本次契约收敛取消。
    """
    from sqlalchemy import exists, or_

    from ..models import ProjectMember

    if is_admin(user):
        return None
    return or_(
        Project.owner_id == user.id,
        exists().where((ProjectMember.project_id == Project.id) &
                       (ProjectMember.user_id == user.id)),
    )
