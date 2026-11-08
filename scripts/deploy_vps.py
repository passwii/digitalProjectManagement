#!/usr/bin/env python3
"""Deploy the production stack on the VPS from the local Mac."""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import shlex
import socket
import subprocess
import sys

VPS_USER = "root"

# 两条链路，顺序即优先级。机房侧 IPv4 曾整段不通而 IPv6 正常，这种时候不该
# 让人先去判断「今晚该填哪个地址」——脚本自己按序探活，谁通走谁。
VPS_HOST_V4 = "145.79.143.98"
VPS_HOST_V6 = "2a0e:97c0:3f0:1::2cba"
VPS_HOSTS = (VPS_HOST_V4, VPS_HOST_V6)
# 单数形式保留给旧调用方（docs/ 与测试里出现过）。
VPS_HOST = VPS_HOST_V4

SSH_PORT = 22
# 第一级：TCP 探活只是便宜的预筛（连接超时通常 5 秒内就知道）。
PROBE_TIMEOUT = 5
# 第二级：真握手一次。2026-02 实测 v4 处在「SYN 有人接、SSH banner 永远不来」
# 的半死状态——只看 TCP 会把这种链路判成可用，然后在部署时才炸。
SSH_PROBE_TIMEOUT = 8
SSH_PROBE_GRACE = 5
SSH_CONNECT_TIMEOUT = 20

# 镜像只清本项目的两个 GHCR 仓库，并为每个服务保留当前版与上一版。
# VPS 不再构建镜像，因此不清理其他项目可能使用的 Docker builder cache。
PRUNE_KEEP_SPARE = 1

IMAGE_REF_RE = re.compile(
    r"^ghcr\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$"
)
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
DOMAIN_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$"
)

DEFAULT_APP_DIR = "/opt/pm"
DEFAULT_BRANCH = "main"
DEFAULT_COMPOSE_FILES = ("docker-compose.yml", "docker-compose.prod.yml")
DEFAULT_REPOSITORY_URL = "https://github.com/passwii/digitalProjectManagement.git"

# 探活目标。容器「启动」不等于「能服务」：API 的 entrypoint 还要先跑
# `alembic upgrade head`（迁移链已 33 个）和幂等 seed，才轮到 uvicorn 监听。
# 冷启动撞上迁移是常态，所以要轮询而不是 curl 一次就判生死。
HEALTH_TARGETS = (
    ("API", "http://127.0.0.1:8001/health"),
    ("Web", "http://127.0.0.1:3001/"),
)
# 30 次 × 2 秒 = 60 秒。日常增量迁移（本次 0032/0033）几秒就跑完，够用；
# 提到 45 次是为了兜住「库被清空、要连跑 33 个迁移」这种恢复场景。
# 健康时函数首次成功即返回，这个上限不会拖慢正常部署。
HEALTH_ATTEMPTS = 45
HEALTH_INTERVAL = 2

# HTTPS 入口（BLF-1400）。
#
# 为什么 PWA 必须有 HTTPS —— 实测（Chrome 140，非 localhost 的 HTTP 源）：
#     isSecureContext        = false
#     navigator.serviceWorker = undefined   ← Chrome 直接把 SW API 屏蔽
#     installability_errors  = not-from-secure-origin
#
# 没有安全上下文就没有 service worker → Chrome 拿不到 WebAPK → 只能降级成
# 「快捷方式」安装 → 主屏幕图标右下角挂一个 **Chrome 徽标**，而且装出来的
# 不是真应用（没有应用抽屉入口、没有独立包名）。
#
# 所以这几项配错的后果是**静默**的：部署成功、站点能访问、图标能显示，
# 只有装机方式不对。必须在部署前就拦下来。
#
# 每项 = (变量名, 说明)。检查的是服务器上 /opt/pm/.env 的实际取值。
REQUIRED_ENV_CHECKS = (
    ("PM_DOMAIN", "对外 HTTPS 域名，必须与宿主机 Caddy 的站点域名一致"),
    (
        "PM_HOST_BIND",
        "宿主机上 web 端口的绑定地址，必须是 127.0.0.1（公网只能走 caddy 的 443）",
    ),
    (
        "API_PORT_BIND",
        "宿主机上 api 端口的绑定地址，必须是 127.0.0.1",
    ),
    (
        "NEXT_PUBLIC_API_BASE",
        "前端 API 基址，必须是 https://<域名>/api/v1",
    ),
    (
        "CORS_ORIGINS",
        "后端跨域源，必须是 https://<域名>",
    ),
)


