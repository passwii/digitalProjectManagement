# TESTING.md — 测试怎么跑、跑哪些、什么时候算通过

本文是**测试细则的唯一来源**。`AGENTS.md` §3 只做摘要，冲突时以本文为准。

## 1. 一句话原则

**本地只跑单元/组件测试，全局测试交给 CI。** 本地绿 ≠ 可以合并；可以合并 = **当前 HEAD 上相关的 GitHub Actions 检查成功** + 语义复核通过（见 §6）。

分工：

| 层 | 谁跑 | 依据 |
| --- | --- | --- |
| 纯逻辑、组件 DOM 行为、动效/令牌守卫 | 开发者本地（提交前必须跑） | `npm test`（前端） |
| 后端业务用例、权限、迁移链 | GitHub Actions `api` workflow | `go test -v ./...` + 真实 PostgreSQL |
| 前端全量 + 构建期类型检查 | GitHub Actions `web` workflow | `npm test` + `npm run build` |
| 浏览器/截图类验收 | **人工按需**，不进 CI | `scripts/av-*.mjs`、`scripts/acceptance_*.py` |

## 2. 套件地图

| 套件 | runner | 位置 | 本地命令 | CI |
| --- | --- | --- | --- | --- |
| 前端纯逻辑 | `node:test`（`tsc` 先编译） | `web/lib/**/*.test.ts` | `npm run test:unit` | `web.yml` |
| 前端组件 / DOM / 动效 / 源码守卫 | `vitest` | `web/lib/**/*.vitest.test.ts(x)` | `npm run test:motion` | `web.yml` |
| 前端构建期类型检查 | `next build` | 整个 `web/` | `npm run build` | `web.yml` |
| Go 后端单元 / 集成 | `go test` + PostgreSQL 18 | `api/**/*_test.go` | `cd api && go test -v ./...`（集成需 `TEST_DATABASE_URL`） | `api.yml` |
| 浏览器验收（截图 / 溢出 / 动效） | CDP + 本机 Chrome | `scripts/av-*.mjs`、`scripts/av-layout-*.mjs` | 手动 | 无 |

前端两个数字经常被问到：`npm test` = `npm run test:unit && npm run test:motion`，也就是**两套 runner 都会跑**，不存在"跑了 npm test 但只跑了一半"。

## 3. 前端

### 3.1 两套 runner 与文件命名（放错位置 = 没写测试）

| 文件名 | 走哪套 | 说明 |
| --- | --- | --- |
| `web/lib/foo.test.ts` | `node:test` | 先 `tsc -p tsconfig.test.json` 编到 `.test-dist/`，再 `node --test .test-dist/lib/` |
| `web/lib/foo.vitest.test.ts` | `vitest` | 需要 `expect`/`mock` 的纯逻辑 |
| `web/lib/foo.vitest.test.tsx` | `vitest` | 需要 JSX 渲染真实组件 |
| `web/lib/<sub>/foo.vitest.test.ts(x)` | `vitest` | 子目录同样被收；守卫测试建议与被守的源码同目录（如 `lib/av/`） |

硬约束：

- `tsconfig.test.json` 只收 `.ts`，所以 **`node:test` 文件不能写 JSX**。
- `vitest.config.ts` 的 `include` **只覆盖 `web/lib/`**（`lib/*.vitest.test.ts(x)`、`lib/**/*.vitest.test.ts(x)`，外加历史遗留的 `lib/activityCore.test.ts`）。放在 `components/`、`app/` 下的 `__tests__` 不会被收走 —— 组件测试文件也放 `web/lib/`。
- 需要真实 DOM 的 vitest 文件，在**第一行**加：

  ```ts
  // @vitest-environment jsdom
  ```

  默认环境是 `node`，不要为某个文件改全局配置。
- **新增测试文件后确认它真的出现在 `vitest run` 的输出里**。历史上 `include` 漏了 `*.tsx`，新增的组件测试被静默忽略，`vitest run` 全绿但一条都没跑。

