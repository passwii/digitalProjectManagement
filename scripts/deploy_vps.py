#!/usr/bin/env python3
"""Deploy the production stack on the VPS from the local Mac."""

from __future__ import annotations

import subprocess
import sys


VPS_USER = "root"
VPS_HOST = "145.79.143.98"
APP_DIR = "/opt/pm"
BRANCH = "main"
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.prod.yml")


def build_remote_script() -> str:
    compose_args = " ".join(f"-f {name}" for name in COMPOSE_FILES)
    return f"""set -euo pipefail
cd {APP_DIR}
git pull --ff-only origin {BRANCH}
docker compose {compose_args} up -d --build --remove-orphans
docker compose {compose_args} ps
curl -fsS http://127.0.0.1:8001/health
printf '\\n'
"""


def main() -> int:
    target = f"{VPS_USER}@{VPS_HOST}"
    print(f"Deploying {BRANCH} on {target}:{APP_DIR}")

    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        target,
        build_remote_script(),
    ]

    try:
        subprocess.run(command, check=True)
    except FileNotFoundError:
        print("ssh command not found", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"deployment failed with exit code {exc.returncode}", file=sys.stderr)
        return exc.returncode

    print("deployment completed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
