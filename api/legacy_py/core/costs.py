"""成本口径（报表与页面共用同一 service）：已支出=已通过Σ，余额=预算-已支出，执行率=已支出/预算。"""
from sqlalchemy.orm import Session

from ..models import Budget, Expense, SysParam

PASS = ("approved", "exception")


def spent(db: Session, project_id: int, subject: str = "") -> float:
    q = db.query(Expense).filter(Expense.project_id == project_id, Expense.status.in_(PASS))
    if subject:
        q = q.filter_by(subject=subject)
    return sum(e.amount or 0 for e in q.all())


def budget_total(db: Session, project_id: int, subject: str = "") -> float:
    q = db.query(Budget).filter_by(project_id=project_id)
    if subject:
        q = q.filter_by(subject=subject)
    return sum(b.amount or 0 for b in q.all())


def warn_rate(db: Session) -> float:
    p = db.query(SysParam).filter_by(key="budget_warn_rate").first()
    return float(p.value) if p else 0.8


def execution(db: Session, project_id: int, subject: str = "") -> dict:
    b, s = budget_total(db, project_id, subject), spent(db, project_id, subject)
    rate = round(s / b, 4) if b else 0
    return {"budget": b, "spent": s, "balance": round(b - s, 2),
            "rate": rate, "warn": bool(b and rate >= warn_rate(db)),
            "over": bool(b and s > b)}
