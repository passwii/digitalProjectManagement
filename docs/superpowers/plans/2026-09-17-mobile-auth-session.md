# 手机端认证与会话移动化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将登录、首次改密和会话传输迁移到移动优先的认证界面与 httpOnly Cookie，同时保留 Bearer 兼容期，为后续移动壳和 PWA 提供安全会话基础。

**Architecture:** 后端新增统一的运行配置和 Cookie 工具，登录写入 httpOnly access/refresh Cookie，非 httpOnly 的 CSRF Cookie 配合写请求头校验；刷新时轮换 refresh token。前端请求统一携带凭据和 CSRF 头，不再把 token 写入 localStorage；登录与首次改密使用独立的 `MobileAuthShell`，桌面视觉保持简化后的同一表单实现。

**Tech Stack:** Python 3.12、FastAPI、SQLAlchemy、Pytest、Next.js 14、React 18、TypeScript、CSS Modules。

**Spec:** `docs/superpowers/specs/2026-09-17-mobile-pwa-upgrade-design.md`

## Global Constraints

- 生产环境必须提供至少 32 字符的 `APP_SECRET`，缺失或使用开发默认值时拒绝启动。
- 手机认证页覆盖 `375px`、`390px`、`412px`，输入字号至少 `16px`，控件高度至少 `48px`。
- access/refresh token 不得写入 `localStorage`、`sessionStorage` 或 JavaScript 可读 Cookie。
- access Cookie 使用 `HttpOnly`、`Secure`（生产）、`SameSite=Lax`，refresh Cookie 额外限制 Path 为 `/api/v1/auth`。
- 所有 Cookie 认证的写请求必须携带与 `pm_csrf_token` 匹配的 `X-CSRF-Token`。
- 现有 Bearer 调用在迁移期继续可用，避免一次性破坏 pytest 和已有消费者。
- 不修改现有权限、项目可见性、审批状态机或业务接口返回结构。
- 每个任务完成后单独提交，不把工作区已有的未提交业务改动加入提交。

## 计划拆分

本文件是手机端与 PWA 升级的第 1 份实施计划，只交付认证与会话移动化。后续独立计划按以下顺序创建和执行：

1. 手机壳、底部导航与 PWA 基础。
2. 首页、项目和跨项目工作中心。
3. 成本、审批和全部业务表单。
4. 报表、系统管理和高级表格。
5. 最近页面只读离线与完整发布加固。

## 文件结构

**新建**

- `api/core/config.py`：运行环境、JWT 密钥、Cookie 名称与安全属性。
- `api/core/cookies.py`：认证 Cookie 的写入、清理和 CSRF 校验。
- `tests/test_security_config.py`：生产配置拒绝不安全密钥的单元测试。
- `web/components/auth/MobileAuthShell.tsx`：登录与首次改密的移动认证壳。
- `web/components/auth/MobileAuthShell.module.css`：认证壳、表单、错误和键盘适配样式。
- `web/components/auth/PasswordInput.tsx`：带显示/隐藏按钮的密码输入。
- `web/components/auth/PasswordInput.module.css`：密码输入与图标按钮样式。

**修改**

- `api/core/security.py`：从统一配置读取签名密钥。
- `api/core/deps.py`：同时接受 Bearer 和 access Cookie。
- `api/routers/auth.py`：登录写 Cookie、刷新轮换、退出清理 Cookie。
- `api/main.py`：注册 CSRF 防护中间件。
- `tests/test_mvp.py`：补充 Cookie、CSRF、refresh 轮换回归测试。
- `web/lib/api.ts`：Cookie 凭据、CSRF 头、401 自动刷新、移除 localStorage token。
- `web/app/login/page.tsx`：改用 `MobileAuthShell` 和 `PasswordInput`。
- `web/app/login/login.module.css`：删除固定桌面卡片布局，改为认证移动壳所需的最小样式。
- `web/app/change-password/page.tsx`：改用认证移动壳、字段级错误和密码输入组件。

---

### Task 1: 生产配置与 JWT 密钥加固

**Files:**

- Create: `api/core/config.py`
- Modify: `api/core/security.py`
- Test: `tests/test_security_config.py`

**Interfaces:**

- Consumes: 环境变量 `APP_ENV`、`APP_SECRET`、`COOKIE_SECURE`。
- Produces:
  - `Settings` 数据类，字段为 `app_env: str`、`secret_key: str`、`cookie_secure: bool`、`cookie_samesite: str`、`access_cookie_name: str`、`refresh_cookie_name: str`、`csrf_cookie_name: str`、`access_minutes: int`、`refresh_days: int`。
  - `load_settings() -> Settings`。
  - 模块级 `settings: Settings`。
  - `api.core.security.SECRET_KEY: str` 继续存在，供现有导入使用。

