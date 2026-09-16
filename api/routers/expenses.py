"""支出登记 + 审批/驳回/特批/重新提交（Stage 4A 补齐闭环）。

权限契约（Stage 1 收敛）：审批、驳回、特批、重提决策只能由管理员执行（先鉴权，非管理员稳定 403）；
普通用户仍可按项目参与登记支出（需为项目负责人/成员）。

Stage 4A 补齐的闭环：
  1. **凭证附件**：`POST /expenses/{id}/vouchers` 上传凭证（可多个），
     `GET /expenses/{id}/vouchers` 列出（申请人可查自己单据的凭证），
     `GET /expenses/{id}/vouchers/{aid}/download` 下载（校验支出可见性）；
  2. **驳回后可重新提交**：`POST /expenses/{id}/resubmit` —— 只允许申请人在「已驳回」状态下重提，
     可同时修正金额/科目/说明并追加凭证，重提后回到 pending 并累加 `resubmit_count`；
  3. **审批意见**：`decision_reason` + `decided_at` 落在支出行上，列表直接可见驳回原因；
  4. **申请人可查的时间线**：`GET /expenses/{id}/timeline`（非管理员也能读自己单据的流转）。
"""
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.costs import budget_total, execution, spent
from ..core.database import ROOT, get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (can_read_project, get_active_project, is_admin, require_admin,
                         scope_child_query)
from ..core.timeline import (ACTION_APPROVE, ACTION_EXCEPTION, ACTION_REJECT,
                             ACTION_RESUBMIT, ACTION_SUBMIT, KIND_EXPENSE, timeline)
from ..core.validation import check_amount, check_choice
from ..models import Attachment, Expense, Project, SysParam, User

router = APIRouter(prefix="/expenses", tags=["expenses"])

PEOPLE = {"张爱杰", "张玉军", "段佳奕", "段佳雷", "李智",
          "朱成龙", "张涛", "田孝通", "李润康", "薛凡"}
# `subject` 为兼容既有表结构的稳定存储字段；当前业务语义已调整为「支出人员」。
# 仍接受历史科目值，确保存量单据可编辑、重提与审计不中断。
SUBJECTS = PEOPLE | {"人工", "采购", "外包", "差旅", "其他"}
VOUCHER_EXT = {".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"}
VOUCHER_MAX_SIZE = 20 * 1024 * 1024

# 排序白名单（Stage 3A）：字段名 → ORM 列
EXPENSE_SORTS = {
    "id": Expense.id, "project_id": Expense.project_id, "subject": Expense.subject,
    "amount": Expense.amount, "exp_date": Expense.exp_date,
    "status": Expense.status, "by_id": Expense.by_id,
    "created_at": Expense.created_at,
}


def _e(e: Expense):
    return {"id": e.id, "project_id": e.project_id, "subject": e.subject,
            "amount": e.amount, "exp_date": e.exp_date.isoformat() if e.exp_date else None,
            "note": e.note, "status": e.status, "by_id": e.by_id,
            "approved_by": e.approved_by,
            "decision_reason": e.decision_reason or "",
            "decided_at": e.decided_at.isoformat() if e.decided_at else None,
            "resubmit_count": e.resubmit_count or 0,
            "can_resubmit": e.status == "rejected"}


def _over(db: Session, project_id: int, subject: str, extra: float) -> bool:
    b = budget_total(db, project_id, subject)
    return bool(b) and (spent(db, project_id, subject) + extra > b)


def _voucher(a: Attachment):
    return {"id": a.id, "filename": a.filename, "size": a.size,
            "content_type": a.content_type, "uploaded_by": a.uploaded_by,
            "uploaded_at": a.uploaded_at.isoformat() if a.uploaded_at else None}


def _expense(db: Session, eid: int) -> Expense:
    e = db.query(Expense).filter_by(id=eid).first()
    if not e:
        raise HTTPException(404, "支出不存在")
    return e


def _expense_for_read(db: Session, eid: int, user: User) -> Expense:
    """读边界：支出所属项目须「未软删除 + 当前用户可见」。"""
    e = _expense(db, eid)
    p = get_active_project(db, e.project_id, user)  # 软删除/演示隐藏/越权统一 404 或 403
    if not can_read_project(user, p):
        raise HTTPException(403, "无权访问该支出")
    return e


def _check_date(exp_date: date | None, project: Project) -> None:
    """支出日期下限 = 项目计划开始；上限允许预支（不超过今天 + 1 年，拦住年份误录）。

    不禁止未来日期：预支差旅、预付采购是真实场景。只做项目区间与「明显笔误」两道卡。
    """
    if exp_date is None:
        return
    if project.plan_start and exp_date < project.plan_start:
        raise HTTPException(400, "支出日期不能早于项目计划开始")
    if exp_date > date.today() + timedelta(days=366):
        raise HTTPException(400, "支出日期超出合理范围（距今超过 1 年），请核对")


