#!/usr/bin/env python3
"""Deploy the production stack on the VPS from the local Mac."""

from __future__ import annotations

import argparse
import ipaddress
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

# 每轮部署都会把上一版的 `pm-web` 项掉 tag，变成无标签的悬空镜像（实测单个
# 955MB，本机总盘 15G）。回收规则：悬空镜像只留最新一个做回滚窗口，其余全清。
#
# 为什么不是 `prune -a` / `system prune`：本机除了 /opt/pm 还跑着
# /opt/pm-staging、new-api、cliproxyapi、nezha 几套栈，连 -a 都可能把别人停着
# 的容器依赖的镜像删掉；`pm-pg-data` / `pm-staging-data` 两个 volume 更是碰不得。
PRUNE_KEEP_SPARE = 1
# BuildKit 缓存与悬空镜像不同：即使镜像 tag 还在，构建层也会一直累积。实测 4 天
# 的构建把 2.2GB 缓存留在一台 15GB 的机器上，根盘一度只剩 475MB。部署完成后
# 只清 24 小时以前的缓存，保留最近一次构建层，下一次常规部署仍能复用。
PRUNE_BUILD_CACHE_UNTIL = "24h"

DEFAULT_APP_DIR = "/opt/pm"
DEFAULT_BRANCH = "main"
DEFAULT_COMPOSE_FILES = ("docker-compose.yml", "docker-compose.prod.yml")

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


def build_prune_block(keep_spare: int = PRUNE_KEEP_SPARE) -> str:
    """渲染收尾的镜像回收片段。keep_spare=0 表示悬空镜像全清、不留回滚窗口。

    只碰 `dangling=true`：有 tag 的镜像一律不动，volume 一概不碰。
    构建缓存只清超过 PRUNE_BUILD_CACHE_UNTIL 的部分，保留最近一次构建。
    整体保证退出码 0——回收出任何毛病都不能把一个健康的部署判成失败。
    """
    return f"""# ---- 回收过期构建缓存（保留最近一次构建）----
prune_stale_build_cache() {{
  # 只清超过时间窗口的层，不碰其他 Compose 项目正在使用的容器。
  if docker builder prune -f --filter "until={PRUNE_BUILD_CACHE_UNTIL}"; then
    return 0
  fi
  printf '警告：构建缓存回收失败，本次部署不受影响\\n' >&2
  return 0
}}

# ---- 回收悬空镜像（被新构建项掉 tag 的旧镜像）----
prune_dangling_images() {{
  # 先分开「列表读不到」和「确实没有悬空镜像」，否则 docker 挂了会被报告成
  # 一句太平的「没有悬空镜像可回收」。
  if ! ids=$(docker images -f dangling=true -q); then
    printf '警告：读取悬空镜像列表失败，本次跳过回收\\n' >&2
    return 0
  fi
  if [ -z "$ids" ]; then
    echo "没有悬空镜像可回收"
    return 0
  fi
  # 用 `while read` 而不是 `for id in $ids`：这段脚本由服务器上的**登录 shell**
  # 执行（这台机器上是 zsh），而 zsh 默认不对未加引号的参数展开做词分割——
  # `for` 只会迭代一次、`$id` 是整段多行字符串，结果一个镜像都删不掉，
  # 而日志看起来像「保留了一版」（实测踩过：三行 ID 被当成一版打印出来）。
  # 本地测试用 bash 跑，永远看不到这个问题，所以必须按行读。
  # `n` 在子 shell 里累加就够了：循环外不需要这个值。
  n=0
  printf '%s\n' "$ids" | while IFS= read -r id; do
    n=$((n + 1))
    if [ "$n" -le {keep_spare} ]; then
      printf '保留上一版镜像备回滚：%s\\n' "$id"
      continue
    fi
    if docker image rm "$id" >/dev/null 2>&1; then
      printf '已回收悬空镜像：%s\\n' "$id"
    else
      printf '警告：镜像 %s 回收失败，跳过\\n' "$id" >&2
    fi
  done
  return 0
}}
# 回收是收尾动作：搞坏了也不能把已经成功的部署判成失败。
prune_stale_build_cache || printf '警告：构建缓存回收出错，本次部署不受影响\\n' >&2
prune_dangling_images || printf '警告：镜像回收出错，本次部署不受影响\\n' >&2
# 同样不能裸跑：docker 挂了的话它会变成整个部署脚本的退出码。
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
    app_dir: str = DEFAULT_APP_DIR,
    branch: str = DEFAULT_BRANCH,
    compose_files: tuple[str, ...] = DEFAULT_COMPOSE_FILES,
    prune_spare: int | None = PRUNE_KEEP_SPARE,
) -> str:
    """渲染远端要执行的脚本。纯字符串拼装，方便测试直接断言内容。

    `prune_spare=None` 则整段跳过回收，用于排查时就地复现上一次的行为。
    """
    compose_args = " ".join(f"-f {name}" for name in compose_files)
    health_checks = "\n".join(
        f'wait_for_health "{url}" "{label}" "{HEALTH_ATTEMPTS}"'
        for label, url in HEALTH_TARGETS
    )
    prune_block = (
        "\n" + build_prune_block(prune_spare) + "\n" if prune_spare is not None else ""
    )
    env_check_block = build_env_check_block()
    return f"""set -euo pipefail
cd {app_dir}

# 服务器上被手改过就先停下。放任它走到 `git pull --ff-only` 只会抛一句
# "Your local changes would be overwritten"，看不出是谁改的哪个文件。
if [ -n "$(git status --porcelain)" ]; then
  echo "部署中止：{app_dir} 存在未提交改动，请先在服务器上处理或回滚：" >&2
  git status --short >&2
  exit 1
fi

{env_check_block}
git pull --ff-only origin {branch}
echo "已部署版本：$(git rev-parse --short HEAD)"

docker compose {compose_args} up -d --build --remove-orphans
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
    parser = argparse.ArgumentParser(description="把 main 部署到 VPS（v4 优先，v6 兜底）")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印将要执行的远端脚本，不连接服务器",
    )
    parser.add_argument(
        "--host",
        help="跳过探活，强制使用指定地址（默认按序探活："
        + " → ".join(VPS_HOSTS)
        + "）",
    )
    args = parser.parse_args(argv)

    script = build_remote_script()
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
        subprocess.run(build_ssh_command(target, script), check=True)
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
