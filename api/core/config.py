"""运行配置：密钥、Cookie 和会话有效期。"""
import os
from dataclasses import dataclass
from typing import Literal

DEV_SECRET = "dev-secret-change-me"
TRUE_VALUES = {"1", "true", "yes", "on"}
FALSE_VALUES = {"0", "false", "no", "off"}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    raise RuntimeError(f"{name} 必须是明确的 true/false 值")


@dataclass(frozen=True)
class Settings:
    app_env: str
    secret_key: str
    cookie_secure: bool
    cookie_samesite: Literal["lax", "strict", "none"]
    access_cookie_name: str
    refresh_cookie_name: str
    csrf_cookie_name: str
    session_cookie_name: str
    access_minutes: int
    refresh_days: int


def load_settings() -> Settings:
    app_env = os.getenv("APP_ENV", "development").strip().lower()
    is_local = app_env in {"development", "test"}
    secret = os.getenv("APP_SECRET", "").strip()

    if is_local:
        secret = secret or DEV_SECRET
    else:
        if not secret:
            raise RuntimeError("生产环境必须配置 APP_SECRET")
        if secret == DEV_SECRET:
            raise RuntimeError("生产环境禁止使用开发 APP_SECRET")
        if len(secret) < 32:
            raise RuntimeError("APP_SECRET 至少 32 字符")

    return Settings(
        app_env=app_env,
        secret_key=secret,
        cookie_secure=_env_bool("COOKIE_SECURE", not is_local),
        cookie_samesite="lax",
        access_cookie_name="pm_access_token",
        refresh_cookie_name="pm_refresh_token",
        csrf_cookie_name="pm_csrf_token",
        session_cookie_name="pm_session",
        access_minutes=120,
        refresh_days=7,
    )


settings = load_settings()