- [ ] **Step 1: 写失败的配置测试**

将以下内容写入 `tests/test_security_config.py`：

```python
import pytest

from api.core.config import load_settings


def test_development_uses_local_defaults(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.delenv("APP_SECRET", raising=False)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)

    settings = load_settings()

    assert settings.app_env == "development"
    assert settings.secret_key == "dev-secret-change-me"
    assert settings.cookie_secure is False
    assert settings.access_cookie_name == "pm_access_token"
    assert settings.refresh_cookie_name == "pm_refresh_token"
    assert settings.csrf_cookie_name == "pm_csrf_token"


def test_production_rejects_missing_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("APP_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="APP_SECRET"):
        load_settings()


def test_production_rejects_short_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "too-short")

    with pytest.raises(RuntimeError, match="至少 32"):
        load_settings()


def test_production_enables_secure_cookie(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "x" * 32)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)

    settings = load_settings()

    assert settings.cookie_secure is True


def test_cookie_secure_can_be_overridden_for_staging_http(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "x" * 32)
    monkeypatch.setenv("COOKIE_SECURE", "0")

    settings = load_settings()

    assert settings.cookie_secure is False
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
python3 -m pytest tests/test_security_config.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'api.core.config'`。

- [ ] **Step 3: 实现配置模块**

创建 `api/core/config.py`：

```python
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
```

- [ ] **Step 4: 修改 JWT 模块读取配置**

将 `api/core/security.py` 顶部改为：

```python
"""bcrypt 密码 + JWT（access 2h / refresh 7d）。"""
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from .config import settings

SECRET_KEY = settings.secret_key
ALGORITHM = "HS256"
ACCESS_MINUTES = settings.access_minutes
REFRESH_DAYS = settings.refresh_days
```

保留现有 `hash_password`、`verify_password`、`_now`、`_token`、`create_access_token`、`create_refresh_token` 和 `decode_token` 的其余实现。

- [ ] **Step 5: 运行配置与现有认证测试**

Run:

```bash
python3 -m pytest tests/test_security_config.py tests/test_mvp.py::test_login_me -q
```

Expected: `6 passed`。

- [ ] **Step 6: 提交**

```bash
git add api/core/config.py api/core/security.py tests/test_security_config.py
git commit -m "feat(auth): 加固运行配置与 JWT 密钥"
```

---

### Task 2: Cookie 登录、读取与 CSRF 防护

**Files:**

- Create: `api/core/cookies.py`
- Modify: `api/core/deps.py`
- Modify: `api/routers/auth.py`
- Modify: `api/main.py`
- Test: `tests/test_mvp.py`

**Interfaces:**

- Consumes: `api.core.config.settings`、`create_access_token()`、`create_refresh_token()`、`decode_token()`。
- Produces:
  - `set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> str`，返回本次 CSRF token。
  - `clear_auth_cookies(response: Response) -> None`。
  - `request_uses_cookie_auth(request: Request) -> bool`。
  - `csrf_header_valid(request: Request) -> bool`。
  - `get_current_user()` 同时接受 Bearer 和 `pm_access_token` Cookie。

- [ ] **Step 1: 写失败的 Cookie 与 CSRF 测试**

将以下测试追加到 `tests/test_mvp.py` 末尾：

```python
# 38. Cookie 登录：access/refresh 为 HttpOnly，CSRF 可由前端读取
def test_cookie_login_sets_secure_session_shape(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    assert r.status_code == 200, r.text

    cookies = r.headers.get_list("set-cookie")
    access = next(c for c in cookies if c.startswith("pm_access_token="))
    refresh = next(c for c in cookies if c.startswith("pm_refresh_token="))
    csrf = next(c for c in cookies if c.startswith("pm_csrf_token="))
    assert "HttpOnly" in access
    assert "HttpOnly" in refresh
    assert "HttpOnly" not in csrf
    assert "SameSite=lax" in access
    assert "Path=/api/v1/auth" in refresh

    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "admin"


# 39. Cookie 写请求缺少 CSRF 必须 403，带对 token 成功
def test_cookie_write_requires_csrf(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    assert r.status_code == 200
    refresh = client.cookies.get("pm_refresh_token")

    denied = client.post("/api/v1/auth/logout", json={})
    assert denied.status_code == 403

    csrf = client.cookies.get("pm_csrf_token")
    allowed = client.post("/api/v1/auth/logout", json={},
                          headers={"X-CSRF-Token": csrf})
    assert allowed.status_code == 200

    replay = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
    assert replay.status_code == 401


# 40. Bearer 兼容期不要求 CSRF
def test_bearer_write_remains_compatible(client):
    login = client.post("/api/v1/auth/login",
                        json={"username": "admin", "password": "admin123456"})
    token = login.json()["access_token"]
    client.cookies.clear()

    r = client.post("/api/v1/auth/logout", json={},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
python3 -m pytest \
  tests/test_mvp.py::test_cookie_login_sets_secure_session_shape \
  tests/test_mvp.py::test_cookie_write_requires_csrf \
  tests/test_mvp.py::test_bearer_write_remains_compatible -q
```

