"""Stage 0：登录/登出/刷新/我。5 错锁 15min（sys_params 可配），成功失败都审计。"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.config import settings
from ..core.cookies import (bearer_token_from_request, clear_auth_cookies,
                            set_auth_cookies)
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.security import (create_access_token, create_refresh_token,
                             decode_token, hash_password, verify_password)
from ..models import SysParam, TokenBlacklist, User

router = APIRouter(prefix="/auth", tags=["auth"])


def _param(db: Session, key: str, default: str) -> str:
    p = db.query(SysParam).filter_by(key=key).first()
    return p.value if p else default


class LoginIn(BaseModel):
    username: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str | None = None


class ChangePwdIn(BaseModel):
    old_password: str
    new_password: str


def _fail(db, user, username, ip, reason):
    user.failed_count = (user.failed_count or 0) + 1
    limit = int(_param(db, "login_fail_limit", "5"))
    minutes = int(_param(db, "login_lock_minutes", "15"))
    locked = False
    if user.failed_count >= limit:
        user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
        user.status = "locked"
        locked = True
    db.commit()
    write_audit(db, user.id, "login_fail", "auth", username, reason, ip)
    msg = f"密码错误，已锁定{minutes}分钟" if locked else "用户名或密码错误"
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, msg)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response,
          db: Session = Depends(get_db)):
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
        if user.locked_until and user.locked_until.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc):
            raise HTTPException(403, "账号已锁定，请稍后再试")
        user.status, user.failed_count, user.locked_until = "active", 0, None
        db.commit()
    if not verify_password(body.password, user.pwd_hash):
        raise _fail(db, user, body.username, ip, "密码错误")
    user.failed_count, user.locked_until = 0, None
    db.commit()
    access, refresh = create_access_token(str(user.id)), create_refresh_token(str(user.id))
    set_auth_cookies(response, access, refresh)
    write_audit(db, user.id, "login", "auth", user.username, "登录成功", ip)
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer",
            "must_change_pwd": bool(user.must_change_pwd)}


def _blacklist_token(db: Session, token: str, kind: str, user_id: int) -> None:
    if not token:
        return
    try:
        payload = decode_token(token, kind=kind)
    except ValueError:
        return
    claim = insert(TokenBlacklist).values(
        jti=payload["jti"],
        user_id=user_id,
        expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
    ).on_conflict_do_nothing(index_elements=[TokenBlacklist.jti])
    db.execute(claim)


def _valid_session_user(db: Session, tokens: tuple[tuple[str, str], ...]) -> User | None:
    for token, kind in tokens:
        if not token:
            continue
        try:
            payload = decode_token(token, kind=kind)
            user_id = int(payload["sub"])
        except (KeyError, TypeError, ValueError):
            continue
        if db.query(TokenBlacklist).filter_by(jti=payload.get("jti")).first():
            continue
        user = db.query(User).filter_by(id=user_id).first()
        if user and user.status == "active":
            return user
    return None


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    access = bearer_token_from_request(request)
    if not access:
        access = request.cookies.get(settings.access_cookie_name, "")
    refresh = request.cookies.get(settings.refresh_cookie_name, "")
    user = _valid_session_user(db, ((access, "access"), (refresh, "refresh")))
    if user:
        _blacklist_token(db, access, "access", user.id)
        _blacklist_token(db, refresh, "refresh", user.id)
        db.commit()
        write_audit(db, user.id, "logout", "auth", user.username, "登出",
                    request.client.host if request.client else "")
    clear_auth_cookies(response)
    return {"ok": True}


@router.post("/refresh")
def refresh(request: Request, response: Response, body: RefreshIn | None = None,
            db: Session = Depends(get_db)):
    token = body.refresh_token if body and body.refresh_token else ""
    if not token:
        token = request.cookies.get(settings.refresh_cookie_name, "")
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh 已过期")
    try:
        payload = decode_token(token, kind="refresh")
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh 已过期")
    user = db.query(User).filter_by(id=int(payload["sub"])).first()
    if not user or user.status != "active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不可用")

    claim = insert(TokenBlacklist).values(
        jti=payload["jti"],
        user_id=user.id,
        expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
    ).on_conflict_do_nothing(index_elements=[TokenBlacklist.jti])
    try:
        if db.execute(claim).rowcount != 1:
            db.rollback()
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "会话已失效")
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "会话已失效")

    access = create_access_token(str(user.id))
    rotated = create_refresh_token(str(user.id))
    db.commit()

    set_auth_cookies(response, access, rotated)
    return {
        "access_token": access,
        "refresh_token": rotated,
        "token_type": "bearer",
    }


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
