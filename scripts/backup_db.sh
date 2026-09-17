#!/bin/bash
# PostgreSQL 备份：按日保留 7 天（供 cron/launchd 每日调用）。
# 用法：DATABASE_URL=postgresql://... scripts/backup_db.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BKDIR="${BACKUP_DIR:-$ROOT/data/backups}"
KEEP=7

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

mkdir -p "$BKDIR"
TS="$(date +%F_%H%M%S)"
OUT="$BKDIR/postgres-$TS.dump"
pg_dump "$DATABASE_URL" --format=custom --file="$OUT"
find "$BKDIR" -name 'postgres-*.dump' -type f | sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok: $OUT (keep $KEEP files)"
