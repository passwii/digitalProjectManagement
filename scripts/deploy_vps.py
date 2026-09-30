#!/usr/bin/env python3
"""Deploy the production stack on the VPS from the local Mac."""

from __future__ import annotations

import argparse
import subprocess
import sys


VPS_USER = "root"
VPS_HOST = "145.79.143.98"

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


def build_remote_script(
    app_dir: str = DEFAULT_APP_DIR,
    branch: str = DEFAULT_BRANCH,
    compose_files: tuple[str, ...] = DEFAULT_COMPOSE_FILES,
) -> str:
    """渲染远端要执行的脚本。纯字符串拼装，方便测试直接断言内容。"""
    compose_args = " ".join(f"-f {name}" for name in compose_files)
    health_checks = "\n".join(
        f'wait_for_health "{url}" "{label}" "{HEALTH_ATTEMPTS}"'
        for label, url in HEALTH_TARGETS
    )
    return f"""set -euo pipefail
cd {app_dir}

# 服务器上被手改过就先停下。放任它走到 `git pull --ff-only` 只会抛一句
# "Your local changes would be overwritten"，看不出是谁改的哪个文件。
if [ -n "$(git status --porcelain)" ]; then
  echo "部署中止：{app_dir} 存在未提交改动，请先在服务器上处理或回滚：" >&2
  git status --short >&2
  exit 1
fi

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
echo "部署完成"
"""


def build_ssh_command(target: str, script: str) -> list[str]:
    return [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        # 构建镜像可能几分钟没输出。没有保活会被中间设备静默掐断，
        # 表现成「本地莫名超时」而不是「远端还在构建」。
        "-o",
        "ServerAliveInterval=15",
        target,
        script,
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 main 部署到 VPS")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印将要执行的远端脚本，不连接服务器",
    )
    args = parser.parse_args(argv)

    script = build_remote_script()
    target = f"{VPS_USER}@{VPS_HOST}"

    if args.dry_run:
        print(script)
        return 0

    print(f"正在部署 {DEFAULT_BRANCH} 到 {target}:{DEFAULT_APP_DIR}", flush=True)

    try:
        subprocess.run(build_ssh_command(target, script), check=True)
    except FileNotFoundError:
        print("未找到 ssh 命令", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"部署失败，退出码：{exc.returncode}", file=sys.stderr)
        return exc.returncode

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
