"""认证 Cookie 与 CSRF 双提交校验。"""
import secrets

from fastapi import Request, Response

from .config import settings

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
REFRESH_PATH = "/api/v1/auth"


def set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> str:
    csrf_token = secrets.token_urlsafe(32)
    common = {
        "secure": settings.cookie_secure,
        "samesite": settings.cookie_samesite,
    }
    response.set_cookie(
        settings.access_cookie_name,
        access_token,
        max_age=settings.access_minutes * 60,
        path="/",
        httponly=True,
        **common,
    )
    response.set_cookie(
        settings.refresh_cookie_name,
        refresh_token,
        max_age=settings.refresh_days * 24 * 60 * 60,
        path=REFRESH_PATH,
        httponly=True,
        **common,
    )
    response.set_cookie(
        settings.csrf_cookie_name,
        csrf_token,
        max_age=settings.refresh_days * 24 * 60 * 60,
        path="/",
        httponly=False,
        **common,
    )
    return csrf_token


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(
        settings.access_cookie_name,
        path="/",
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )
    response.delete_cookie(
        settings.refresh_cookie_name,
        path=REFRESH_PATH,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )
    response.delete_cookie(
        settings.csrf_cookie_name,
        path="/",
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )


def bearer_token_from_request(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return token.strip()


def request_uses_cookie_auth(request: Request) -> bool:
    return bool(request.cookies.get(settings.access_cookie_name)) and not bearer_token_from_request(request)


def csrf_header_valid(request: Request) -> bool:
    cookie = request.cookies.get(settings.csrf_cookie_name, "")
    header = request.headers.get("x-csrf-token", "")
    return bool(cookie and header) and secrets.compare_digest(cookie, header)