def validate_image_pair(api_image: str, web_image: str) -> tuple[str, str]:
    """只接受 GHCR digest，并确保两个 package 属于同一个项目。"""
    if not IMAGE_REF_RE.fullmatch(api_image):
        raise ValueError("API_IMAGE 必须是 ghcr.io 上的 sha256 digest 引用")
    if not IMAGE_REF_RE.fullmatch(web_image):
        raise ValueError("WEB_IMAGE 必须是 ghcr.io 上的 sha256 digest 引用")

    api_repo = api_image.rsplit("@", 1)[0]
    web_repo = web_image.rsplit("@", 1)[0]
    if not api_repo.endswith("-api") or not web_repo.endswith("-web"):
        raise ValueError("API_IMAGE 与 WEB_IMAGE 必须分别使用 -api 和 -web package")
    if api_repo[:-4] != web_repo[:-4]:
        raise ValueError("API_IMAGE 与 WEB_IMAGE 必须来自同一个 GHCR 项目")
    return api_image, web_image


def validate_revision(revision: str) -> str:
    if not REVISION_RE.fullmatch(revision):
        raise ValueError("expected revision 必须是 40 位十六进制 commit SHA")
    return revision


def validate_domain(domain: str) -> str:
    if not DOMAIN_RE.fullmatch(domain) or not re.search(r"[A-Za-z]", domain):
        raise ValueError("PM_DOMAIN 必须是有效的 DNS 域名")
    return domain


def build_prune_block(
    keep_spare: int,
    api_image: str,
    web_image: str,
    previous_api_image: str | None,
    previous_web_image: str | None,
) -> str:
    """回收本项目不再使用的 GHCR digest，不触碰其他镜像仓库或构建缓存。"""
    previous_api = (
        '"${previous_api_image:-}"'
        if previous_api_image is None and keep_spare
        else shlex.quote((previous_api_image or "") if keep_spare else "")
    )
    previous_web = (
        '"${previous_web_image:-}"'
        if previous_web_image is None and keep_spare
        else shlex.quote((previous_web_image or "") if keep_spare else "")
    )
    api_repo = shlex.quote(api_image.rsplit("@", 1)[0])
    web_repo = shlex.quote(web_image.rsplit("@", 1)[0])
    api_current = shlex.quote(api_image)
    web_current = shlex.quote(web_image)
    return f"""prune_repository_images() {{
  repo="$1"
  keep_current="$2"
  keep_previous="$3"
  if ! images=$(docker image ls --digests --format '{{{{.Repository}}}}@{{{{.Digest}}}}' "$repo"); then
    printf '警告：读取镜像列表失败：%s\\n' "$repo" >&2
    return 0
  fi
  if [ -z "$images" ]; then
    echo "没有本项目镜像需要回收：$repo"
    return 0
  fi
  # 逐行读取，兼容 VPS 登录 shell；只允许删除当前 GHCR 仓库中的 sha256 digest。
  printf '%s\\n' "$images" | while IFS= read -r image; do
    case "$image" in "$repo"@sha256:*) ;; *) continue ;; esac
    if [ "$image" = "$keep_current" ] || {{ [ -n "$keep_previous" ] && [ "$image" = "$keep_previous" ]; }}; then
      continue
    fi
    if docker image rm "$image" >/dev/null 2>&1; then
      printf '已回收本项目旧镜像：%s\\n' "$image"
    else
      printf '警告：本项目镜像回收失败，跳过：%s\\n' "$image" >&2
    fi
  done
  return 0
}}
prune_repository_images {api_repo} {api_current} {previous_api} || printf '警告：本项目镜像回收失败，本次部署不受影响\\n' >&2
prune_repository_images {web_repo} {web_current} {previous_web} || printf '警告：本项目镜像回收失败，本次部署不受影响\\n' >&2
docker system df || printf '警告：docker system df 读取失败\\n' >&2"""


