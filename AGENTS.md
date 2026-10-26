# AGENTS.md — 数科云办公（digitalProjectManagement）

> **重要：每次启动先把本地代码更新到最新。**
>
> 新建会话、接新任务、回到旧任务，第一步都是同步到最新的 `origin/main` —— `git fetch origin --prune` 后 `git rebase origin/main`（或在 `main` 上 `git pull --ff-only`），确认当前分支已包含最新 `origin/main`，再读文档、改代码、跑测试。不要在落后的基线上开工：PR 平白冲突、改到别人已经重写的代码，基本都是漏了这一步；本地有未提交改动先 `git stash`，不要用 `git reset --hard` 硬覆盖，拉取失败（网络、认证、冲突）也要先解决再往下做。

> **新 worktree 初始化后建立 CodeGraph 索引。** 完成上方的 `origin/main` 同步后，立即在该 worktree 的仓库根目录运行 `codegraph init -i`。

本文件是本仓库**协作与交付规则的入口**。测试怎么写、怎么跑、什么时候算通过，细则全在 **`TESTING.md`**；本文件只做摘要与指向，不重复定义。

- 架构与技术事实：`README.md`（注意区分 `[现状]` 与 `[目标]`，目标态不要当现状实施）
- 测试细则与合并门禁：`TESTING.md` ← **改代码前先读**
- 视觉与设计令牌：`DESIGN.md`
- 产品定位与用户：`PRODUCT.md`

仓库现实：单仓库（`web/` Next.js 14 + `api/` FastAPI）、PostgreSQL 唯一业务数据源、附件走 Cloudflare R2、部署是 VPS 上的 Docker Compose + 宿主机 Caddy。

## 0. 规则优先级

1. **`TESTING.md`** —— 测试命令、套件边界、必需覆盖、CI 门禁。冲突时以它为准。
2. **本文件** —— 协作流程、提交规范、高风险区约定。
3. `README.md` / `DESIGN.md` / `PRODUCT.md` —— 事实与设计来源。
4. 文档没写到的，先问清楚再动手，不凭记忆行事。

## 1. 仓库结构

| 路径 | 内容 |
| --- | --- |
| `web/` | Next.js 14 App Router + React 18 + TypeScript。`app/` 路由、`components/` 组件、`lib/` 数据访问与纯逻辑（**测试也放在这里**） |
| `api/` | FastAPI 模块化单体：Router（HTTP 语义）/ `core`（业务规则）/ models（持久化）/ `alembic/`（迁移链） |
| `tests/` | 后端 pytest 套件（需要真实 PostgreSQL，见 `TESTING.md` §4） |
| `scripts/` | 运维脚本（`deploy_vps.py`、`db_tunnel.sh`）与验收脚本（`av-*.mjs`、`acceptance_*.py`） |
| `docker/`、`docker-compose*.yml` | 镜像与编排。`docker-compose.local.yml` 通过 SSH 隧道连 VPS 上的 PG |
| `docs/` | 设计与计划归档：`docs/finance/`、`docs/performance/`、`docs/prototypes/`、`docs/superpowers/plans/` |
| `artifacts/` | 验收产物（截图、动效报告），按 issue 分目录（如 `artifacts/blf1425/`），随 PR 提交 |

## 2. 常用命令

前端（`web/`，CI 固定 Node 20）：

```bash
cd web
npm ci            # 只读 package-lock，不要用 npm install 改锁文件
npm run dev       # http://127.0.0.1:3001
npm test          # = test:unit（tsc + node --test）+ test:motion（vitest run）
npm run lint
npm run build     # 组件/页面的类型错误只有它能兜住
```