Expected: Cookie 测试失败，因为登录尚未写 Cookie，Cookie 请求也尚未作为认证来源。

- [ ] **Step 3: 实现 Cookie 工具**

创建 `api/core/cookies.py`：

```python
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


def request_uses_cookie_auth(request: Request) -> bool:
    has_bearer = request.headers.get("authorization", "").lower().startswith("bearer ")
    return bool(request.cookies.get(settings.access_cookie_name)) and not has_bearer


def csrf_header_valid(request: Request) -> bool:
    cookie = request.cookies.get(settings.csrf_cookie_name, "")
    header = request.headers.get("x-csrf-token", "")
    return bool(cookie and header) and secrets.compare_digest(cookie, header)
```

- [ ] **Step 4: 让登录写 Cookie，退出清 Cookie**

在 `api/routers/auth.py` 中：

1. 从 FastAPI 导入 `Request` 和 `Response`：

```python
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
```

2. 增加 Cookie 工具导入：

```python
from ..core.cookies import clear_auth_cookies, set_auth_cookies
```

3. 将登录签名改为：

```python
@router.post("/login")
def login(body: LoginIn, request: Request, response: Response,
          db: Session = Depends(get_db)):
```

4. 在登录成功创建 token 后写入 Cookie：

```python
    access, refresh = create_access_token(str(user.id)), create_refresh_token(str(user.id))
    set_auth_cookies(response, access, refresh)
    write_audit(db, user.id, "login", "auth", user.username, "登录成功", ip)
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer",
            "must_change_pwd": bool(user.must_change_pwd)}
```

5. 将退出签名改为：

```python
@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
```

6. 在 `_fail()` 之后加入 token 拉黑辅助函数：

```python
def _blacklist_token(db: Session, token: str, kind: str, user_id: int) -> None:
    if not token:
        return
    try:
        payload = decode_token(token, kind=kind)
    except ValueError:
        return
    db.add(TokenBlacklist(
        jti=payload["jti"],
        user_id=user_id,
        expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
    ))
```

7. 将退出接口主体替换为：

```python
@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    auth = request.headers.get("authorization", "")
    access = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not access:
        access = request.cookies.get(settings.access_cookie_name, "")
    refresh = request.cookies.get(settings.refresh_cookie_name, "")
    _blacklist_token(db, access, "access", user.id)
    _blacklist_token(db, refresh, "refresh", user.id)
    db.commit()
    write_audit(db, user.id, "logout", "auth", user.username, "登出",
                request.client.host if request.client else "")
    clear_auth_cookies(response)
    return {"ok": True}
```

8. 确保 `api/routers/auth.py` 已导入：

```python
from ..core.config import settings
```

- [ ] **Step 5: 让鉴权依赖读取 Cookie**

将 `api/core/deps.py` 改为：

```python
"""登录态依赖：Bearer 或 access Cookie，未登录一律 401。"""
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .security import decode_token

bearer = HTTPBearer(auto_error=False)


def _unauth(msg="未登录"):
    return HTTPException(status.HTTP_401_UNAUTHORIZED, msg)


def get_current_user(
    request: Request,
    cred: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
):
    from ..models import TokenBlacklist, User

    token = cred.credentials if cred and cred.credentials else request.cookies.get(
        settings.access_cookie_name
    )
    if not token:
        raise _unauth("未登录")

    try:
        payload = decode_token(token, kind="access")
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
```

- [ ] **Step 6: 注册 CSRF 中间件**

在 `api/main.py` 的 CORS 注册之后加入：