### 3.2 命令

```bash
cd web
npm ci                              # 只读 package-lock；不要用 npm install 改锁文件
npm test                            # 两套都跑（提交前的最小要求）
npm run test:unit                   # 只跑 node:test（含 tsc 编译）
npm run test:motion                 # 只跑 vitest
npx vitest run lib/av/motion.vitest.test.ts   # 定向跑单个 vitest 文件
npm run lint
npm run build                       # 组件/页面的类型错误只有它能兜住
```

Node 版本：CI 固定 **26**（`.github/workflows/web.yml`，与 `docker/web.Dockerfile` 的 `node:26-alpine` 对齐）。本机建议同样用 26，以 CI 的 26 为准。

### 3.3 必须覆盖什么

- **纯逻辑**：时间口径（`Asia/Shanghai`）、分页、金额/数量格式化、权限标签映射、URL 状态解析。
- **组件 DOM 行为**：弹窗焦点与关闭、抽屉、表单校验、危险操作二次确认、空态/错误态/加载态。
- **契约与动效令牌**：`?static=1` 与 `prefers-reduced-motion` 下动画必须归零、时长只能来自 `AV_MOTION`/`--av-dur-*`、颜色只能来自令牌。
- **源码守卫**：`web/lib/avSourceGuard.vitest.test.ts`（组件里不许出现颜色字面量与业务数字）、`web/lib/av/motion.vitest.test.ts`（不许裸毫秒）这类"读源码扫描"的测试是**硬门禁**，不要顺手放宽。

### 3.4 禁止事项（会直接退回）

- 删用例、加 `.only`/`.skip`、放宽断言、改 `include` 把文件排除掉，只为让套件变绿。
- **恒真断言**：选择器命中 0 个元素时 `every()` 返回 `true`。要么先断言计数 `> 0`，要么加**负向自检**（先把 DOM 改坏，确认检查会失败，再恢复）。
- 验收检查写成"查不到就跳过"。查不到应当判失败。
- 用 `waitForTimeout` 式等待掩盖真实竞态；用 `await` 真实状态变化代替。

## 4. 后端

### 4.1 本地怎么跑（要有 `TEST_DATABASE_URL`）

Go 数据库集成测试在**没有** `TEST_DATABASE_URL` 时会 `t.Skip`。本地"绿"不代表数据库用例已执行，最终结论以 `api` workflow 为准。

推荐做法：起一个**一次性本地 PG**，凭据与 CI 完全一致：

```bash
docker run --rm -d --name pm-test-pg -p 5432:5432 \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app_test \
  postgres:18

export TEST_DATABASE_URL='postgresql+psycopg://app:app@127.0.0.1:5432/app_test'
export APP_ENV=test

cd api && go test -v ./...

docker rm -f pm-test-pg
```

Go 集成测试会为每个测试创建随机 schema，并执行嵌入 Go 二进制的 Goose 当前 schema 基线；`api/pkg/migrations` 另有 adoption/拒绝/失败重试用例，覆盖已有库的接管路径。数据库已配置但连接或迁移失败时直接失败，不会把基础设施故障伪装成 skip。

需要连开发库时走 `scripts/db_tunnel.sh`（`docker compose -f docker-compose.yml -f docker-compose.local.yml up db-tunnel`，把 VPS 上的 PG 转发到本机 5432）。但**迁移类验证不要跑在共享库上**：用随机临时 schema，或就用上面的本地一次性 PG。

### 4.2 CI 等价环境（`api.yml`）

| 项 | 值 |
| --- | --- |
| Go | 1.27（与 `docker/api.Dockerfile` 一致） |
| PostgreSQL | `postgres:18` service，`app/app/app_test`，显式发布 5432 |
| 环境变量 | `TEST_DATABASE_URL=postgresql+psycopg://app:app@localhost:5432/app_test`、`APP_ENV=test` |
| 命令 | `cd api && go test -v ./...` |

### 4.3 必须覆盖什么

