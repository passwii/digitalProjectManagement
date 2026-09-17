FROM python:3.12-slim

ARG PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /app/api/requirements.txt

COPY api /app/api
COPY scripts /app/scripts

# 附件目录，由 compose 挂 volume 持久化
RUN mkdir -p /app/data/files

EXPOSE 8001

# 启动前建表 + 幂等种子，然后起服务
CMD ["/app/scripts/docker-api-entrypoint.sh"]
