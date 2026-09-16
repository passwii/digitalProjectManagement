FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt

COPY api /app/api
COPY scripts /app/scripts

# 数据目录（SQLite + 附件），由 compose 挂 volume 持久化
RUN mkdir -p /app/data/files

EXPOSE 8001

# 启动前建表 + 幂等种子，然后起服务
CMD ["sh", "-c", "cd /app/api && alembic upgrade head && cd /app && python3 -m api.seed && uvicorn api.main:app --host 0.0.0.0 --port 8001"]
