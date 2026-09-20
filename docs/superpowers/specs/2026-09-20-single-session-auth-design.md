# 单账号单会话登录设计

## 目标

调整登录会话规则：Access Token 有效期为 8 小时；同一账号在手机、电脑或不同浏览器中不可同时在线；同一浏览器的多个标签页继续共享同一登录会话。

## 现状与约束

- 后端使用 FastAPI + SQLAlchemy + PostgreSQL。
- 登录后签发 access JWT 和 refresh JWT，前端将两者保存到 `localStorage`。
- 后端已有 `token_blacklist`，但当前没有按用户撤销整组会话的机制。
- Next.js middleware 读取非 `httpOnly` 的 `pm_access_token` Cookie，只承担页面级门禁；真正鉴权仍由 API 校验 Bearer Token。
- 不引入设备指纹、设备管理页、并发登录提示或新的前端状态同步协议。

## 方案

在 `users` 表增加 `session_version` 整数列，默认值为 `0`。

1. 成功登录时，对用户行加锁并递增 `session_version`。
2. access JWT 和 refresh JWT 都携带当前 `session_version`。
3. API 鉴权时读取用户当前版本，token 版本不一致则返回 `401 会话已失效`。
4. refresh 时执行相同的版本校验，旧设备不能用旧 refresh token 换取新 access token。
5. 主动退出时递增 `session_version`，同时继续将当前 access token 加入黑名单，保留现有审计行为。
6. Access Token 有效期设为 `480` 分钟；Refresh Token 仍为 `7` 天，但不绕过会话版本校验。

这会让“新设备登录挤掉旧设备”成为服务端事实，不依赖旧设备是否打开页面。旧设备会在下一次 API 请求时收到 401，前端按现有逻辑清理本地会话并跳转登录页。

## 标签页语义

同一浏览器的多个标签页继续读取同一 origin 下的 `localStorage` 和 Cookie，因此共享同一个 access/refresh token，属于同一服务端会话，可以同时使用。任一标签页在同账号重新登录时写入新 token，其他标签页会在后续请求中使用浏览器共享的最新 token。

## 验收标准

- 登录成功返回的 access token 过期时间约为当前时间加 8 小时。
- 同一账号第二次登录后，第一次登录得到的 access token 请求 `/auth/me` 返回 401。
- 同一账号第二次登录后，第一次登录得到的 refresh token 调用 `/auth/refresh` 返回 401。
- 第二次登录得到的 access token 可以正常请求 `/auth/me`。
- 当前会话主动退出后，当前 access token 和 refresh token 都不可继续使用。
- 账号状态为 disabled 时，已有 token 仍不能访问接口。
- 前端构建和既有后端测试不回归。

## 不在本次范围

- 自动 refresh access token。
- 将 token 迁移到 `httpOnly`、`Secure`、`SameSite` Cookie。
- 设备列表、踢出指定设备、登录通知和异常登录风控。