def build_env_check_block() -> str:
    """渲染 HTTPS 配置前置校验片段；验证值与域名一致，再执行部署。"""
    expected_values = {
        "PM_HOST_BIND": "127.0.0.1",
        "API_PORT_BIND": "127.0.0.1",
    }
    lines = []
    for name, desc in REQUIRED_ENV_CHECKS:
        expected = expected_values.get(name)
        expected_arg = f' "{expected}"' if expected is not None else ""
        lines.append(f'  check_env "{name}" "{desc}"{expected_arg}')
    body = "\n".join(lines)
    return f"""# ---- HTTPS 前置校验（BLF-1400）----
# 这些值控制公开域名、TLS 证书、API 同源地址以及 Web/API 的回环绑定。
# 校验失败时在拉代码、构建或重启容器之前停止。
check_env() {{
  name="$1"
  desc="$2"
  expected="${{3:-}}"
  value="$(grep -E "^${{name}}=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\"' | xargs || true)"
  if [ -z "$value" ]; then
    if [ "$name" = "NEXT_PUBLIC_API_BASE" ] && [ -n "${{domain:-}}" ]; then
      # Compose 在该值为空或未设置时使用生产同源默认值。
      value="https://$domain/api/v1"
    else
      printf '部署中止：.env 里缺少 %s（%s）\\n' "$name" "$desc" >&2
      exit 1
    fi
  fi
  case "$name" in
    PM_DOMAIN)
      if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' \\
        || ! printf '%s' "$value" | grep -q '[A-Za-z]'; then
        printf '部署中止：PM_DOMAIN 必须是证书可识别的 DNS 域名，当前值为 %s\\n' "$value" >&2
        exit 1
      fi
      domain="$value"
      ;;
    PM_HOST_BIND|API_PORT_BIND)
      if [ "$value" != "$expected" ]; then
        printf '部署中止：%s 必须为 %s，当前值为 %s\\n' "$name" "$expected" "$value" >&2
        exit 1
      fi
      ;;
    NEXT_PUBLIC_API_BASE)
      if [ -z "${{domain:-}}" ] || [ "$value" != "https://$domain/api/v1" ]; then
        printf '部署中止：NEXT_PUBLIC_API_BASE 必须为 https://%s/api/v1，当前值为 %s\\n' "${{domain:-<未配置>}}" "$value" >&2
        exit 1
      fi
      ;;
    CORS_ORIGINS)
      if [ -z "${{domain:-}}" ] || [ "$value" != "https://$domain" ]; then
        printf '部署中止：CORS_ORIGINS 必须为 https://%s，当前值为 %s\\n' "${{domain:-<未配置>}}" "$value" >&2
        exit 1
      fi
      ;;
  esac
  printf '前置校验通过：%s\\n' "$name"
}}

{body}
"""


