"""认证 Cookie 与 CSRF 双提交校验。"""
import secrets
from urllib.parse import urlsplit

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
    response.set_cookie(
        settings.session_cookie_name,
        "1",
        max_age=settings.refresh_days * 24 * 60 * 60,
        path="/",
        httponly=True,
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
    response.delete_cookie(
        settings.session_cookie_name,
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
    has_cookie_session = bool(
        request.cookies.get(settings.access_cookie_name)
        or request.cookies.get(settings.refresh_cookie_name)
    )
    return has_cookie_session and not bearer_token_from_request(request)


def csrf_header_valid(request: Request) -> bool:
    cookie = request.cookies.get(settings.csrf_cookie_name, "")
    header = request.headers.get("x-csrf-token", "")
    return bool(cookie and header) and secrets.compare_digest(cookie, header)


def same_origin_or_same_site_request(request: Request) -> bool:
    """允许同站浏览器请求与无来源元数据的旧客户端，拒绝明确的跨站请求。"""
    fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
    if fetch_site == "cross-site":
        return False
    if fetch_site in {"same-origin", "same-site"}:
        return True

    origin = request.headers.get("origin", "").strip()
    if not origin:
        return True
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    request_host = request.headers.get("host", request.url.netloc).strip().lower()
    return (
        parsed.scheme.lower() in {"http", "https"}
        and bool(parsed.netloc)
        and parsed.netloc.lower() == request_host
    )
