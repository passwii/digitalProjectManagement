# GHCR 镜像构建与 VPS 拉取部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 API 和 Web Docker 镜像构建移到 GitHub Actions，VPS 只拉取不可变镜像并启动服务。

**Architecture:** Actions 在 `main` 更新后构建 API/Web 镜像并推送到 GHCR，以 registry digest 作为发布标识；同一 workflow 在构建完成后通过现有 SSH 部署脚本发布这些 digest。生产 Compose 文件改为引用必需的 `API_IMAGE` 和 `WEB_IMAGE`，保留开发 Compose 的本地构建方式。Actions 用短时 `GITHUB_TOKEN` 通过 SSH stdin 完成 GHCR 拉取认证，VPS 使用临时 Docker 配置并在退出时清理；保留当前 VPS `.env`、迁移入口、健康检查与 Caddy 拓扑。

**Tech Stack:** GitHub Actions、Docker Buildx、GHCR、Docker Compose、Python `pytest`/`unittest`。

## Global Constraints

- 只从 `main` 自动部署；PR 只验证容器镜像构建，不推送镜像、不连接 VPS。
- GHCR 镜像使用 digest 发布；回滚时要求同时提供 API 与 Web 的 GHCR digest。
- `NEXT_PUBLIC_API_BASE` 是 Web 构建期参数，由仓库 Actions variable `PM_DOMAIN` 生成；部署脚本必须在 `git pull` 和 Docker 操作前确认它与 VPS `/opt/pm/.env` 中的 `PM_DOMAIN` 一致。
- `GITHUB_TOKEN` 只授予构建所需的 `packages: write` 或部署所需的 `packages: read`；拉取 token 经 SSH stdin 传输，不写入远端脚本、日志或持久化 Docker 配置。
- VPS 不执行 `docker build`；生产部署使用 `docker compose pull` 和 `docker compose up -d --no-build`。
- 保留 `/opt/pm/.env`、API Alembic 启动流程、HTTPS 前置检查及 API/Web 健康检查。
- 镜像回收只针对本项目的两个 GHCR 镜像仓库，保留当前版本和一个本地回滚版本；不执行全局 `docker system prune`，不触碰 volume、旧本地 `pm-web` 镜像或其他 Compose 项目。
- 不在 PR 或 `main` 上直接部署未合并代码；提交使用中文 Conventional Commits，author 为 `DamonRock <jr.way123@gmail.com>`。

---

### Task 1: 生产 Compose 切换为镜像引用

**Files:**
- Modify: `docker-compose.prod.yml`
- Test: `tests/test_deploy_vps.py`

**Interfaces:**
- Consumes: 部署脚本导出的 `API_IMAGE`、`WEB_IMAGE` digest 引用。
- Produces: 生产 overlay 必须要求两个镜像引用，并移除继承自基础 Compose 的生产 build 配置；基础 Compose 继续供本地开发构建。

- [ ] **Step 1: 先加失败的 Compose 合同测试**

在 `DeployVpsWorkflowContractTest` 同文件新增生产 Compose 合同测试，断言 `docker-compose.prod.yml` 中 API 与 Web 都有 `${API_IMAGE:?...}` / `${WEB_IMAGE:?...}` 镜像引用，并以 `build: !reset null` 清除基础文件的 build 配置。先运行测试，确认当前配置因缺少镜像引用而失败。

Run: `pytest tests/test_deploy_vps.py -q -k DeployVpsWorkflowContractTest`
Expected: 新增的生产 Compose 合同测试失败；已有部署 workflow 合同测试通过。

- [ ] **Step 2: 修改生产 Compose overlay**

在 `docker-compose.prod.yml` 的 `api` 和 `web` 服务中清除继承 build 配置并设置必需镜像：

```yaml
    build: !reset null
    image: "${API_IMAGE:?API_IMAGE must be set}"
```

