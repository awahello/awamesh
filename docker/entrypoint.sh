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
  exec su-exec node node --no-warnings src/server.js
fi

exec node --no-warnings src/server.js
