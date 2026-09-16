"""运行配置：密钥、Cookie 和会话有效期。"""
import os
from dataclasses import dataclass
from typing import Literal

DEV_SECRET = "dev-secret-change-me"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    app_env: str
    secret_key: str
    cookie_secure: bool
    cookie_samesite: Literal["lax", "strict", "none"]
    access_cookie_name: str
    refresh_cookie_name: str
    csrf_cookie_name: str
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
        if len(secret) < 32:
            raise RuntimeError("APP_SECRET 至少 32 字符")
        if secret == DEV_SECRET:
            raise RuntimeError("生产环境禁止使用开发 APP_SECRET")

    return Settings(
        app_env=app_env,
        secret_key=secret,
        cookie_secure=_env_bool("COOKIE_SECURE", not is_local),
        cookie_samesite="lax",
        access_cookie_name="pm_access_token",
        refresh_cookie_name="pm_refresh_token",
        csrf_cookie_name="pm_csrf_token",
        access_minutes=120,
        refresh_days=7,
    )


settings = load_settings()