- **权限与数据范围**：未授权稳定 `401/403/404`；跨部门/跨项目数据不可见；超级管理员与模块权限。
- **状态机与事务**：审批、凭证、冲销等不允许半提交；审计与业务同事务。
- **迁移与真实 schema**：`go test` 的数据库集成用例在随机 schema 上执行 Goose 当前 schema 基线，`api/pkg/migrations` 覆盖 Alembic head 接管、错误 head/字段拒绝与失败重试。
- **契约字段**：请求/响应字段、时间格式、分页与筛选语义。
- **对象存储**：Go 侧覆盖本地后端与 R2 键/URL 行为；真实 R2 凭据只用于人工验收，不进入 CI。
- **测试账号密码哈希**：Go 集成测试通过生产 `security.HashPassword` 创建账号，登录验证始终使用生产验密路径。

### 4.4 数据库卫生

- 每个 fixture 建**随机 schema** 并在结束后 `DROP`；不写共享 `public` schema。
- 不连生产库、不连同事的开发库跑全量套件。
- 测试里的 `STORAGE_LOCAL_ROOT` 固定指向临时目录；不要读写仓库内文件。

### 4.5 Python 的定位

- 后端 API、schema 迁移与测试全部由 `api/` 下的 Go 模块执行；仓库不再保留 `api/legacy_py/`、`api/alembic/` 或 pytest 套件。
- 仅运维/数据工具脚本可以保留 Python（如 `scripts/deploy_vps.py`、`scripts/rekey_r2_objects.py`），它们不参与生产镜像构建，也不进入 CI。
- 新增业务行为在 `api/**/*_test.go` 覆盖；禁止为补测试重新引入 Python 后端。

## 5. 浏览器/端到端验收（不进 CI）

仓库没有浏览器 E2E workflow，也没有 Playwright/Puppeteer 依赖。这类验证用 `scripts/` 下的脚本，**由人按 issue 验收标准手动跑**：

```bash
# 终端 A：起站点（默认 3001）
cd web && npm run dev

# 终端 B：在仓库根目录跑验收脚本
node scripts/av-layout-overflow.mjs http://127.0.0.1:3001
node scripts/av-monitor-motion.mjs  http://127.0.0.1:3001 artifacts/blf1425
```

- 脚本会 spawn 本机 Chrome（默认 `/Applications/Google Chrome.app/...`，可用 `CHROME_PATH` 覆盖），走 CDP。
- 产物放 `artifacts/<issue-key>/`，随 PR 提交；PR 描述里写清"跑了什么、结论、关键数字"。
- 这类脚本**不替代码测试**：能被 `vitest` 守住的 DOM/CSS 契约写在 vitest 里，脚本只做真实渲染下的观感与布局验证。

## 6. 合并门禁（映射到 CI）

| 改动面 | 必需检查 | 备注 |
| --- | --- | --- |
| `web/**`（页面、组件、样式、动效、`lib/`） | **`web · 测试`** | 含 `npm test` + `npm run build` |
| `api/**`、`docker/api.Dockerfile` | **`api · 测试`** | Go 全量测试 + 真实 PG |
| `.dockerignore`、`api/**`、`web/**`、`docker/**`、`scripts/**`、`docker-compose.yml`、`docker-compose.prod.yml`、`container-images.yml`、`deploy-vps.yml` | **`container-images`** | PR 上检查生产 Compose 合并结果并构建 API/Web 镜像，不推送、不部署 |
| 前后端都改、或改了接口契约 | 两条都要 | 契约变更要在 PR 里点明 |
| `docs/**`、`AGENTS.md`、`TESTING.md`、`artifacts/**` | **`web · 测试`** | `web.yml` 对所有 PR 触发，纯文档 PR 也会跑；`api` 不会跑 |
| 部署 workflow | **不是 PR 合并门禁** | `main` 更新后由 `deploy-vps.yml` 部署；也可手动 dispatch `main` |

**这个仓库不存在的检查，不要等：**

