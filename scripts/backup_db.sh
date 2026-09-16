#!/bin/bash
# SQLite 文件备份：拷贝 data/app.db，按日留 7 天（供 cron/launchd 每日调用）。
# 用法：scripts/backup_db.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
DB="$DATA/app.db"
BKDIR="$DATA/backups"
KEEP=7

mkdir -p "$BKDIR"
if [ ! -f "$DB" ]; then
  echo "skip: $DB not found" >&2
  exit 0
fi
TS="$(date +%F)"
cp "$DB" "$BKDIR/app-$TS.db"
# WAL 一致性：若存在 -wal/-shm 一并拷贝（恢复时成套）
[ -f "$DB-wal" ] && cp "$DB-wal" "$BKDIR/app-$TS.db-wal" || true
[ -f "$DB-shm" ] && cp "$DB-shm" "$BKDIR/app-$TS.db-shm" || true
# 仅留 7 天
ls -1t "$BKDIR"/app-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok: $BKDIR/app-$TS.db (keep $KEEP days)"