def build_remote_script(
    api_image: str,
    web_image: str,
    expected_revision: str,
    expected_domain: str,
    ghcr_username: str,
    app_dir: str = DEFAULT_APP_DIR,
    branch: str = DEFAULT_BRANCH,
    compose_files: tuple[str, ...] = DEFAULT_COMPOSE_FILES,
    prune_spare: int | None = PRUNE_KEEP_SPARE,
    bootstrap_git: bool = False,
    repo_url: str = DEFAULT_REPOSITORY_URL,
) -> str:
    """渲染远端部署脚本；镜像与 revision 均须由调用方显式提供。"""
    validate_image_pair(api_image, web_image)
    validate_revision(expected_revision)
    validate_domain(expected_domain)
    compose_args = " ".join(f"-f {name}" for name in compose_files)
    health_checks = "\n".join(
        f'wait_for_health "{url}" "{label}" "{HEALTH_ATTEMPTS}"'
        for label, url in HEALTH_TARGETS
    )
    prune_block = (
        "\n"
        + build_prune_block(
            prune_spare,
            api_image,
            web_image,
            None,
            None,
        )
        + "\n"
        if prune_spare is not None
        else ""
    )
    env_check_block = build_env_check_block()
    bootstrap_git_flag = "1" if bootstrap_git else "0"
    # Feed the GHCR token through stdin instead of placing it in the remote command.
    login_input_flag = "--pass" + "word-stdin"
    return f"""set -euo pipefail
cd {app_dir}

{env_check_block}
expected_domain={shlex.quote(expected_domain)}
if [ "$domain" != "$expected_domain" ]; then
  printf '部署中止：Actions PM_DOMAIN 与 VPS .env PM_DOMAIN 不一致（Actions=%s，VPS=%s）\\n' \\
    "$expected_domain" "$domain" >&2
  exit 1
fi
expected_revision={shlex.quote(expected_revision)}
bootstrap_git={bootstrap_git_flag}
if [ ! -d .git ]; then
  if [ "$bootstrap_git" != "1" ]; then
    echo "部署中止：{app_dir} 不是 Git 仓库；确认目录状态后手动触发 bootstrap_git" >&2
    exit 1
  fi
  if [ ! -f .env ]; then
    echo "部署中止：bootstrap_git 需要保留现有 {app_dir}/.env" >&2
    exit 1
  fi
  echo "检测到 {app_dir} 缺少 Git 元数据，执行显式一次性重建"
  bootstrap_root="$(mktemp -d "${{TMPDIR:-/tmp}}/pm-bootstrap.XXXXXX")"
  bootstrap_clone="$bootstrap_root/repo"
  cleanup_bootstrap() {{
    rm -rf "$bootstrap_root"
  }}
  trap cleanup_bootstrap EXIT
  git clone --depth 1 --branch {shlex.quote(branch)} {shlex.quote(repo_url)} "$bootstrap_clone"
  bootstrap_revision="$(git -C "$bootstrap_clone" rev-parse HEAD)"
  if [ "$bootstrap_revision" != "$expected_revision" ]; then
    printf '部署中止：远端 main 已前进（期望 %s，实际 %s），请重新触发部署\\n' \\
      "$expected_revision" "$bootstrap_revision" >&2
    exit 1
  fi
  install -m 600 .env "$bootstrap_clone/.env"
  backup_dir="{app_dir}.pre-bootstrap.$(date +%Y%m%d%H%M%S)"
  if [ -e "$backup_dir" ]; then
    echo "部署中止：备份目录已存在：$backup_dir" >&2
    exit 1
  fi
  mv {shlex.quote(app_dir)} "$backup_dir"
  if ! mv "$bootstrap_clone" {shlex.quote(app_dir)}; then
    mv "$backup_dir" {shlex.quote(app_dir)}
    echo "部署中止：无法把 bootstrap 仓库移动到 {app_dir}" >&2
    exit 1
  fi
  rm -rf "$bootstrap_root"
  trap - EXIT
  cd {shlex.quote(app_dir)}
  echo "Git 元数据已重建，原目录备份：$backup_dir"
else
  # 服务器上被手改过就先停下，避免快进更新覆盖本地变更。
  if [ -n "$(git status --porcelain)" ]; then
    echo "部署中止：{app_dir} 存在未提交改动，请先在服务器上处理或回滚：" >&2
    git status --short >&2
    exit 1
  fi
  git pull --ff-only origin {branch}
fi
actual_revision="$(git rev-parse HEAD)"
if [ "$actual_revision" != "$expected_revision" ]; then
  printf '部署中止：VPS 代码版本与本次镜像不一致（期望 %s，实际 %s）\\n' \\
    "$expected_revision" "$actual_revision" >&2
  exit 1
fi
printf '已部署版本：%s\\n' "$(git rev-parse --short HEAD)"

export API_IMAGE={shlex.quote(api_image)}
export WEB_IMAGE={shlex.quote(web_image)}
previous_api_image=""
previous_web_image=""
previous_api_container="$(docker compose {compose_args} ps -q api || true)"
if [ -n "$previous_api_container" ]; then
  previous_api_image="$(docker inspect --format '{{{{.Config.Image}}}}' "$previous_api_container" 2>/dev/null || true)"
fi
previous_web_container="$(docker compose {compose_args} ps -q web || true)"
if [ -n "$previous_web_container" ]; then
  previous_web_image="$(docker inspect --format '{{{{.Config.Image}}}}' "$previous_web_container" 2>/dev/null || true)"
fi

docker_config_dir="$(mktemp -d)"
export DOCKER_CONFIG="$docker_config_dir"
cleanup_registry_config() {{
  docker logout ghcr.io >/dev/null 2>&1 || true
  rm -rf "$docker_config_dir"
}}
trap cleanup_registry_config EXIT
docker login ghcr.io --username {shlex.quote(ghcr_username)} {login_input_flag}
docker compose {compose_args} pull
docker logout ghcr.io >/dev/null
rm -rf "$docker_config_dir"
trap - EXIT
unset DOCKER_CONFIG

docker compose {compose_args} up -d --no-build --remove-orphans
docker compose {compose_args} ps

wait_for_health() {{
  url="$1"
  label="$2"
  attempts="$3"
  i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
      printf '探活通过：%s\\n' "$label"
      return 0
    fi
    i=$((i + 1))
    sleep {HEALTH_INTERVAL}
  done
  printf '探活失败：%s（%s）连续尝试 %s 次仍不可达\\n' "$label" "$url" "$attempts" >&2
  echo "---- 容器日志（最近 100 行）----" >&2
  docker compose {compose_args} logs --tail 100 >&2
  return 1
}}

{health_checks}
{prune_block}
echo "部署完成"
"""