- Vercel 部署状态（仓库没有配置 Vercel）；PR 合并检查不等待生产部署状态
- Lighthouse、Playwright/浏览器 E2E workflow（不存在）

要求"等 Vercel 成功"只会让 PR 永久卡在"无法确认"。PR 合并门禁由本次改动路径对应的 CI 检查组成，包括容器构建路径对应的 `container-images`；部署 workflow 只在代码进入 `main` 后运行，不为 PR 分支部署。

`deploy-vps.yml` 使用 GitHub `production` environment 中的 `VPS_SSH_PRIVATE_KEY` 和 `VPS_SSH_KNOWN_HOSTS`，并读取仓库 Actions variable `PM_DOMAIN` 作为 Web 镜像构建期 API 域名。部署脚本会在 `git pull` 和容器操作前将该值与 VPS `.env` 的 `PM_DOMAIN` 比较。workflow 严格校验 SSH 主机密钥，只接受 `main` 作为部署 ref。build job 有 `packages: write`，deploy job 只有 `packages: read`；GHCR packages 必须允许该 repository 的 `GITHUB_TOKEN` 访问。VPS 仍执行 `git pull origin main` 更新 Compose 配置，但只运行 `docker compose pull` 与 `up --no-build`，不再构建镜像，也不需要访问 npm/PyPI；它仍需访问 GitHub 与 GHCR。

主线 workflow 用 commit SHA 标记镜像，并将 GHCR digest 交给 deploy job。`workflow_dispatch` 可同时指定 API/Web digest 回滚；输入必须属于当前 repository 的两个 package。回滚部署使用当前 `main` 的 Compose 配置，不会撤销数据库 migration。

几条容易搞错的细节：

- `api` workflow **只在改动命中 `paths` 时触发**。纯前端 PR 里看不到 `api` job 属正常；反过来，只改 `docker/api.Dockerfile` 也会触发（PR #114 踩过漏掉它的坑）。
- 同一分支连续推送时 `concurrency` 会取消旧运行 —— 看**最新一次**，不要引用被取消的那次。
- 检查成功只代表命令跑过了，不代表需求实现了。语义复核、测试证据仍然要看。

## 7. PR 里怎么写测试证据

- 给**命令 + 真实数字**，例如：`cd web && npm test` → `node:test 382 通过 / vitest 70 文件 581 用例通过`；`npm run build` → `Compiled successfully`。
- 前端改动**必须**写 `npm run build` 的结果：`npm test` 里的 `tsc` 只覆盖 `lib` 下的测试文件，组件与页面的类型错误只有 build 能兜。
- 有失败或跳过要写清楚：哪条、为什么、是否影响结论。不要用"测试通过"这种没有证据的说法。
- CI 还没跑完就交棒时，明确写"CI 运行中 + 本地结果"，不要默认它会绿。

## 8. 踩过的坑（别重复踩）

| 坑 | 症状 | 结论 |
| --- | --- | --- |
| 缺 `TEST_DATABASE_URL` | Go 集成用例全部 `skip`、退出码 0 | 跳过不是通过；以 `api` workflow 的真实 PG 结果为准 |
| `vitest` `include` 漏 `.tsx` | 新增组件测试全绿但一条没跑 | 新文件必须出现在输出里 |
| `api.yml` 漏 `docker/api.Dockerfile` | 只改 Dockerfile 时 `api` job 根本不出现 | `paths` 要覆盖所有影响后端的文件 |
| CSS Module 本地化 keyframes 名 | `animation: avXxx` 静默不执行（`animation-name` 不是 `none`，但停在首帧） | 动画名经 `--av-kf-*` 变量转发；vitest 有源码守卫 |
| 选择器命中 0 个元素 | `every()` 恒真、验收永远通过 | 断言计数 > 0，并加负向自检 |
| 只看 `gh pr checks` 的成功 | 旧 HEAD 的绿灯被当成本次结论 | 检查必须对应**当前 HEAD SHA** |
