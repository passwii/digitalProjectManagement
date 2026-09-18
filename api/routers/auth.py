"""Stage 0：登录/登出/刷新/我。5 错锁 15min（sys_params 可配），成功失败都审计。"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from ..core.timeutil import app_now, app_now_aware, as_app, from_timestamp
from ..models import SysParam, TokenBlacklist, User

router = APIRouter(prefix="/auth", tags=["auth"])


def _param(db: Session, key: str, default: str) -> str:
    p = db.query(SysParam).filter_by(key=key).first()
    return p.value if p else default


class LoginIn(BaseModel):
    username: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class ChangePwdIn(BaseModel):
    old_password: str
    new_password: str


def _fail(db, user, username, ip, reason):
    user.failed_count = (user.failed_count or 0) + 1
    limit = int(_param(db, "login_fail_limit", "5"))
    minutes = int(_param(db, "login_lock_minutes", "15"))
    locked = False
    if user.failed_count >= limit:
        # 列约定是「北京时间 naive 墙钟」（core/timeutil.py）：写 naive、读 aware，
        # 否则 PG 会按会话时区再折一次，配置 15 分钟实际锁 8 小时 15 分（BLF-1138）。
        user.locked_until = app_now() + timedelta(minutes=minutes)
        user.status = "locked"
        locked = True
    db.commit()
    write_audit(db, user.id, "login_fail", "auth", username, reason, ip)
    msg = f"密码错误，已锁定{minutes}分钟" if locked else "用户名或密码错误"
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, msg)


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else ""
    if not body.username or not body.password:
        raise HTTPException(400, "账号密码不能为空")
    user: User | None = db.query(User).filter_by(username=body.username).first()
    if not user:
        write_audit(db, None, "login_fail", "auth", body.username, "用户不存在", ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")  # 不提示是否存在
    if user.status == "disabled":
        raise HTTPException(403, "账号已停用")
    if user.status == "locked":
        if user.locked_until and as_app(user.locked_until) > app_now_aware():
            raise HTTPException(403, "账号已锁定，请稍后再试")
        user.status, user.failed_count, user.locked_until = "active", 0, None
        db.commit()
    if not verify_password(body.password, user.pwd_hash):
        raise _fail(db, user, body.username, ip, "密码错误")
    user.failed_count, user.locked_until = 0, None
    db.commit()
    access, refresh = create_access_token(str(user.id)), create_refresh_token(str(user.id))
    write_audit(db, user.id, "login", "auth", user.username, "登录成功", ip)
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer",
            "must_change_pwd": bool(user.must_change_pwd)}


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    try:
        payload = decode_token(token, kind="access")
        db.add(TokenBlacklist(jti=payload["jti"], user_id=user.id,
                              expires_at=from_timestamp(payload["exp"])))
        db.commit()
    except Exception:
        pass
    write_audit(db, user.id, "logout", "auth", user.username, "登出",
                request.client.host if request.client else "")
    return {"ok": True}


@router.post("/refresh")
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    try:
        payload = decode_token(body.refresh_token, kind="refresh")
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh 已过期")
    if db.query(TokenBlacklist).filter_by(jti=payload.get("jti")).first():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "会话已失效")
    user = db.query(User).filter_by(id=int(payload["sub"])).first()
    if not user or user.status != "active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不可用")
    return {"access_token": create_access_token(str(user.id)), "token_type": "bearer"}


@router.post("/change-password")
def change_password(body: ChangePwdIn, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """自助改密（首次登录强制改密用）。≥8 位且含字母与数字。"""
    if not verify_password(body.old_password, user.pwd_hash):
        raise HTTPException(400, "原密码不正确")
    np = body.new_password or ""
    if len(np) < 8 or not any(c.isalpha() for c in np) or not any(c.isdigit() for c in np):
        raise HTTPException(400, "新密码至少 8 位且需同时包含字母与数字")
    if np == body.old_password:
        raise HTTPException(400, "新密码不能与原密码相同")
    user.pwd_hash = hash_password(np)
    user.must_change_pwd = False
    user.failed_count, user.locked_until = 0, None
    db.commit()
    write_audit(db, user.id, "change_password", "auth", user.username, "改密成功",
                request.client.host if request.client else "")
    return {"ok": True}


@router.get("/me")
def me(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username, "real_name": user.real_name,
            "status": user.status, "dept_id": user.dept_id,
            "roles": [{"code": r.code, "name": r.name} for r in user.roles],
            "must_change_pwd": bool(user.must_change_pwd)}
