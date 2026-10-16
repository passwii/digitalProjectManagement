#!/bin/sh
# 本地开发用的 SSH 隧道入口：把 VPS 上的 PostgreSQL 转发到本机 5432。
# 由 docker-compose.local.yml 的 db-tunnel 服务以 `sh /scripts/db_tunnel.sh` 启动。
#
# 为什么要在建隧道之前先探活：机房侧 IPv4 出现过「22 端口收 SYN、SSH banner
# 永远不来」的半死状态，直接 ssh 就是干等 20 秒然后失败。这里按序换地址，
# v4 不通自动走 v6。
#
# 覆盖入口（默认值就在下面，docker-compose 只做透传）：
#   VPS_SSH_HOST=x.x.x.x   强制只走这一个地址，跳过探活
#   VPS_SSH_HOSTS="a b"    换整个候选列表，顺序即优先级
#   VPS_SSH_USER=someone   换登录用户
#
# 候选列表必须与 scripts/deploy_vps.py 的 VPS_HOSTS 一致（同一台机器、同两条
# 链路），tests/test_local_tunnel.py 会守住这个同步。
set -eu

USER_NAME="${VPS_SSH_USER:-root}"
KEY=/root/.ssh/id_ed25519
HOSTS="${VPS_SSH_HOST:-${VPS_SSH_HOSTS:-145.79.143.98 2a0e:97c0:3f0:1::2cba}}"

# 真握手一次再建隧道：只看端口会把上面说的 v4 半死链路判成可用——部署脚本
# 踩过同一个坑，所以这里用的是同一套判据（BatchMode + ConnectTimeout + `true`）。
target=""
for host in $HOSTS; do
  echo "隧道：探测 $host" >&2
  if ssh -o BatchMode=yes -o ConnectTimeout=8 -i "$KEY" "$host" true; then
    target="$host"
    break
  fi
done

if [ -z "$target" ]; then
  # 全都不通时不要空转：先用第一个顶着，ssh 失败退出后由 restart 策略重试，
  # 期间健康检查会把容器标成 unhealthy，问题不会被藏起来。
  target="${HOSTS%% *}"
  echo "隧道：候选地址都握不上手，先用 $target 顶着重试" >&2
fi

echo "隧道目标：$target" >&2
exec ssh -N \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -i "$KEY" \
  -L 0.0.0.0:5432:127.0.0.1:5432 \
  "${USER_NAME}@${target}"
