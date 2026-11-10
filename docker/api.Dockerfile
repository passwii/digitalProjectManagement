# Multi-stage build: compile Go binaries, then run them from a small Go-only image.
FROM golang:1.27-alpine AS builder

WORKDIR /app/api
COPY api/go.mod api/go.sum ./
RUN go mod download

COPY api/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server main.go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/seed cmd/seed/main.go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/migrate ./cmd/migrate

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY scripts/docker-api-entrypoint.sh /app/docker-api-entrypoint.sh
COPY --from=builder /app/server /app/server
COPY --from=builder /app/seed /app/seed
COPY --from=builder /app/migrate /app/migrate

# 附件目录，由 compose 挂 volume 持久化
RUN mkdir -p /app/data/files

EXPOSE 8001

# Goose 迁移、Go seed 与 Go API 均在 Go 运行镜像中执行。
CMD ["/app/docker-api-entrypoint.sh"]
