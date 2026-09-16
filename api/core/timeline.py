"""审批时间线（Stage 4A）：支出 / 预算调整 / 立项的状态变化来源与去向。

为什么单独建表而不复用 `audit_logs`：
  · `audit_logs` 是**管理面**接口（`GET /admin/logs` 仅管理员），而「申请人可查的状态变化」
    要求业务当事人（普通项目成员）能看到自己单据的流转；
  · 审计表是「谁对什么做了什么」的全站流水，本表是「某个单据经历了什么」的聚合视图，
    按 `(kind, ref_id)` 索引后可以一次取全，避免申请人侧逐条翻审计日志。

约定：每条记录 = 一次状态变化；`action` 与 `from_status → to_status` 必须同批写入，
`actor_id` 是本次变化的操作人（提交 = 申请人，决策 = 管理员）。
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import ApprovalRecord

KIND_EXPENSE = "expense"
KIND_BUDGET_ADJUST = "budget_adjust"
KIND_PROJECT_FILING = "project_filing"

KINDS = (KIND_EXPENSE, KIND_BUDGET_ADJUST, KIND_PROJECT_FILING)

ACTION_SUBMIT = "submit"
ACTION_RESUBMIT = "resubmit"
ACTION_APPROVE = "approve"
ACTION_REJECT = "reject"
ACTION_EXCEPTION = "exception"
ACTION_AUTO = "auto_approve"   # 审批开关关闭时系统自动生效，非人工审批

ACTION_LABEL = {
    ACTION_SUBMIT: "提交申请",
    ACTION_RESUBMIT: "重新提交",
    ACTION_APPROVE: "审批通过",
    ACTION_REJECT: "审批驳回",
    ACTION_EXCEPTION: "特批放行",
    ACTION_AUTO: "系统自动生效",
}


def record(db: Session, kind: str, ref_id: int, action: str, *,
           from_status: str = "", to_status: str = "", project_id: int | None = None,
           actor_id: int | None = None, reason: str = "") -> ApprovalRecord:
    """写入一条时间线（只 add，不 commit；由调用方与业务变更同一次提交）。"""
    if kind not in KINDS:
        raise ValueError(f"非法时间线类型：{kind}")
    row = ApprovalRecord(
        kind=kind, ref_id=ref_id, project_id=project_id, action=action,
        from_status=from_status or "", to_status=to_status or "",
        actor_id=actor_id, reason=(reason or "")[:2000],
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    return row


def timeline(db: Session, kind: str, ref_id: int) -> list[dict]:
    """按时间正序返回某单据的完整状态变化（申请人视角的「我的申请经历了什么」）。"""
    rows = db.query(ApprovalRecord).filter(
        ApprovalRecord.kind == kind, ApprovalRecord.ref_id == ref_id
    ).order_by(ApprovalRecord.id).all()
    return [{
        "id": r.id,
        "kind": r.kind,
        "ref_id": r.ref_id,
        "project_id": r.project_id,
        "action": r.action,
        "action_label": ACTION_LABEL.get(r.action, r.action),
        "from_status": r.from_status,
        "to_status": r.to_status,
        "actor_id": r.actor_id,
        "reason": r.reason,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]


def last_reason(db: Session, kind: str, ref_id: int) -> str:
    """最近一次决策意见（用于列表里直接展示驳回原因，不必逐单开时间线）。"""
    row = db.query(ApprovalRecord).filter(
        ApprovalRecord.kind == kind, ApprovalRecord.ref_id == ref_id,
        ApprovalRecord.action.in_([ACTION_REJECT, ACTION_EXCEPTION, ACTION_APPROVE,
                                   ACTION_AUTO]),
    ).order_by(ApprovalRecord.id.desc()).first()
    return (row.reason or "") if row else ""