后端（Python 3.14：本机、CI、生产镜像三端一致）：

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r api/requirements.txt
pytest tests -q                      # 需要 TEST_DATABASE_URL，见 TESTING.md §4
cd api && alembic upgrade head       # 用 DATABASE_URL
```

部署：**人工执行**，不是 CI。

```bash
python3 scripts/deploy_vps.py        # 由人决定时机；合并 PR 不会自动部署
```

## 3. 测试规则（摘要）

完整规则见 **`TESTING.md`**，这里只列不可协商的几条：

- **本地只跑单元/组件测试**（前端 `web/` 下 `npm test`，后端定向 `pytest` 用例）；**全量与集成测试交给 GitHub Actions** 的 `web` / `api` 两条 workflow。
- 前端有 **两套 runner**，命名决定归谁：`lib/**/*.test.ts` → `node:test`；`lib/**/*.vitest.test.ts(x)` → `vitest`。放错位置等于没写测试（`vitest` 的 include 只覆盖 `web/lib/`）。
- **跳过 ≠ 通过**：后端缺 `TEST_DATABASE_URL` 时依赖数据库的用例会 `skip`，本地"绿"没有意义；结论以 `api` workflow 为准。
- 新增行为必须带用例；修 bug 先写能复现的失败用例。改权限、状态机、迁移、公共 schema 时，用例是硬要求，不是加分项。
- 不许为了让套件变绿而删用例、加 `.only`、放宽断言或改 include 排除文件。守卫测试挡路时，改代码或**论证并说明**后再动守卫。

## 4. CI 现状（真实存在的门禁）

仓库只有两条 workflow，都在 `.github/workflows/`：

| Workflow / 检查名 | 文件 | 触发 | 做什么 |
| --- | --- | --- | --- |
| `web` / **`web · 测试`** | `web.yml` | 所有 PR、push `main` | Node 20 → `npm ci` → `npm test` → `npm run build` |
| `api` / **`api · 测试`** | `api.yml` | PR 改到 `api/**`、`tests/**`、`docker/api.Dockerfile`、`api.yml` 本身；push `main` | postgres:18 服务 + Python 3.14 → `pip install -r api/requirements.txt` → `pytest tests -q` |

读法：

- 合并门禁 = **当前 HEAD 上相关那条检查成功**。前端/文档改动看 `web · 测试`；后端改动看 `api · 测试`；两者都改就都要。
- `api` 有 path 过滤，纯前端 PR 里**不会出现** `api` job —— 这是设计，不是漏跑。但改动跨到接口契约（前端按新字段取值、改请求结构）时必须人工确认后端是否已合入。
- **本仓库没有 Vercel，也没有任何部署类 workflow**。不要拿"Vercel 部署检查 / deployment 记录"当门禁，也不要等它 —— 这类要求在别的仓库成立，套到这里只会永远"无法确认"，把 PR 卡死。部署是合并之后由人跑 `scripts/deploy_vps.py`。
- CI 绿只是必要条件，不是充分条件：见 §5 与 `TESTING.md` §6。

## 5. PR 把关（Codex-first）

1. **先记当前 HEAD SHA**。之后所有 review 结论只认这个 commit；换了 HEAD 就重新确认。
2. **Codex 结论读四类来源，缺一不可**：① PR 摘要评论 ② `gh api repos/passwii/digitalProjectManagement/pulls/<N>/reviews`（看 `commit_id`）③ `.../pulls/<N>/comments`（行内问题常只在这里）④ PR 对话。
3. 判定枚举：
   - `PENDING` —— 当前 HEAD 无完成记录 → 不合并；
   - `UNKNOWN` —— API/权限/网络失败或来源矛盾 → 报原因并回退人工 review，**不得静默当 clean**；
   - `FINDINGS` —— 逐条判断，真实问题退回作者；
   - `CLEAN` —— 四源已读且没有未处理的有效发现。
4. 摘要显示 `Completed` **不等于**无发现，行内评论才算数。
5. Codex 是静态审查，**不是测试**。它不替代作者的测试证据，也不替代 §4 的 CI。
6. 语义复核（Codex 之外自己做）：需求覆盖、契约一致、边界与错误处理、权限边界、无调试残留、commit author。
7. 合入用 squash merge，合并后删除分支。

## 6. Git 与提交规范

- 分支：自动化任务 `agent/<agent>/<issue-key>`；人工改动用语义化名字（`feat/...`、`fix/...`、`docs/...`）。**不直接 push `main`**。
- 提交信息：**中文 Conventional Commits**，一件事一条：

  ```text
  feat(stream-monitor): /monitor 波形组件参数化 + 切换三段式（BLF-1425）
  fix(api): 附件预签名 URL 过期后回退直链（BLF-1136）
  docs(testing): 补 AGENTS.md 与 TESTING.md，明确本地/CI 测试边界
  ```

- 关联 issue 写 `Closes BLF-xxxx`（正文或 PR 描述均可）。
- commit author：`DamonRock <jr.way123@gmail.com>`。
- 一个 PR 只做一件事；不夹带无关格式化、重排、依赖升级。
- 不入库：`.env*`（除 `.env.docker.example`）、`node_modules/`、`.next/`、`.test-dist/`、`data/`、`.multica/`、`.codegraph/`。

## 7. 高风险区约定

- **权限在后端执行**（ADR-003）。前端隐藏按钮不是安全边界；新增或改路由必须有用例覆盖未授权/越权路径。
- **审计与业务同事务**（ADR-004）：不允许业务成功而审计缺失。
- **软删除**（ADR-007）：所有业务查询必须显式下推软删除条件。
- **时间口径统一 `Asia/Shanghai`**（README §4.4）：不用本机时区，不写裸 `datetime.now()`。
- **迁移**：只新增 revision，不改已合入的历史；`tests/test_migration_revision_ids.py` 守迁移链。迁移验证用随机临时 schema，不碰共享库。
- **前端样式与动效**：颜色只用令牌，时长/缓动只用 `var(--av-*)` 与 `AV_MOTION`，不写毫秒字面量与颜色字面量 —— `web/lib/av/*.vitest.test.ts` 有源码守卫。
- **前端界面文案**：Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining. 不堆叠多余的二级标签与说明文字，让布局本身完成解释，而不是靠文字补充。
- **`/stream-monitor` 演示站**：画面用 CSS/SVG 合成，不往 `public/` 加视频/图片素材。
- **改公共函数 / hook / route / schema 前**先跑 `codegraph callers|impact`（仓库已建索引 `codegraph status .`），确认影响面再改。

## 8. 交付前自检

- [ ] 按 `TESTING.md` 跑了目标测试，PR 里给**命令 + 真实数字**
- [ ] 前端改动：`npm test` 之外，`npm run build` 也过（`tsc` 只覆盖 `lib` 下的测试文件）
- [ ] 新增测试文件真的被执行了（`vitest` include 只覆盖 `web/lib/`；新文件要出现在输出里）
- [ ] 没有 `.only`、被跳过的用例、恒真断言（例如命中 0 个元素时的 `every()`）
- [ ] 没有调试残留：`console.log`、`debugger`、临时 TODO
- [ ] commit author 与提交信息符合 §6
- [ ] 当前 HEAD 上相关 CI 绿；未绿就明确写"CI 运行中 + 本地结果"，不要含糊说"测试通过"
- [ ] 发给用户的本机链接是 Tailscale 地址（不是 `localhost`），且已自己打开验证（§9）

## 9. 本机预览与链接发布（Tailscale）

给用户任何指向**本机运行内容**的链接（预览页、评论页面、仪表板等）时，一律给 Tailscale 链接，**永远不给 `localhost` / `127.0.0.1`**：用户在多台电脑和手机上工作，链接必须在其 tailnet 内可达。

- 用 `tailscale serve` 把本地服务发布到 tailnet（例：`tailscale serve --bg 3001`）；`tailscale serve status` 查看已发布地址。首次使用需先在 tailnet 启用 Serve（未启用时命令只提示去 login.tailscale.com/f/serve 启用，不会写入任何配置）。
- 发布前**先跑 `tailscale serve status`**：Serve 是「establish or replace」语义，同一 host / port / mount 会被直接覆盖。根路径（`https:443 /`）已经被别的预览占着时，不要直接 `tailscale serve --bg <port>` 把人家的顶下线；改成发布到自己的路径（`tailscale serve --bg --https=443 --set-path=/<issue> <port>`），或换一个没人用的 `--https=<port>`。只覆盖 / 收回自己发布的那一项。
- 收回时**只收回自己发布的那一项**：先跑 `tailscale serve status`，再用同一 endpoint 的 `off` 形式撤回（例：`tailscale serve --https=443 off`；带路径的写成 `tailscale serve --https=<port> --set-path=<path> off`，具体参数以 `status` 列出的那项为准）。**不要用 `tailscale serve reset`** —— 它清空的是整台机器当前的 Serve 配置，会把本机其他预览、仪表板一起下线；只有 `tailscale serve status` 确认本机没有任何其他 Serve 配置时，才可以用 `reset`。
- 发布后**自己先打开该链接**，确认可访问、页面正常，再把链接发给用户；打不开就先修好或说明原因，不发未验证的链接。
- 给完整地址（`https://<machine>.<tailnet>.ts.net/...`），不要只给端口或相对路径。