Web 服务同样使用 `WEB_IMAGE`。移除 Web 的生产 `build.args.NEXT_PUBLIC_API_BASE`；该参数会由 GitHub Actions 在构建镜像时传入。保留 `docker-compose.yml` 的 build 配置和全部运行时环境变量。

- [ ] **Step 3: 验证 Compose 合并配置**

运行合同测试；如果本机 Docker Compose 可用，再用临时 `API_IMAGE`、`WEB_IMAGE` 和必需环境变量执行 `docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet`。确认合并结果没有 `build`，且生产镜像分别指向给定 digest。

- [ ] **Step 4: 提交本任务**

```bash
git add docker-compose.prod.yml tests/test_deploy_vps.py
git commit -m "feat(deploy): 生产 Compose 改为拉取 GHCR 镜像"
```

### Task 2: 部署脚本安全拉取 digest 镜像

**Files:**
- Modify: `scripts/deploy_vps.py`
- Test: `tests/test_deploy_vps.py`

**Interfaces:**
- Consumes: CLI 参数 `--api-image`、`--web-image`、`--expected-revision`、`--expected-domain`；环境变量 `GHCR_TOKEN` 与 `GHCR_USERNAME`。
- Produces: `build_remote_script()` 接收已经校验的两个 GHCR digest 和预期 commit；远端先通过临时 Docker 配置登录并拉取镜像，再以 `--no-build` 启动服务。

- [ ] **Step 1: 先写部署脚本失败测试**

新增测试覆盖：缺少任一镜像引用会拒绝部署；非 `ghcr.io/...@sha256:<64 hex>` 的引用会拒绝部署；远端脚本通过 `docker login --password-stdin` 登录、先 `compose pull` 再 `up -d --no-build`；远端脚本不含 token；预期 revision 或域名不匹配时在容器变更前终止；健康检查仍覆盖 API 和 Web；清理只处理传入的两个镜像仓库且不碰 volume 或其他镜像。

Run: `pytest tests/test_deploy_vps.py -q -k DeployVpsScriptTest`
Expected: 新增断言失败，既有 HTTPS、健康检查和回收约束测试继续通过。

- [ ] **Step 2: 给 CLI 增加必需的镜像与 revision 参数**

在 `main()` 增加 `--api-image`、`--web-image`、`--expected-revision`、`--expected-domain` 参数。添加纯函数校验两个引用的 GHCR digest 格式，校验 revision 为 40 位十六进制 SHA、domain 为有效 DNS 名称；缺少 `GHCR_TOKEN` 或 `GHCR_USERNAME` 时在探测 SSH 与触碰 VPS 前失败。`--dry-run` 仍输出完整远端脚本，但不输出 token。

- [ ] **Step 3: 改造远端部署脚本**

保留现有脏工作区检查、`.env` HTTPS 前置检查和 `git pull --ff-only origin main`。在拉取前将 `--expected-domain` 与 VPS `.env` 中的 `PM_DOMAIN` 比对；不一致时停止，避免把 API 基址错误的 Web 镜像部署上去。随后拉取代码，并比对 VPS `HEAD` 与 `--expected-revision`；不匹配时在容器操作前停止，避免部署过期 Actions run 的镜像与较新 Compose 配置混搭。

用 `mktemp -d` 创建临时 `DOCKER_CONFIG`，注册 `EXIT` trap 清理目录；执行 `docker login ghcr.io --username <GHCR_USERNAME> --password-stdin`，随后 `docker compose ... pull`，退出登录并清理凭据，再执行 `docker compose ... up -d --no-build --remove-orphans`。保留现有 API/Web 探活和失败日志。

部署成功后只列出 API 与 Web 的目标 GHCR 仓库镜像，保留本次与上一个本地版本，用不带 `--force` 的 `docker image rm` 清理更早的本项目镜像；移除 VPS 上不再使用的 builder cache prune，因为 VPS 将不再构建镜像。清理失败只记警告，不改变已健康部署的结果。

