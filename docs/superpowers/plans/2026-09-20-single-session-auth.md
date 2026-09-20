# 单账号单会话登录实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将登录系统调整为 Access Token 8 小时有效，并保证同一账号只保留一个有效服务端会话。

**Architecture:** 在 `users` 表增加 `session_version`。登录和退出递增该值，JWT 携带该值；访问 API 和 refresh 时把 JWT 版本与数据库当前版本比较。浏览器端继续使用现有 localStorage/Cookie，因此同一浏览器的多个标签页共享同一会话。

**Tech Stack:** FastAPI、SQLAlchemy、PostgreSQL、python-jose、Alembic、pytest、Next.js 14。

## Global Constraints

- 所有 Git 信息使用中文 PR 标题和中文分节抬头。
- 不改动无关业务模块，不引入设备指纹或自动 refresh。
- 遵循 TDD：先写会失败的回归测试，再实现生产代码。
- Access Token 有效期必须为 480 分钟，Refresh Token 仍为 7 天。
- 旧会话必须在 API 请求和 refresh 两条路径同时失效。

---

### Task 1: 增加会话版本字段与迁移

**Files:**
- Modify: `api/models/__init__.py:40-52`
- Create: `api/alembic/versions/0013_single_session_auth.py`
- Test: `tests/test_mvp.py`

**Interfaces:**
- `User.session_version: int` 默认 `0`。
- 迁移从 `0012_partners` 进入，幂等增加 `users.session_version`。

- [ ] **Step 1: Write the failing test**

在 `tests/test_mvp.py` 增加两个登录结果之间的会话失效测试，断言第二次登录后第一次 access token 的 `/auth/me` 返回 401，并断言旧 refresh token 不能刷新。

- [ ] **Step 2: Run test to verify it fails**

运行：`TEST_DATABASE_URL=... pytest tests/test_mvp.py -k single_session -q`

预期：失败，因为当前 JWT 不携带会话版本，旧 token 仍能访问和 refresh。

- [ ] **Step 3: Write minimal implementation**

在 `User` 增加 `session_version = Column(Integer, nullable=False, default=0, server_default="0")`；新增 Alembic revision `0013_single_session_auth`，仅在列不存在时增加该列。

- [ ] **Step 4: Run test to verify it passes**

运行：`TEST_DATABASE_URL=... pytest tests/test_mvp.py -k single_session -q`

预期：仍可能失败，但失败点应转移到 token 版本校验，证明数据库字段已可用。

- [ ] **Step 5: Commit**

```bash
git add api/models/__init__.py api/alembic/versions/0013_single_session_auth.py tests/test_mvp.py
git commit -m "新增单账号单会话数据结构"
```

### Task 2: 实现 8 小时 Token 与单会话校验

**Files:**
- Modify: `api/core/security.py:1-54`
- Modify: `api/core/deps.py:16-36`
- Modify: `api/routers/auth.py:60-113`
- Modify: `tests/test_time_contract.py`

**Interfaces:**
- `create_access_token(sub: str, session_version: int = 0) -> str`。
- `create_refresh_token(sub: str, session_version: int = 0) -> str`。
- JWT claim 名为 `session_version`。

- [ ] **Step 1: Write the failing test**

增加 access token 8 小时有效期断言；扩展单会话测试，断言新 token 可用、旧 access/refresh 均返回 401。

- [ ] **Step 2: Run test to verify it fails**

运行：`TEST_DATABASE_URL=... pytest tests/test_mvp.py tests/test_time_contract.py -k "single_session or access_token" -q`

预期：失败，因为 token 当前有效期为 2 小时且没有版本 claim 校验。

- [ ] **Step 3: Write minimal implementation**

将 `ACCESS_MINUTES` 改为 `480`；token 创建函数写入 `session_version`；登录成功前对用户行加锁并递增版本；`get_current_user` 和 `/auth/refresh` 校验版本；refresh 签发带相同版本的新 access token。

- [ ] **Step 4: Run test to verify it passes**

运行：`TEST_DATABASE_URL=... pytest tests/test_mvp.py tests/test_time_contract.py -k "single_session or access_token" -q`

预期：相关测试全部通过。

- [ ] **Step 5: Commit**

```bash
git add api/core/security.py api/core/deps.py api/routers/auth.py tests/test_mvp.py tests/test_time_contract.py
git commit -m "实现八小时单账号单会话鉴权"
```

### Task 3: 让主动退出撤销整个当前会话并同步前端门禁

**Files:**
- Modify: `api/routers/auth.py:86-99`
- Modify: `web/lib/api.ts:57-62`
- Test: `tests/test_mvp.py`

- [ ] **Step 1: Write the failing test**

登录后调用 `/auth/logout`，断言原 access token 的 `/auth/me` 与原 refresh token 的 `/auth/refresh` 都返回 401。

- [ ] **Step 2: Run test to verify it fails**

运行：`TEST_DATABASE_URL=... pytest tests/test_mvp.py -k logout_session -q`

预期：失败，因为当前 logout 只黑名单 access token。

- [ ] **Step 3: Write minimal implementation**

logout 在当前用户行上递增 `session_version`，保留当前 access token 黑名单写入；前端 `saveSession` 将 Cookie `max-age` 从 2 小时改为 8 小时，使页面门禁与 access token 一致。

- [ ] **Step 4: Run test to verify it passes**

运行：`TEST_DATABASE_URL=... pytest tests/test_mvp.py -k logout_session -q`

预期：测试通过。

- [ ] **Step 5: Commit**

```bash
git add api/routers/auth.py web/lib/api.ts tests/test_mvp.py
git commit -m "退出登录时撤销当前会话"
```

### Task 4: 完整验证与文档核对

**Files:**
- Verify: `docs/superpowers/specs/2026-09-20-single-session-auth-design.md`
- Verify: `README.md`

- [ ] **Step 1: Run backend tests**

运行：`TEST_DATABASE_URL=... pytest -q`

- [ ] **Step 2: Run frontend tests and build**

运行：`cd web && npm test && npm run build`

- [ ] **Step 3: Run diff checks**

运行：`git diff --check && git status --short`

- [ ] **Step 4: Update documentation if needed**

仅在 README 的现状描述与实现不一致时补充“Access Token 8 小时、单账号单会话”；不改动目标架构段落的安全规划。

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "补充单会话登录安全说明"
```
