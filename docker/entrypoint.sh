#!/bin/sh
# 容器入口：以 root 修正数据目录属主，再降权到 node 运行
set -eu

DATA="${AWA_DATA_DIR:-/data}"

# 兜底：AWA_DATA_DIR 被写坏（含空格/换行）时回退 /data
case "$DATA" in
  *" "*|*"
"*) echo "[warn] AWA_DATA_DIR 含空白字符，已回退到 /data"; DATA=/data ;;
esac
export AWA_DATA_DIR="$DATA"

mkdir -p "$DATA"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA" 2>/dev/null || true
  # 托管 WireGuard 接口需要 CAP_NET_ADMIN，必须是 root —— 非 root 进程的有效能力会被清空，
  # 即使容器给了 privileged / cap_add 也会报 RTNETLINK: Operation not permitted。
  # 只想跑面板不要接口：AWA_WG_ENABLE=0 降权到 node。
  if [ "${AWA_WG_ENABLE:-1}" = "1" ]; then
    exec node --no-warnings src/server.js
  fi
  exec su-exec node node --no-warnings src/server.js
fi

exec node --no-warnings src/server.js