```python
from fastapi import Request
from fastapi.responses import JSONResponse

from .core.cookies import UNSAFE_METHODS, csrf_header_valid, request_uses_cookie_auth

CSRF_EXEMPT_PATHS = {"/api/v1/auth/login"}


@app.middleware("http")
async def csrf_protect(request: Request, call_next):
    is_api_write = (
        request.method in UNSAFE_METHODS
        and request.url.path.startswith("/api/v1/")
        and request.url.path not in CSRF_EXEMPT_PATHS
    )
    if is_api_write and request_uses_cookie_auth(request) and not csrf_header_valid(request):
        return JSONResponse({"detail": "CSRF 校验失败"}, status_code=403)
    return await call_next(request)
```

- [ ] **Step 7: 运行 Cookie、CSRF 和既有回归测试**

Run:

```bash
python3 -m pytest \
  tests/test_mvp.py::test_cookie_login_sets_secure_session_shape \
  tests/test_mvp.py::test_cookie_write_requires_csrf \
  tests/test_mvp.py::test_bearer_write_remains_compatible \
  tests/test_mvp.py::test_login_me \
  tests/test_mvp.py::test_unauth_401 -q
```

Expected: `5 passed`。

- [ ] **Step 8: 提交**

```bash
git add api/core/cookies.py api/core/deps.py api/routers/auth.py api/main.py tests/test_mvp.py
git commit -m "feat(auth): 支持 Cookie 会话与 CSRF 防护"
```

---

### Task 3: Refresh Token 轮换与重放拦截

**Files:**

- Modify: `api/routers/auth.py`
- Test: `tests/test_mvp.py`

**Interfaces:**

- Consumes: `set_auth_cookies()`、`clear_auth_cookies()`、`create_access_token()`、`create_refresh_token()`、`TokenBlacklist`。
- Produces: `POST /api/v1/auth/refresh` 同时接受请求体 `refresh_token` 和 refresh Cookie，成功时轮换 access/refresh 并返回两个 token；旧 refresh token 立即失效。

- [ ] **Step 1: 写失败的 refresh 轮换测试**

将以下测试追加到 `tests/test_mvp.py` 末尾：

```python
# 41. refresh 轮换：Cookie 刷新后旧 token 重放返回 401
def test_refresh_rotates_and_rejects_replay(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    assert r.status_code == 200
    old_refresh = client.cookies.get("pm_refresh_token")
    csrf = client.cookies.get("pm_csrf_token")

    refreshed = client.post("/api/v1/auth/refresh",
                            headers={"X-CSRF-Token": csrf})
    assert refreshed.status_code == 200, refreshed.text
    new_refresh = client.cookies.get("pm_refresh_token")
    assert new_refresh and new_refresh != old_refresh
    csrf = client.cookies.get("pm_csrf_token")

    replay = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": old_refresh},
        headers={"X-CSRF-Token": csrf},
    )
    assert replay.status_code == 401


# 42. Bearer 客户端可用请求体 refresh token，不依赖 Cookie
def test_refresh_body_token_supports_legacy_client(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    refresh = r.json()["refresh_token"]
    client.cookies.clear()

    refreshed = client.post("/api/v1/auth/refresh",
                            json={"refresh_token": refresh})
    assert refreshed.status_code == 200
    assert refreshed.json()["access_token"]
    assert refreshed.json()["refresh_token"]
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
python3 -m pytest \
  tests/test_mvp.py::test_refresh_rotates_and_rejects_replay \
  tests/test_mvp.py::test_refresh_body_token_supports_legacy_client -q
```

Expected: 第一条测试失败，因为旧 refresh token 不会被轮换或拉黑。

- [ ] **Step 3: 实现 refresh 轮换**

将 `api/routers/auth.py` 的请求模型改为：

```python
class RefreshIn(BaseModel):
    refresh_token: str | None = None
```

将 refresh 接口替换为：

```python
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
    if db.query(TokenBlacklist).filter_by(jti=payload.get("jti")).first():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "会话已失效")
    user = db.query(User).filter_by(id=int(payload["sub"])).first()
    if not user or user.status != "active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不可用")

    db.add(TokenBlacklist(
        jti=payload["jti"],
        user_id=user.id,
        expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
    ))
    access = create_access_token(str(user.id))
    rotated = create_refresh_token(str(user.id))
    db.commit()

    set_auth_cookies(response, access, rotated)
    return {
        "access_token": access,
        "refresh_token": rotated,
        "token_type": "bearer",
    }
```

在 `api/routers/auth.py` 增加：

```python
from ..core.config import settings
```

- [ ] **Step 4: 运行 refresh 和认证回归**

Run:

```bash
python3 -m pytest \
  tests/test_mvp.py::test_refresh_rotates_and_rejects_replay \
  tests/test_mvp.py::test_refresh_body_token_supports_legacy_client \
  tests/test_mvp.py::test_cookie_login_sets_secure_session_shape \
  tests/test_mvp.py::test_cookie_write_requires_csrf -q
```

