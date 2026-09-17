#!/bin/sh
set -eu

if [ -n "${DB_FORWARD_HOST:-}" ]; then
  DATABASE_URL="$(python3 -c '
from sqlalchemy.engine import make_url
import os
url = make_url(os.environ["DATABASE_URL"])
url = url.set(host=os.environ["DB_FORWARD_HOST"], port=5432)
print(url.render_as_string(hide_password=False))
')"
  export DATABASE_URL
fi

cd /app/api
alembic upgrade head

cd /app
python3 -m api.seed
exec uvicorn api.main:app --host 0.0.0.0 --port 8001
