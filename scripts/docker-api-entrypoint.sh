#!/bin/sh
set -eu

/app/migrate

if [ -f /app/seed ]; then
  /app/seed
fi

exec /app/server