Expected: `4 passed`。

- [ ] **Step 5: 提交**

```bash
git add api/routers/auth.py tests/test_mvp.py
git commit -m "feat(auth): 轮换并吊销 refresh token"
```

---

### Task 4: 前端 Cookie 传输、CSRF 与自动刷新

**Files:**

- Modify: `web/lib/api.ts`
- Verify: `web/app/login/page.tsx`
- Verify: `web/app/change-password/page.tsx`
- Verify: `web/app/(dashboard)/layout.tsx`

**Interfaces:**

- Consumes: 后端 `pm_access_token`、`pm_refresh_token`、`pm_csrf_token` Cookie 契约。
- Produces:
  - `request<T>()` 使用 `credentials: "include"`。
  - 非 GET/HEAD 请求自动附带 `X-CSRF-Token`。
  - access 401 时只执行一次 `/auth/refresh` 并重试原请求。
  - `saveSession()` 只清理旧版 localStorage token。
  - `clearSession()` 清理旧版 token 并跳转登录。

- [ ] **Step 1: 写浏览器失败验收脚本**

创建临时检查文件 `/tmp/auth-cookie-check.txt`，内容如下：

```text
1. 登录后 localStorage 中没有 pm_access_token 和 pm_refresh_token。
2. document.cookie 中没有 pm_access_token 和 pm_refresh_token。
3. document.cookie 中有 pm_csrf_token。
4. 登录后刷新页面仍停留 dashboard。
5. 退出后访问 /dashboard 自动回到 /login。
```

在浏览器开发者工具中执行以下表达式：

```javascript
({
  accessLocal: localStorage.getItem("pm_access_token"),
  refreshLocal: localStorage.getItem("pm_refresh_token"),
  accessCookie: document.cookie.includes("pm_access_token="),
  refreshCookie: document.cookie.includes("pm_refresh_token="),
  csrfCookie: document.cookie.includes("pm_csrf_token="),
})
```

Expected before implementation: `accessLocal` 和 `refreshLocal` 仍有值。

- [ ] **Step 2: 替换 api.ts 的会话常量与辅助函数**

将 `web/lib/api.ts` 顶部替换为：

```typescript
// API 封装：Cookie 凭据 + CSRF + 401 单飞刷新。字段与后端 api/routers/*.py 对齐。
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8001/api/v1";

export class UnauthorizedError extends Error {}
export class NetworkError extends Error {}

const LEGACY_TOKEN_KEY = "pm_access_token";
const LEGACY_REFRESH_KEY = "pm_refresh_token";
const CSRF_COOKIE = "pm_csrf_token";
const CSRF_HEADER = "X-CSRF-Token";

export function getToken(): string | null {
  return null;
}

export function saveSession(_access?: string, _refresh?: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

/** 只读取非 HttpOnly 的 CSRF Cookie。 */
function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return "";
}

function csrfHeaders(method: string): Record<string, string> {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return {};
  const token = readCookie(CSRF_COOKIE);
  return token ? { [CSRF_HEADER]: token } : {};
}

/** 会话失效后的登录页跳转目标：站内固定路径，不接受任何外部输入 */
const LOGIN_PATH = "/login";

export function clearSession() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_REFRESH_KEY);
  }
  if (typeof window === "undefined") return;
  if (window.location.pathname === LOGIN_PATH) return;
  window.location.assign(
    new URL(LOGIN_PATH, window.location.origin).toString(),
  );
}
```

- [ ] **Step 3: 实现单飞 refresh 和请求重试**

在 `web/lib/api.ts` 的 `clearSession()` 之后加入：

```typescript
let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders("POST"),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}
```

将 `request()` 替换为：

```typescript
async function request<T>(
  path: string,
  init: RequestInit = {},
  raw = false,
  retry = true,
): Promise<T> {
  const method = init.method ?? "GET";
  const isForm = init.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isForm ? {} : { "Content-Type": "application/json" }),
    ...csrfHeaders(method),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    throw new NetworkError("无法连接后端");
  }

  const authEndpoint = path === "/auth/login" || path === "/auth/refresh";
  if (res.status === 401 && retry && !authEndpoint) {
    if (await refreshSession()) return request<T>(path, init, raw, false);
    clearSession();
    throw new UnauthorizedError("未登录或会话已过期");
  }
  if (res.status === 401) {
    clearSession();
    throw new UnauthorizedError("未登录或会话已过期");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`API 返回了非 JSON 响应：${text.slice(0, 120)}`);
  }
}
```

