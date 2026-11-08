"""bcrypt 密码 + JWT（access 8h / refresh 7d）。"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

SECRET_KEY = os.getenv("APP_SECRET", "dev-secret-change-me")
ALGORITHM = "HS256"
ACCESS_MINUTES = 8 * 60
REFRESH_DAYS = 7


def hash_password(raw: str) -> str:
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(raw.encode(), hashed.encode())
    except Exception:
        return False


def _now():
    return datetime.now(timezone.utc)


def _token(
    sub: str,
    session_version: int = 0,
    minutes: int = 0,
    days: int = 0,
    kind: str = "access",
) -> str:
    exp = _now() + (timedelta(days=days) if days else timedelta(minutes=minutes))
    return jwt.encode(
        {
            "sub": sub,
            "kind": kind,
            "jti": uuid.uuid4().hex,
            "session_version": session_version,
            "exp": exp,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def create_access_token(sub: str, session_version: int = 0) -> str:
    return _token(sub, session_version, minutes=ACCESS_MINUTES, kind="access")


def create_refresh_token(sub: str, session_version: int = 0) -> str:
    return _token(sub, session_version, days=REFRESH_DAYS, kind="refresh")


def decode_token(token: str, kind: str = "access") -> dict:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError as e:
        raise ValueError("invalid token") from e
    if payload.get("kind") != kind:
        raise ValueError("wrong token kind")
    return payload
