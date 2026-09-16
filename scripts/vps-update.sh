#!/bin/bash
# VPS 更新脚本：在 VPS 上运行，一键同步 GitHub main 并重建上线。
#
# 用法（本地执行）：
#   ssh root@145.79.143.98 'bash /opt/pm/scripts/vps-update.sh'
#
# 流程：备份数据卷 → reset 到 origin/main → compose 重新构建启动 → 健康检查 → 清理旧镜像。
# 注意：VPS 上 tracked 文件的本地修改会被丢弃（以 GitHub 为准）；
# docker-compose.prod.yml（含 APP_SECRET）是 untracked，不受影响也不会被提交。

set -euo pipefail
cd /opt/pm

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
VOLUME="pm_pm-data"
BACKUP_DIR="/opt/pm-backups"
KEEP=7

echo "[1/5] 备份数据卷 ${VOLUME} ..."
mkdir -p "${BACKUP_DIR}"
TS="$(date +%F-%H%M)"
docker run --rm -v "${VOLUME}:/data" -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/pm-data-${TS}.tgz" -C /data .
ls -1t "${BACKUP_DIR}"/pm-data-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok: ${BACKUP_DIR}/pm-data-${TS}.tgz (keep ${KEEP})"

echo "[2/5] 同步 GitHub main ..."
git fetch origin
git checkout -q main
git reset -q --hard origin/main
git log --oneline -1

echo "[3/5] 构建并启动 ..."
# shellcheck disable=SC2086
${COMPOSE} up --build -d

echo "[4/5] 健康检查 ..."
for i in $(seq 1 30); do
  if curl -sf -m 3 http://127.0.0.1:8001/health >/dev/null; then
    echo "api healthy"
    break
  fi
  sleep 4
  if [ "$i" -eq 30 ]; then
    echo "api unhealthy, recent logs:"
    ${COMPOSE} logs --tail=30 api
    exit 1
  fi
done
curl -sf -m 5 -o /dev/null -w "web HTTP %{http_code}\n" http://127.0.0.1:3001/login

echo "[5/5] 清理旧镜像 ..."
docker image prune -f >/dev/null
${COMPOSE} ps
echo "update done"
