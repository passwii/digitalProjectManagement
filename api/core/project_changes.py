"""项目变更留痕（`project_changes`）：项目字段与业务活动共用的「日志」tab 数据源。

为什么复用本表而不新开表或改 schema：
  · 前端项目详情页「日志」tab 早已消费 `GET /projects/{pid}/changes`，列结构固定
    （`field / old / new / by_id / at`）；此前只有项目字段、负责人 / 成员、状态流转
    会留痕，业务侧（支出、应收、回款）只落在 `audit_logs` 全站流水里，普通项目成员
    看不到。把业务活动也写进本表后，同一页按时间线就能读到完整项目动向；
  · 只需新增 `field` 的业务语义，**不需要任何迁移**。

约定：
  · 业务活动的 `field` 取 `expense / receivable / receivable_payment`，`old` 恒为空；
  · 业务活动的 `new` 是一句**不含类别词**的中文描述，由调用方拼好；
  · 项目简介自动保存会形成连续 old→new 链，写入与读取都按一次编辑会话折叠；
  · 与 `core.timeline` 一致，只 `add` 不 `commit`，由调用方与业务变更同一次提交，
    保证「有业务变化必有留痕」，不会出现业务成功但日志丢失。
"""
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy.orm import Session

from ..models import ProjectChange
from .timeutil import app_now

# 与前端约定的三类业务字段码；`field` 列存字符串，复用既有列，不新增枚举。
FIELD_EXPENSE = "expense"
FIELD_RECEIVABLE = "receivable"
FIELD_RECEIVABLE_PAYMENT = "receivable_payment"

FIELDS = (FIELD_EXPENSE, FIELD_RECEIVABLE, FIELD_RECEIVABLE_PAYMENT)

# 项目简介由文档页自动保存，连续输入会形成 old→new→newer 的链路。
# 同一用户、同一字段且前后保存在该窗口内，视为一次编辑会话。
AUTO_SAVE_FIELD = "description"
AUTO_SAVE_MERGE_WINDOW = timedelta(minutes=30)


@dataclass(frozen=True)
class ProjectChangeEntry:
    id: int | None
    field: str
    old: str
    new: str
    by_id: int | None
    at: datetime | None
    chain_started_at: datetime | None


def _continues_auto_save(
    newer: ProjectChangeEntry,
    older: ProjectChangeEntry,
) -> bool:
    if newer.field != AUTO_SAVE_FIELD or older.field != AUTO_SAVE_FIELD:
        return False
    if newer.by_id != older.by_id or newer.old != older.new:
        return False
    if newer.chain_started_at is None or older.at is None:
        return False
    gap = newer.chain_started_at - older.at
    return timedelta(0) <= gap <= AUTO_SAVE_MERGE_WINDOW


def coalesce_project_changes(rows: Iterable[ProjectChange]) -> list[ProjectChangeEntry]:
    """折叠历史自动保存记录；只改读取视图，不删除原始审计数据。"""
    entries: list[ProjectChangeEntry] = []
    for row in rows:
        current = ProjectChangeEntry(
            id=row.id,
            field=row.field or "",
            old=row.old or "",
            new=row.new or "",
            by_id=row.by_id,
            at=row.at,
            chain_started_at=row.at,
        )
        if entries and _continues_auto_save(entries[-1], current):
            # 输入来自倒序结果：保留最新的 new/at，向前延伸 old。
            entries[-1] = replace(
                entries[-1],
                old=current.old,
                chain_started_at=current.chain_started_at,
            )
        else:
            entries.append(current)
    return entries


def record_project_change(
    db: Session,
    project_id: int,
    field: str,
    new: str,
    *,
    old: str = "",
    user_id: int | None = None,
    at: datetime | None = None,
) -> ProjectChange:
    """写入一条项目变更留痕（只 add，不 commit；由调用方与业务变更同一次提交）。"""
    current_at = at or app_now()
    new = new or ""
    old = old or ""

    if field == AUTO_SAVE_FIELD:
        # SessionLocal 关闭了 autoflush；先让同一请求中更早的字段留痕可见。
        db.flush()
        previous = (
            db.query(ProjectChange)
            .filter_by(project_id=project_id)
            .order_by(ProjectChange.id.desc())
            .first()
        )
        if previous:
            previous_entry = ProjectChangeEntry(
                id=previous.id,
                field=previous.field or "",
                old=previous.old or "",
                new=previous.new or "",
                by_id=previous.by_id,
                at=previous.at,
                chain_started_at=previous.at,
            )
            current_entry = ProjectChangeEntry(
                id=None,
                field=field,
                old=old,
                new=new,
                by_id=user_id,
                at=current_at,
                chain_started_at=current_at,
            )
            if _continues_auto_save(current_entry, previous_entry):
                previous.new = new
                previous.at = current_at
                return previous

    row = ProjectChange(
        project_id=project_id,
        field=field,
        old=old,
        new=new,
        by_id=user_id,
        at=current_at,
    )
    db.add(row)
    return row