- [ ] **Step 4: 用原有部署测试命令验证**

Run: `pytest tests/test_deploy_vps.py -q`
Expected: 所有部署脚本单元测试通过；脚本生成的远端命令没有 `--build`、没有全局 prune、没有 token 字面值。

- [ ] **Step 5: 提交本任务**

```bash
git add scripts/deploy_vps.py tests/test_deploy_vps.py
git commit -m "feat(deploy): VPS 通过 SSH 拉取不可变镜像"
```

### Task 3: Actions 构建、发布、部署与回滚

**Files:**
- Modify: `.github/workflows/deploy-vps.yml`
- Create: `.github/workflows/container-images.yml`
- Test: `tests/test_deploy_vps.py`

**Interfaces:**
- `container-images.yml`：PR 上构建 API/Web Docker 镜像，不登录、不推送、不部署。
- `deploy-vps.yml`：`main` push 构建并推送 GHCR digest；deploy job 依赖 build job，并把 digest 传入 `scripts/deploy_vps.py`。
- 手动回滚：workflow dispatch 必须同时给出 API 与 Web digest；输入不完整或仓库路径不属于本项目时拒绝运行。

- [ ] **Step 1: 先写 workflow 合同测试**

在 `DeployVpsWorkflowContractTest` 中增加断言：PR 镜像 workflow 只有 `pull_request` 触发且没有 `packages: write`、VPS secrets 或 SSH 步骤；生产 workflow 的 build job 有 `packages: write`、两个镜像均推送并输出 digest；deploy job 依赖 build、只给 `packages: read`、传递镜像与 `github.sha`；手动回滚要求两份本仓库 GHCR digest；`NEXT_PUBLIC_API_BASE` 来源于 `vars.PM_DOMAIN`；所有第三方 actions 使用固定 commit SHA。

Run: `pytest tests/test_deploy_vps.py -q -k DeployVpsWorkflowContractTest`
Expected: 新增 workflow 合同测试失败。

- [ ] **Step 2: 新建 PR 容器构建验证 workflow**

新增 `container-images.yml`，只对 `pull_request` 运行；使用只读 `contents: read` 权限、固定版本的 checkout/buildx actions，分别构建 `docker/api.Dockerfile` 与 `docker/web.Dockerfile`，Web 构建参数使用非生产验证地址。两个 build 都设为不推送，且 workflow 不读取 production environment、SSH secrets 或生产 token。

- [ ] **Step 3: 为生产 workflow 拆分 build 与 deploy jobs**

validate job 先确认主线 ref 和 `PM_DOMAIN` 非空且为有效 DNS 名称，再输出 `pm_domain`。build job 只在 `main` push 或 `main` 上的普通手动 dispatch 推送镜像；将 `GITHUB_REPOSITORY` 转为小写，构造 GHCR 的 `-api`、`-web` 两个 package 名；使用 `GITHUB_TOKEN` 登录 GHCR，权限为 `contents: read` 与 `packages: write`；Web build arg 使用 validate job 输出的 `https://${{ needs.validate.outputs.pm_domain }}/api/v1`。镜像 tag 包含完整 commit SHA，并将 build action 输出 digest 作为后续 job output。API/Web build 都启用 BuildKit `type=gha` cache-from/cache-to，避免每次 Actions 构建从头安装依赖。

deploy job 只在 build 成功后运行，使用 production environment 中已存在的 SSH secrets，权限限制为 `contents: read` 与 `packages: read`。通过 `GHCR_TOKEN` 环境变量把 `GITHUB_TOKEN` 交给部署脚本，用户名使用 `github.actor`，并将同一个 `PM_DOMAIN` 作为 `--expected-domain` 传入；令牌只经 SSH stdin 到远端。保持严格 host key 校验和现有 `production-vps-deploy` concurrency。

- [ ] **Step 4: 增加手动镜像回滚入口**