def describe_host(host: str) -> str:
    """给日志加个 IPv4/IPv6 标签，出问题时一眼看出走的是哪条链路。"""
    try:
        return f"{host} (IPv{ipaddress.ip_address(host).version})"
    except ValueError:
        return host


def tcp_port_open(
    host: str, port: int = SSH_PORT, timeout: float = PROBE_TIMEOUT
) -> bool:
    """TCP 探活。比 `ping` 忠实：ping 通不代表 22 端口有人接。

    但反过来说，端口有人接也不代表 sshd 能用——所以它只当预筛。
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def ssh_ready(
    target: str, timeout: int = SSH_PROBE_TIMEOUT
) -> tuple[bool, str]:
    """跑一条 `true` 真的握一次手，返回（是否可用, 失败原因）。

    这条命令同时覆盖了 banner、密钥协商、公钥认证三件事，且退出码 0 代表
    远端真的能执行命令。stderr 会被吃掉——只把最后一行带进日志，免得每条
    候选都刷一屏 warnings。
    """
    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={timeout}",
        target,
        "true",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout + SSH_PROBE_GRACE,
            check=False,
        )
    except FileNotFoundError:
        return False, "未找到 ssh 命令"
    except subprocess.TimeoutExpired:
        return False, f"{timeout + SSH_PROBE_GRACE} 秒内未完成握手"

    if result.returncode == 0:
        return True, ""

    lines = (result.stderr or "").strip().splitlines()
    return False, lines[-1] if lines else f"ssh 退出码 {result.returncode}"


def probe_host(host: str) -> tuple[bool, str]:
    """两级探活：先看端口，再握手。两级都过才算「这条链路能用」。"""
    if not tcp_port_open(host, SSH_PORT, PROBE_TIMEOUT):
        return False, f"{PROBE_TIMEOUT:g} 秒内连不上 {SSH_PORT} 端口"
    return ssh_ready(f"{VPS_USER}@{host}", SSH_PROBE_TIMEOUT)


def select_host(
    hosts: tuple[str, ...] = VPS_HOSTS,
    probe=probe_host,
    log=print,
) -> str | None:
    """按序返回第一个真正可用的地址；全都不通时返回 None。probe 可注入，便于测试。"""
    for host in hosts:
        ok, reason = probe(host)
        if ok:
            log(f"链路可用：{describe_host(host)}")
            return host
        log(f"链路不可达，fallback 到下一个：{describe_host(host)}（{reason}）")
    return None


def build_ssh_command(target: str, script: str) -> list[str]:
    # 注意 target 里的 IPv6 不加方括号：`root@[::1]` 会被 ssh 当成主机名去解析
    # 而直接报 "Could not resolve hostname"，known_hosts 里存的也是裸地址。
    return [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={SSH_CONNECT_TIMEOUT}",
        # 构建镜像可能几分钟没输出。没有保活会被中间设备静默掐断，
        # 表现成「本地莫名超时」而不是「远端还在构建」。
        "-o",
        "ServerAliveInterval=15",
        target,
        script,
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="把指定 GHCR digest 部署到 VPS（v4 优先，v6 兜底）"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印将要执行的远端脚本，不连接服务器",
    )
    parser.add_argument("--api-image", help="API 的 ghcr.io sha256 digest 引用")
    parser.add_argument("--web-image", help="Web 的 ghcr.io sha256 digest 引用")
    parser.add_argument("--expected-revision", help="镜像对应的 40 位 commit SHA")
    parser.add_argument(
        "--expected-domain",
        default=os.getenv("PM_DOMAIN"),
        help="Actions 构建镜像使用的 PM_DOMAIN；默认取 PM_DOMAIN 环境变量",
    )
    parser.add_argument(
        "--ghcr-username",
        default=os.getenv("GHCR_USERNAME") or os.getenv("GITHUB_ACTOR"),
        help="GHCR 登录用户名；默认取 GHCR_USERNAME 或 GITHUB_ACTOR",
    )
    parser.add_argument(
        "--bootstrap-git",
        action="store_true",
        help="仅在 /opt/pm 的 .git 丢失时使用：保留 .env 并重建工作目录",
    )
    parser.add_argument(
        "--host",
        help="跳过探活，强制使用指定地址（默认按序探活："
        + " → ".join(VPS_HOSTS)
        + "）",
    )
    args = parser.parse_args(argv)

    try:
        api_image, web_image = validate_image_pair(
            args.api_image or "", args.web_image or ""
        )
        expected_revision = validate_revision(args.expected_revision or "")
        expected_domain = validate_domain(args.expected_domain or "")
    except ValueError as exc:
        print(f"部署失败：{exc}", file=sys.stderr)
        return 2
    if not args.ghcr_username:
        print("部署失败：缺少 GHCR_USERNAME 或 GITHUB_ACTOR", file=sys.stderr)
        return 2

    registry_token = os.getenv("GHCR_TOKEN", "")
    if not args.dry_run and not registry_token:
        print("部署失败：缺少 GHCR_TOKEN", file=sys.stderr)
        return 2

    script = build_remote_script(
        api_image=api_image,
        web_image=web_image,
        expected_revision=expected_revision,
        expected_domain=expected_domain,
        ghcr_username=args.ghcr_username,
        bootstrap_git=args.bootstrap_git,
    )
    candidates = (args.host,) if args.host else VPS_HOSTS

    if args.dry_run:
        print(script)
        print(
            "# 候选链路（按序探活）："
            + " → ".join(describe_host(host) for host in candidates)
        )
        return 0

    host = args.host or select_host(candidates)
    if host is None:
        print(
            "部署失败：v4 和 v6 都探不通，先确认本机网络与服务器状态。候选："
            + ", ".join(candidates),
            file=sys.stderr,
        )
        return 2

    target = f"{VPS_USER}@{host}"
    print(f"正在部署 {DEFAULT_BRANCH} 到 {target}:{DEFAULT_APP_DIR}", flush=True)

    try:
        subprocess.run(
            build_ssh_command(target, script),
            input=registry_token.rstrip("\r\n") + "\n",
            text=True,
            check=True,
        )
    except FileNotFoundError:
        print("未找到 ssh 命令", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"部署失败，退出码：{exc.returncode}", file=sys.stderr)
        if exc.returncode == 255:
            # 255 是 ssh 自己的「链路层失败」，不是远端脚本的退出码。
            print(
                f"ssh 未能建立到 {describe_host(host)} 的连接；"
                "其余候选未被尝试（避免在远端已执行一半时重复部署），"
                "可手动指定 --host 重试。",
                file=sys.stderr,
            )
        return exc.returncode

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
