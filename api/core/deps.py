"""登录态依赖：未登录一律 401。"""
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .database import get_db
from .security import decode_token

bearer = HTTPBearer(auto_error=False)


def _unauth(msg="未登录"):
    return HTTPException(status.HTTP_401_UNAUTHORIZED, msg)


def get_current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
):
    from ..models import TokenBlacklist, User

    if cred is None or not cred.credentials:
        raise _unauth("未登录")

    try:
        payload = decode_token(cred.credentials, kind="access")
    except ValueError:
        raise _unauth("登录已过期")
    if db.query(TokenBlacklist).filter_by(jti=payload.get("jti")).first():
        raise _unauth("会话已失效")
    user = db.query(User).filter_by(id=int(payload["sub"])).first()
    if not user:
        raise _unauth("用户不存在")
    if user.status != "active":
        raise _unauth("账号不可用")
    return user