保留后面的 `apiGet`、`apiPost`、`apiPut`、`apiPatch`、`apiDelete`、`apiUpload` 和 `downloadFile` 实现。

- [ ] **Step 4: 运行 TypeScript 与生产构建**

Run:

```bash
cd web
npm run build
```

Expected: `Compiled successfully`，没有 `localStorage.setItem` 会话写入和 TypeScript 错误。

- [ ] **Step 5: 浏览器验证**

启动后端和前端后，依次执行：

```bash
cd api
PYTHONPATH=.. uvicorn api.main:app --port 8001
```

另开终端：

```bash
cd web
npm run dev -- --port 3001
```

浏览器执行第 1 步的检查表达式。Expected:

```json
{
  "accessLocal": null,
  "refreshLocal": null,
  "accessCookie": false,
  "refreshCookie": false,
  "csrfCookie": true
}
```

- [ ] **Step 6: 提交**

```bash
git add web/lib/api.ts
git commit -m "feat(web): 使用 Cookie 与 CSRF 会话"
```

---

### Task 5: 手机登录与首次改密界面

**Files:**

- Create: `web/components/auth/MobileAuthShell.tsx`
- Create: `web/components/auth/MobileAuthShell.module.css`
- Create: `web/components/auth/PasswordInput.tsx`
- Create: `web/components/auth/PasswordInput.module.css`
- Modify: `web/app/login/page.tsx`
- Modify: `web/app/login/login.module.css`
- Modify: `web/app/change-password/page.tsx`

**Interfaces:**

- Consumes: `authApi.login()`、`authApi.changePassword()`、`errText()`、`saveSession()`、`clearSession()`。
- Produces:
  - `<MobileAuthShell title subtitle children footer>`。
  - `<PasswordInput label value onChange autoComplete error hint disabled />`。
  - 登录和首次改密页面在手机宽度下使用 `100dvh`、安全区、不小于 `48px` 控件和至少 `16px` 输入字号。

- [ ] **Step 1: 建立浏览器验收清单**

在浏览器打开 `/login`，设置视口为 `375 × 667`，执行：

```javascript
({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  usernameFont: getComputedStyle(document.querySelector('input[autocomplete="username"]')).fontSize,
  passwordFont: getComputedStyle(document.querySelector('input[autocomplete="current-password"]')).fontSize,
  submitHeight: document.querySelector('button[type="submit"]').getBoundingClientRect().height,
})
```

Expected before implementation:

- `scrollWidth` 等于 `clientWidth`。
- 输入字号为 `14px`，低于要求。
- 提交按钮高度小于 `48px`。

- [ ] **Step 2: 创建认证移动壳**

创建 `web/components/auth/MobileAuthShell.tsx`：

```tsx
import type { ReactNode } from "react";
import st from "./MobileAuthShell.module.css";

export default function MobileAuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className={st.page}>
      <section className={st.shell} aria-labelledby="auth-title">
        <header className={st.header}>
          <div className={st.brand}>
            <span className={st.dot} aria-hidden="true" />
            <span>项目管理工作区</span>
          </div>
          <h1 id="auth-title">{title}</h1>
          <p>{subtitle}</p>
        </header>
        <div className={st.form}>{children}</div>
        {footer ? <footer className={st.footer}>{footer}</footer> : null}
      </section>
    </main>
  );
}
```

创建 `web/components/auth/MobileAuthShell.module.css`：

```css
.page {
  min-height: 100vh;
  min-height: 100dvh;
  padding:
    max(20px, env(safe-area-inset-top))
    max(20px, env(safe-area-inset-right))
    max(20px, env(safe-area-inset-bottom))
    max(20px, env(safe-area-inset-left));
  display: flex;
  justify-content: center;
  background: var(--bg);
}
.shell {
  width: 100%;
  max-width: 420px;
  min-height: calc(100dvh - 40px);
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.header { margin-bottom: 24px; }
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 22px;
  color: var(--ink);
  font-size: 14px;
  font-weight: 700;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--brand);
}
.header h1 {
  margin: 0 0 6px;
  color: var(--ink);
  font-size: 24px;
  line-height: 1.25;
}
.header p {
  margin: 0;
  color: var(--ink-2);
  font-size: 14px;
}
.form {
  padding: 20px;
  border: 1px solid var(--line);
  border-top: 3px solid var(--brand);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-card);
}
.form :global(input) { height: 48px; font-size: 16px; }
.form :global(.btn-primary) {
  width: 100%;
  height: 48px;
  line-height: 46px;
  font-size: 15px;
}
.footer {
  margin-top: 18px;
  color: var(--ink-3);
  text-align: center;
  font-size: 12px;
}
@media (max-width: 767px) {
  .page { padding-left: 20px; padding-right: 20px; }
  .shell {
    min-height: 0;
    padding-top: clamp(24px, 8dvh, 72px);
    justify-content: flex-start;
  }
  .header h1 { font-size: 22px; }
}
@media (max-width: 767px) and (orientation: landscape) {
  .shell { padding-top: 16px; }
  .header { margin-bottom: 16px; }
}
```

