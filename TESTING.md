# TESTING.md — 测试怎么跑、跑哪些、什么时候算通过

本文是**测试细则的唯一来源**。`AGENTS.md` §3 只做摘要，冲突时以本文为准。

## 1. 一句话原则

**本地只跑单元/组件测试，全局测试交给 CI。** 本地绿 ≠ 可以合并；可以合并 = **当前 HEAD 上相关的 GitHub Actions 检查成功** + 语义复核通过（见 §6）。

分工：

| 层 | 谁跑 | 依据 |
| --- | --- | --- |
| 纯逻辑、组件 DOM 行为、动效/令牌守卫 | 开发者本地（提交前必须跑） | `npm test`（前端） |
| 后端业务用例、权限、迁移链 | GitHub Actions `api` workflow | `pytest tests -q` + 真实 PostgreSQL |
| 前端全量 + 构建期类型检查 | GitHub Actions `web` workflow | `npm test` + `npm run build` |
| 浏览器/截图类验收 | **人工按需**，不进 CI | `scripts/av-*.mjs`、`scripts/acceptance_*.py` |

## 2. 套件地图

| 套件 | runner | 位置 | 本地命令 | CI |
| --- | --- | --- | --- | --- |
| 前端纯逻辑 | `node:test`（`tsc` 先编译） | `web/lib/**/*.test.ts` | `npm run test:unit` | `web.yml` |
| 前端组件 / DOM / 动效 / 源码守卫 | `vitest` | `web/lib/**/*.vitest.test.ts(x)` | `npm run test:motion` | `web.yml` |
| 前端构建期类型检查 | `next build` | 整个 `web/` | `npm run build` | `web.yml` |
| 后端全量 | `pytest` + PostgreSQL 18 | `tests/test_*.py` | `pytest tests -q`（需 `TEST_DATABASE_URL`） | `api.yml` |
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

Node 版本：CI 固定 **20**（`.github/workflows/web.yml`，与 `docker/web.Dockerfile` 的 `node:20-alpine` 对齐）。本机用更高版本通常也能跑，但以 CI 的 20 为准。

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

`tests/conftest.py` 在**没有** `TEST_DATABASE_URL` 时会让 `db` fixture `pytest.skip()` —— 历史实测 282 个用例里 230 个（约 82%）会真的不执行，套件仍然退出 0。那是"假绿"，不是通过。

推荐做法：起一个**一次性本地 PG**，凭据与 CI 完全一致：

```bash
docker run --rm -d --name pm-test-pg -p 5432:5432 \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app_test \
  postgres:18

export TEST_DATABASE_URL='postgresql+psycopg://app:app@127.0.0.1:5432/app_test'
export APP_ENV=test

pip install -r api/requirements.txt
pytest tests -q
pytest tests/test_mvp.py -q -k "权限"     # 定向跑

docker rm -f pm-test-pg
```

需要连开发库时走 `scripts/db_tunnel.sh`（`docker compose -f docker-compose.yml -f docker-compose.local.yml up db-tunnel`，把 VPS 上的 PG 转发到本机 5432）。但**迁移类验证不要跑在共享库上**：用随机临时 schema，或就用上面的本地一次性 PG。

### 4.2 CI 等价环境（`api.yml`）

| 项 | 值 |
| --- | --- |
| Python | 3.14（与本机、`docker/api.Dockerfile` 一致） |
| PostgreSQL | `postgres:18` service，`app/app/app_test`，显式发布 5432 |
| 环境变量 | `TEST_DATABASE_URL=postgresql+psycopg://app:app@localhost:5432/app_test`、`APP_ENV=test` |
| 命令 | `pip install -r api/requirements.txt` → `pytest tests -q` |

`conftest.py` 在 `CI=true` 且缺 `TEST_DATABASE_URL` 时**直接抛错**（不是 skip）。这道防线不要拆：它的存在就是防止"跳过被当成通过"。

### 4.3 必须覆盖什么

- **权限与数据范围**：未授权稳定 `401/403/404`；跨部门/跨项目数据不可见；超级管理员与模块权限。
- **状态机与事务**：审批、凭证、冲销等不允许半提交；审计与业务同事务。
- **迁移链**：`tests/test_migration_revision_ids.py`（revision id 长度/唯一性/链完整）；迁移升降级在随机临时 schema 上验证。
- **契约字段**：请求/响应字段、时间格式、分页与筛选语义。
- **对象存储**：默认本地临时暂存，不触网；需要验证 R2 行为时用 `monkeypatch` 局部覆盖。

### 4.4 数据库卫生

- 每个 fixture 建**随机 schema** 并在结束后 `DROP`；不写共享 `public` schema。
- 不连生产库、不连同事的开发库跑全量套件。
- 测试里的 `STORAGE_LOCAL_ROOT` 固定指向临时目录；不要读写仓库内文件。

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
| `api/**`、`tests/**`、`docker/api.Dockerfile` | **`api · 测试`** | 全量 pytest + 真实 PG |
| 前后端都改、或改了接口契约 | 两条都要 | 契约变更要在 PR 里点明 |
| `docs/**`、`AGENTS.md`、`TESTING.md`、`artifacts/**` | **`web · 测试`** | `web.yml` 对所有 PR 触发，纯文档 PR 也会跑；`api` 不会跑 |
| 部署 | 无 CI 门禁 | 合并后由人执行 `scripts/deploy_vps.py` |

**这个仓库不存在的检查，不要等：**

- Vercel / 任何 deployment 状态（仓库里没有 Vercel 项目，历史记录为空是正常的，不是失败）
- `deploy-vps.yml` 之类的部署 workflow（不存在）
- Lighthouse、Playwright/浏览器 E2E workflow（不存在）

要求"等 Vercel 成功"只会让 PR 永久卡在"无法确认"。门禁就是上面两条检查。

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
| 缺 `TEST_DATABASE_URL` | `52 passed, 230 skipped`、退出码 0 | 跳过不是通过；CI 已强制抛错 |
| `vitest` `include` 漏 `.tsx` | 新增组件测试全绿但一条没跑 | 新文件必须出现在输出里 |
| `api.yml` 漏 `docker/api.Dockerfile` | 只改 Dockerfile 时 `api` job 根本不出现 | `paths` 要覆盖所有影响后端的文件 |
| CSS Module 本地化 keyframes 名 | `animation: avXxx` 静默不执行（`animation-name` 不是 `none`，但停在首帧） | 动画名经 `--av-kf-*` 变量转发；vitest 有源码守卫 |
| 选择器命中 0 个元素 | `every()` 恒真、验收永远通过 | 断言计数 > 0，并加负向自检 |
| 只看 `gh pr checks` 的成功 | 旧 HEAD 的绿灯被当成本次结论 | 检查必须对应**当前 HEAD SHA** |