增加独立的 `validate` job 检查手动输入：`api_image`、`web_image` 必须同时为空或同时填写；填写时要匹配本仓库对应 package 的 digest 格式。validate 输出 `mode=build|rollback`；build job 只在 `mode=build` 时运行，deploy job 仅在 validate 成功且（mode 为 rollback 或 build 成功）时运行。这样输入不完整时会明确失败，不会静默跳过发布。手动输入路径仍只允许从 `main` 分支启动，且使用当前 `github.sha` 对齐 VPS Compose 配置。

- [ ] **Step 5: 跑 workflow 合同测试和静态校验**

Run: `pytest tests/test_deploy_vps.py -q -k DeployVpsWorkflowContractTest`
Expected: workflow 合同测试通过。若 `actionlint` 已安装，运行 `actionlint .github/workflows/container-images.yml .github/workflows/deploy-vps.yml`；否则依靠新增 PR workflow 和 GitHub Actions 实际解析验证。

- [ ] **Step 6: 提交本任务**

```bash
git add .github/workflows/container-images.yml .github/workflows/deploy-vps.yml tests/test_deploy_vps.py
git commit -m "feat(ci): Actions 构建并发布 GHCR 镜像"
```

### Task 4: 更新运维文档并验证交付路径

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `TESTING.md`

- [ ] **Step 1: 更新部署架构说明**

说明 PR 镜像构建只验证不推送；合并到 `main` 后 Actions 构建和推送两个 GHCR 镜像，VPS 通过 digest 拉取并部署；VPS 仍需从 Git 拉取 Compose 配置，但不再需要访问 PyPI/npm 或执行 Docker build。

- [ ] **Step 2: 更新 GitHub 与 VPS 配置说明**

保留已有 `VPS_SSH_PRIVATE_KEY`、`VPS_SSH_KNOWN_HOSTS` 配置说明；新增仓库 Actions variable `PM_DOMAIN`，要求与 `/opt/pm/.env` 一致；说明 GitHub Actions `GITHUB_TOKEN` 的 package 权限及 GHCR package 必须允许本仓库访问。注明不需要在 VPS 保存长期 PAT，部署时 token 临时经 SSH stdin 使用。

- [ ] **Step 3: 记录回滚和故障排查方法**

说明如何从 GHCR 找到 API/Web 两个 digest 并用 Actions 的 `workflow_dispatch` 同时传入；说明数据库 migration 已运行时，镜像回滚不能自动回滚数据库，需遵循现有 migration 向后兼容策略。更新本机手动部署命令，要求传入两份 digest 与 `GHCR_TOKEN`，并注明它只用于故障排查。

- [ ] **Step 4: 按仓库规则执行目标验证**

Run: `pytest tests/test_deploy_vps.py -q`
Expected: 所有目标部署测试通过。PR 中确认 `container-images` 成功；合并后的 `deploy-vps` 应记录当前 commit SHA、两个 GHCR digest，以及 API/Web 健康检查结果。

- [ ] **Step 5: 提交文档**

```bash
git add README.md AGENTS.md TESTING.md
git commit -m "docs(deploy): 更新 GHCR 镜像发布与回滚说明"
```

## 首次发布前置检查

- [ ] 已在仓库 Actions variables 配置 `PM_DOMAIN`，值与 VPS `/opt/pm/.env` 中完全一致。
- [ ] GHCR 两个 package 由本仓库 workflow 发布，且 package settings 允许本仓库的 `GITHUB_TOKEN` 读写。
- [ ] 通过只读 SSH 预检确认 VPS 架构与 Actions 发布平台兼容、Docker Compose 支持 `!reset`、磁盘空间足够容纳遗留本地构建产物、当前镜像及一个回滚版本。
- [ ] 先由 PR 容器构建 workflow 验证 Dockerfile；合并后再由 `deploy-vps` 首次生产发布，不在 PR 阶段连接生产 VPS。