- [ ] **Step 3: 创建密码输入组件**

创建 `web/components/auth/PasswordInput.tsx`：

```tsx
"use client";

import { useId, useState } from "react";
import st from "./PasswordInput.module.css";

export default function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  error?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className={st.control}>
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          enterKeyHint={autoComplete === "current-password" ? "go" : "next"}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className={st.toggle}
          aria-label={visible ? `隐藏${label}` : `显示${label}`}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? "隐藏" : "显示"}
        </button>
      </div>
      {error ? (
        <span id={`${id}-error`} className="field-err" role="alert">{error}</span>
      ) : hint ? (
        <span id={`${id}-hint`} className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}
```

创建 `web/components/auth/PasswordInput.module.css`：

```css
.control {
  position: relative;
}
.control input {
  padding-right: 64px;
}
.toggle {
  position: absolute;
  top: 50%;
  right: 6px;
  min-width: 52px;
  height: 44px;
  padding: 0 8px;
  transform: translateY(-50%);
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--brand);
  font-size: 13px;
  font-weight: 600;
}
.toggle:hover {
  background: var(--brand-soft);
}
```

- [ ] **Step 4: 改造登录页**

将 `web/app/login/page.tsx` 的 JSX 替换为：

```tsx
  return (
    <MobileAuthShell
      title="登录工作区"
      subtitle="使用项目管理系统账号继续"
      footer={
        <>
          首次登录需要修改密码
          {process.env.NODE_ENV !== "production" ? (
            <>
              {" · 初始账号 "}
              <span className="mono">admin / admin123456</span>
            </>
          ) : null}
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <div className={st.field}>
          <label htmlFor="username">账号</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入账号"
            autoComplete="username"
            enterKeyHint="next"
            disabled={loading}
          />
        </div>
        <PasswordInput
          label="密码"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={loading}
        />
        {fieldErr ? <div className={st.alert} role="alert">{fieldErr}</div> : null}
        {apiErr ? <div className={st.alert} role="alert">{apiErr}</div> : null}
        <div className={st.submit}>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "登录中…" : "登 录"}
          </button>
        </div>
      </form>
    </MobileAuthShell>
  );
```

在文件顶部加入：

```tsx
import MobileAuthShell from "@/components/auth/MobileAuthShell";
import PasswordInput from "@/components/auth/PasswordInput";
```

将 `web/app/login/login.module.css` 替换为：

```css
.field { margin-bottom: 16px; }
.field label {
  display: block;
  margin-bottom: 6px;
  color: var(--ink-2);
  font-size: 13px;
}
.alert {
  margin-top: 10px;
  padding: 9px 12px;
  border: 1px solid var(--line-danger);
  border-radius: var(--radius);
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
}
.submit { margin-top: 20px; }
```

- [ ] **Step 5: 改造首次改密页**

在 `web/app/change-password/page.tsx` 顶部加入：

```tsx
import MobileAuthShell from "@/components/auth/MobileAuthShell";
import PasswordInput from "@/components/auth/PasswordInput";
```

将页面 JSX 替换为：

```tsx
  return (
    <MobileAuthShell
      title="设置新密码"
      subtitle="为保障账号安全，请完成首次改密"
      footer={
        <button
          type="button"
          className="linklike"
          onClick={() => {
            clearSession();
            router.push("/login");
          }}
        >
          退出登录
        </button>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <PasswordInput
          label="原密码"
          value={oldPwd}
          onChange={setOldPwd}
          autoComplete="current-password"
          disabled={loading}
        />
        <PasswordInput
          label="新密码"
          value={newPwd}
          onChange={setNewPwd}
          autoComplete="new-password"
          hint="至少 8 位，同时包含字母与数字"
          disabled={loading}
        />
        <PasswordInput
          label="确认新密码"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          disabled={loading}
        />
        {err ? <div className={st.alert} role="alert">{err}</div> : null}
        <div className={st.submit}>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "提交中…" : "确认修改"}
          </button>
        </div>
      </form>
    </MobileAuthShell>
  );
```

