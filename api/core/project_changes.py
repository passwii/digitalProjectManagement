"""项目变更留痕（`project_changes`）：把成本 / 应收 / 回款活动也写进项目「日志」tab。

为什么复用本表而不新开表或改 schema：
  · 前端项目详情页「日志」tab 早已消费 `GET /projects/{pid}/changes`，列结构固定
    （`field / old / new / by_id / at`）；此前只有项目字段、负责人 / 成员、状态流转
    会留痕，业务侧（支出、应收、回款）只落在 `audit_logs` 全站流水里，普通项目成员
    看不到。把业务活动也写进本表后，同一页按时间线就能读到完整项目动向；
  · 只需新增 `field` 的业务语义，**不需要任何迁移**。

约定：
  · `field` 取下面三个业务字段码之一（前端据此补「成本 / 应收 / 回款」类别词）；
  · `old` 恒为空串（业务活动是事件，没有「旧值」）；
  · `new` 是一句**不含类别词**的中文描述，由调用方拼好；
  · 与 `core.timeline` 一致，只 `add` 不 `commit`，由调用方与业务变更同一次提交，
    保证「有业务变化必有留痕」，不会出现业务成功但日志丢失。
"""
from sqlalchemy.orm import Session

from ..models import ProjectChange
from .timeutil import app_now

# 与前端约定的三类业务字段码；`field` 列存字符串，复用既有列，不新增枚举。
FIELD_EXPENSE = "expense"
FIELD_RECEIVABLE = "receivable"
FIELD_RECEIVABLE_PAYMENT = "receivable_payment"

FIELDS = (FIELD_EXPENSE, FIELD_RECEIVABLE, FIELD_RECEIVABLE_PAYMENT)


def record_project_change(
    db: Session,
    project_id: int,
    field: str,
    new: str,
    *,
    old: str = "",
    user_id: int | None = None,
) -> ProjectChange:
    """写入一条项目变更留痕（只 add，不 commit；由调用方与业务变更同一次提交）。"""
    row = ProjectChange(
        project_id=project_id,
        field=field,
        old=old or "",
        new=new or "",
        by_id=user_id,
        at=app_now(),
    )
    db.add(row)
    return row
