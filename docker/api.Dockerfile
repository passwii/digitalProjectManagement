# 多阶段构建：Golang 构建编译 + Python/Alembic 运行底座
FROM golang:1.27-alpine AS builder

WORKDIR /app/api
COPY api/go.mod api/go.sum ./
RUN go mod download

COPY api/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server main.go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/seed cmd/seed/main.go

# 运行镜像：包含 Python 3.14 (运行 alembic 迁移) + 编译好的 Go 服务二进制
FROM python:3.14-slim

ARG PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /app/api/requirements.txt

COPY api/alembic /app/api/alembic
COPY api/alembic.ini /app/api/alembic.ini
COPY api/legacy_py /app/api/legacy_py
COPY api/__init__.py /app/api/__init__.py
COPY scripts /app/scripts
COPY --from=builder /app/server /app/server
COPY --from=builder /app/seed /app/seed

# 附件目录，由 compose 挂 volume 持久化
RUN mkdir -p /app/data/files

EXPOSE 8001

# 启动前执行 alembic upgrade head + Go seed 幂等初始化，然后起 Go 进程
CMD ["/app/scripts/docker-api-entrypoint.sh"]