保留现有表单校验和提交逻辑。

- [ ] **Step 6: 构建并执行手机验收**

Run:

```bash
cd web
npm run build
```

Expected: `Compiled successfully`。

在浏览器分别使用 `375 × 667`、`390 × 844`、`412 × 915` 执行第 1 步表达式。Expected:

- `scrollWidth` 等于 `clientWidth`。
- 两个输入框字号均为 `16px`。
- 提交按钮高度为 `48px`。
- 聚焦密码字段时页面不自动放大。
- 键盘弹出后当前字段和错误提示保持在可视区域。
- 密码显示/隐藏按钮可通过键盘操作且不丢失焦点。

- [ ] **Step 7: 提交**

```bash
git add \
  web/components/auth/MobileAuthShell.tsx \
  web/components/auth/MobileAuthShell.module.css \
  web/components/auth/PasswordInput.tsx \
  web/components/auth/PasswordInput.module.css \
  web/app/login/page.tsx \
  web/app/login/login.module.css \
  web/app/change-password/page.tsx
git commit -m "feat(web): 增加手机登录与首次改密界面"
```

---

### Task 6: 认证回归与发布前检查

**Files:**

- Modify: `README.md`
- Verify: `api/core/config.py`
- Verify: `api/core/cookies.py`
- Verify: `api/routers/auth.py`
- Verify: `web/lib/api.ts`
- Verify: `web/app/login/page.tsx`
- Verify: `web/app/change-password/page.tsx`

**Interfaces:**

- Consumes: 前五个任务的全部接口和组件。
- Produces: 启动说明、环境变量说明和完整认证回归证据。

- [ ] **Step 1: 更新 README 启动与环境变量**

在 README 的启动章节加入：

````markdown
## 认证会话配置

开发环境默认使用 `dev-secret-change-me` 和 HTTP Cookie。生产环境必须设置：

```bash
export APP_ENV=production
export APP_SECRET='至少32字符的随机密钥'
export COOKIE_SECURE=1
```

登录成功后，后端设置：

- `pm_access_token`：HttpOnly access Cookie。
- `pm_refresh_token`：HttpOnly refresh Cookie，Path 限制为 `/api/v1/auth`。
- `pm_csrf_token`：JavaScript 可读 CSRF Cookie。

前端写请求自动发送 `X-CSRF-Token`，token 不再写入 localStorage。
````

- [ ] **Step 2: 运行完整后端测试**

Run:

```bash
python3 -m pytest -q
```

Expected: 现有测试全部通过，并新增配置与认证测试通过。

- [ ] **Step 3: 运行前端生产构建**

Run:

```bash
cd web
npm run build
```

Expected: `Compiled successfully`。

- [ ] **Step 4: 执行登录与改密手工主链路**

按以下顺序操作：

1. 清空站点 Cookie 和 localStorage。
2. 打开 `/login`，确认页面在 `375px` 下无横向滚动。
3. 输入错误密码，确认错误提示可见且字段没有自动缩放。
4. 输入正确账号，确认登录后进入 dashboard 或首次改密页。
5. 首次改密账号登录后，完成新密码提交。
6. 刷新页面，确认会话保持。
7. 退出登录，确认回到 `/login`。
8. 检查 localStorage 和 JavaScript 可读 Cookie，确认没有 access/refresh token。

Expected: 每一步行为符合描述，浏览器控制台没有未处理异常。

- [ ] **Step 5: 检查 Git 提交边界**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: 本计划的 6 个提交独立存在，进入本计划前已有的业务改动仍保持未提交或由用户自行处理。

- [ ] **Step 6: 提交**

```bash
git add README.md
git commit -m "docs(auth): 补充 Cookie 会话配置说明"
```

---

## 完成标准

- [ ] 生产环境缺少 `APP_SECRET` 或密钥过短时拒绝启动。
- [ ] 登录写入 HttpOnly access/refresh Cookie 和可读 CSRF Cookie。
- [ ] 浏览器请求不再使用 localStorage token。
- [ ] Cookie 写请求必须携带正确 CSRF header，Bearer 迁移期仍可用。
- [ ] refresh token 每次刷新后轮换，旧 token 重放返回 401。
- [ ] 登录和首次改密在三种手机宽度下无横向溢出、无自动缩放、无键盘遮挡。
- [ ] 密码显示/隐藏、字段错误和会话过期提示可访问。
- [ ] `python3 -m pytest -q` 全部通过。
- [ ] `cd web && npm run build` 成功。