class ExpenseIn(BaseModel):
    project_id: int
    subject: str = ""
    amount: float
    exp_date: date | None = None
    note: str = ""


def _prepare(body_subject: str, amount, project: Project, exp_date: date | None) -> tuple[str, float]:
    subject = str(body_subject or "").strip()
    if subject:
        check_choice(subject, SUBJECTS, field="科目")
    amt = check_amount(amount, field="支出金额")
    _check_date(exp_date, project)
    return subject, amt


@router.get("")
def list_expenses(project_id: int = 0, status: str = "", subject: str = "",
                  keyword: str = "", date_from: str = "", date_to: str = "",
                  mine: int = 0, sort: str = "-id", page: int = 1,
                  size: int = DEFAULT_PAGE_SIZE,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """支出列表：统一分页信封（默认 `-id` 最新在前）+ 排序白名单 + 组合筛选。

    指定 project_id 时按该项目鉴权；否则只返回「可见 + 未软删除」项目的支出（下推 SQL）。
    `mine=1` 只返回当前用户经办的支出，方便申请人查自己单据的驳回原因与状态。
    """
    q = db.query(Expense)
    if project_id:
        get_active_project(db, project_id, user)
        q = q.filter(Expense.project_id == project_id)
    else:
        q = scope_child_query(q, Expense, db, user)
    if status:
        q = q.filter(Expense.status == status)
    if subject:
        q = q.filter(Expense.subject == subject)
    if mine:
        q = q.filter(Expense.by_id == user.id)
    if keyword:
        q = q.filter(Expense.note.like(f"%{keyword}%"))
    df, dt = parse_date(date_from or None), parse_date(date_to or None)
    if df:
        q = q.filter((Expense.exp_date.is_(None)) | (Expense.exp_date >= df))
    if dt:
        q = q.filter((Expense.exp_date.is_(None)) | (Expense.exp_date <= dt))
    return paginate(q, page=page, size=size, allowed=EXPENSE_SORTS,
                    default_sort="-id", sort=sort, map_row=_e)


@router.post("")
def create_expense(body: ExpenseIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """登记支出：科目/金额/日期全部先校验；审批开关开启或超预算时转 pending。"""
    p = get_active_project(db, body.project_id, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    subject, amount = _prepare(body.subject, body.amount, p, body.exp_date)

    on = db.query(SysParam).filter_by(key="expense_approval_on").first()
    approval_on = bool(on and on.value == "1")
    over = _over(db, body.project_id, subject, amount)
    if over and not approval_on:
        raise HTTPException(400, "超预算已拦截：请调预算或走特批")
    st = "pending" if (approval_on or over) else "approved"
    now = datetime.now(timezone.utc)
    e = Expense(project_id=body.project_id, subject=subject, amount=amount,
                exp_date=body.exp_date, note=body.note, status=st, by_id=user.id,
                decided_at=now if st == "approved" else None,
                decision_reason="" if st == "approved" else "",
                created_at=now, resubmit_count=0)
    db.add(e)
    db.flush()
    from ..core.timeline import record as record_timeline
    record_timeline(db, KIND_EXPENSE, e.id, ACTION_SUBMIT, from_status="", to_status=st,
                    project_id=p.id, actor_id=user.id,
                    reason="超预算待审批" if over else "")
    if st == "pending":
        # 待审批：通知审批人（当前契约下唯一审批人 = 管理员）
        from ..core.notify import approval_recipients, push_many
        push_many(db, approval_recipients(db), "approval",
                  f"支出待审批：{subject} {amount} 元",
                  f"项目 {p.name}｜{body.note or '无说明'}"
                  + ("｜超预算需特批" if over else ""),
                  ref_type="expense", ref_id=e.id, project_id=p.id,
                  dedup_key=f"expense-request:{e.id}")
    # 业务行 + 时间线 + 通知 + 审计同一次提交，不存在「已落库但无留痕」
    commit_audited(db, user.id, "create_expense", "expenses", e.id, f"{amount} {st}")
    ex = execution(db, body.project_id, subject)
    r = _e(e)
    r["execution"] = ex  # 返回实时执行率；warn=True 即 80% 提醒
    r["over_budget"] = over
    return r


@router.get("/{eid}/timeline")
def expense_timeline(eid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """单据时间线：申请人（非管理员）与管理员都能看到自己可见支出经历的状态变化。"""
    e = _expense_for_read(db, eid, user)
    return {"id": e.id, "status": e.status, "decision_reason": e.decision_reason or "",
            "decided_at": e.decided_at.isoformat() if e.decided_at else None,
            "items": timeline(db, KIND_EXPENSE, eid)}


@router.post("/{eid}/resubmit")
def resubmit(eid: int, body: dict, db: Session = Depends(get_db),
             user: User = Depends(get_current_user)):
    """驳回后重新提交（仅申请人本人或管理员）。

    只允许从「已驳回」回到待审批；可同时修正科目/金额/日期/说明。
    重提后 `resubmit_count` +1，并追加一条 resubmit 时间线 —— 驳回原因保留在历史里，不被覆盖。
    """
    e = _expense(db, eid)
    p = get_active_project(db, e.project_id, user, write=True)
    if e.status != "rejected":
        raise HTTPException(400, f"仅「已驳回」的支出可重新提交，当前为 {e.status}")
    if not is_admin(user) and e.by_id != user.id:
        raise HTTPException(403, "仅申请人本人可重新提交")
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")

    subject = str(body.get("subject", e.subject) or "").strip()
    if subject:
        check_choice(subject, SUBJECTS, field="科目")
    amount = check_amount(body.get("amount", e.amount), field="支出金额")
    exp_date = parse_date(body["exp_date"]) if "exp_date" in body else e.exp_date
    _check_date(exp_date, p)

    on = db.query(SysParam).filter_by(key="expense_approval_on").first()
    approval_on = bool(on and on.value == "1")
    over = _over(db, e.project_id, subject, amount)
    if over and not approval_on:
        raise HTTPException(400, "超预算已拦截：请调预算或走特批")
    to = "pending" if (approval_on or over) else "approved"

    previous_reason = e.decision_reason or ""
    old_status = e.status
    e.subject, e.amount, e.exp_date = subject, amount, exp_date
    e.note = str(body.get("note", e.note) or "")
    e.status = to
    e.resubmit_count = (e.resubmit_count or 0) + 1
    e.approved_by = None
    e.decided_at = datetime.now(timezone.utc)
    e.decision_reason = ""

    from ..core.timeline import record as record_timeline
    record_timeline(db, KIND_EXPENSE, e.id, ACTION_RESUBMIT, from_status=old_status,
                    to_status=to, project_id=e.project_id, actor_id=user.id,
                    reason=str(body.get("reason", "") or "") or
                           (f"修正后重新提交（原驳回意见：{previous_reason}）"
                            if previous_reason else "修正后重新提交"))
    if to == "pending":
        from ..core.notify import approval_recipients, push_many
        push_many(db, approval_recipients(db), "approval",
                  f"支出重新提交待审批：{subject} {amount} 元",
                  f"项目 {p.name}｜第 {e.resubmit_count} 次提交"
                  + (f"｜原驳回意见：{previous_reason}" if previous_reason else ""),
                  ref_type="expense", ref_id=e.id, project_id=p.id,
                  dedup_key=f"expense-resubmit:{e.id}:{e.resubmit_count}")
    commit_audited(db, user.id, "resubmit_expense", "expenses", eid,
                   f"{old_status}->{to} amount={amount} count={e.resubmit_count}")
    r = _e(e)
    r["execution"] = execution(db, e.project_id, subject)
    return r


@router.post("/{eid}/vouchers")
def upload_voucher(eid: int, file: UploadFile = File(...), db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """上传支出凭证：项目可写者（申请人）即可，附件与支出强关联。"""
    e = _expense(db, eid)
    p = get_active_project(db, e.project_id, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VOUCHER_EXT:
        raise HTTPException(400, f"凭证仅允许 {sorted(VOUCHER_EXT)}")
    data = file.file.read()
    if not data:
        raise HTTPException(400, "凭证文件为空")
    if len(data) > VOUCHER_MAX_SIZE:
        raise HTTPException(400, "单文件最大 20MB")
    d = ROOT / "data" / "files" / f"expense_{eid}"
    d.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename or f"voucher{ext}").name
    fp = d / f"{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{safe_name}"
    fp.write_bytes(data)
    a = Attachment(project_id=e.project_id, filename=safe_name, path=str(fp),
                   size=len(data), content_type=file.content_type or "",
                   uploaded_by=user.id, uploaded_at=datetime.now(timezone.utc),
                   ref_type="expense", ref_id=eid)
    db.add(a)
    db.flush()
    commit_audited(db, user.id, "upload_expense_voucher", "attachments", a.id, safe_name)
    return _voucher(a)


@router.get("/{eid}/vouchers")
def list_vouchers(eid: int, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """支出凭证列表（申请人可查自己单据的凭证）。"""
    _expense_for_read(db, eid, user)
    rows = db.query(Attachment).filter_by(ref_type="expense", ref_id=eid) \
        .order_by(Attachment.id).all()
    return [_voucher(a) for a in rows]


@router.get("/{eid}/vouchers/{aid}/download")
def download_voucher(eid: int, aid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """凭证下载：校验支出可见性 + 附件归属，防越权取件。"""
    from urllib.parse import quote

    _expense_for_read(db, eid, user)
    a = db.query(Attachment).filter_by(id=aid, ref_type="expense", ref_id=eid).first()
    if not a:
        raise HTTPException(404, "凭证不存在")
    fp = Path(a.path)
    if not fp.exists():
        raise HTTPException(404, "凭证文件已丢失，请联系管理员")
    write_audit(db, user.id, "download_expense_voucher", "attachments", a.id, a.filename)
    return FileResponse(
        fp, media_type=a.content_type or "application/octet-stream", filename=a.filename,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(a.filename)}"})


@router.delete("/{eid}/vouchers/{aid}")
def delete_voucher(eid: int, aid: int, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """删除凭证：上传者本人或管理员（待审批阶段可更换凭证）。"""
    e = _expense(db, eid)
    get_active_project(db, e.project_id, user, write=True)
    a = db.query(Attachment).filter_by(id=aid, ref_type="expense", ref_id=eid).first()
    if not a:
        raise HTTPException(404, "凭证不存在")
    if a.uploaded_by != user.id and not is_admin(user):
        raise HTTPException(403, "仅上传者或管理员可删除凭证")
    try:
        Path(a.path).unlink(missing_ok=True)
    except OSError:
        pass
    name = a.filename
    db.delete(a)
    commit_audited(db, user.id, "delete_expense_voucher", "attachments", aid, name)
    return {"ok": True}


def _decide(db: Session, e: Expense, user: User, action: str, reason: str,
            to_status: str, audit_action: str) -> Expense:
    """决策收口：状态 + 意见 + 时间 + 时间线 + 审计一次提交。"""
    from ..core.timeline import record as record_timeline

    old = e.status
    e.status = to_status
    e.approved_by = user.id
    e.decision_reason = reason or ""
    e.decided_at = datetime.now(timezone.utc)
    record_timeline(db, KIND_EXPENSE, e.id, action, from_status=old, to_status=to_status,
                    project_id=e.project_id, actor_id=user.id, reason=reason)
    commit_audited(db, user.id, audit_action, "expenses", e.id,
                   f"{old}->{to_status} {reason}")
    return e


def _notify_applicant(db: Session, e: Expense, action: str, reason: str) -> None:
    """决策结果通知申请人（带可定位引用；驳回/特批时把意见原样带给申请人）。"""
    from ..core.notify import push

    push(db, e.by_id, "approval",
         f"支出{action}：{e.subject} {e.amount}",
         reason or f"当前状态：{e.status}",
         ref_type="expense", ref_id=e.id, project_id=e.project_id,
         dedup_key=f"expense-decided:{e.id}:{e.status}:{e.resubmit_count or 0}")
    db.commit()


@router.post("/{eid}/approve")
def approve(eid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """支出通过（仅管理员）。超预算时须先调预算或走特批。"""
    require_admin(user)
    e = _expense(db, eid)
    if e.status != "pending":
        raise HTTPException(400, "支出不在待审批状态")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    if _over(db, e.project_id, e.subject, e.amount):
        raise HTTPException(400, "超预算：通过前请先调预算或走特批")
    _decide(db, e, user, ACTION_APPROVE, "", "approved", "approve_expense")
    _notify_applicant(db, e, "已通过", "审批通过，金额已计入预算执行")
    return _e(e)


@router.post("/{eid}/reject")
def reject(eid: int, body: dict, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    """支出驳回（仅管理员）。驳回意见必填且对申请人可见，申请人可修改后重新提交。"""
    require_admin(user)
    e = _expense(db, eid)
    if e.status != "pending":
        raise HTTPException(400, "支出不在待审批状态")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    reason = str(body.get("reason", "") or "").strip()
    if not reason:
        raise HTTPException(400, "驳回必须填写意见")
    _decide(db, e, user, ACTION_REJECT, reason, "rejected", "reject_expense")
    _notify_applicant(db, e, "已驳回", reason)
    return _e(e)


@router.post("/{eid}/exception")
def exception(eid: int, body: dict, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """特批放行超预算支出（仅管理员）。仅「待审批 / 已驳回」可特批，意见必填。"""
    require_admin(user)
    e = _expense(db, eid)
    if e.status not in ("pending", "rejected"):
        raise HTTPException(400, f"仅待审批/已驳回可特批，当前为 {e.status}")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    reason = str(body.get("reason", "") or "").strip()
    if not reason:
        raise HTTPException(400, "特批必须填写理由")
    _decide(db, e, user, ACTION_EXCEPTION, reason, "exception", "exception_expense")
    _notify_applicant(db, e, "特批放行", reason)
    return _e(e)
