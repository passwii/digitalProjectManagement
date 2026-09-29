# 与本机开发环境（3.14.7）和 CI（api.yml 里钉的 "3.14"）统一。
# 之前这里是 3.12，于是生产跑的是 CI 从没验证过的版本 —— CI 刚建立时
# 只能二选一，本地能实测的那个才是当初唯一有证据的选择；现在把生产也拉到 3.14，
# 三端就完全一致了。仍在 3.14 内浮动（沿用 3.12 时的写法，也与 web.Dockerfile 的
# node:20-alpine 一致），补丁版本随重建自动跟进。
FROM python:3.14-slim

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
