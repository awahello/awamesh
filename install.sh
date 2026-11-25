#!/bin/sh
# awamesh 一键部署（Docker）
# 用法：curl -fsSL https://raw.githubusercontent.com/<owner>/awamesh/main/install.sh | sh
#   或：sh install.sh [安装目录]
set -e

DIR="${1:-${AWA_DIR:-/opt/awamesh}}"
PORT="${AWA_PORT:-18443}"
IMAGE="${AWA_IMAGE:-ghcr.io/awahello/awamesh:latest}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "==> 1/5 检查环境"
command -v docker >/dev/null 2>&1 || die "未安装 Docker，请先安装：https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "缺少 docker compose 插件"
fi
echo "    Docker 就绪，安装目录：$DIR"

# 端口占用自动避让（18443 起，往后找 10 个）
if command -v ss >/dev/null 2>&1; then
  i=0
  while [ $i -lt 10 ]; do
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$"; then
      echo "    端口 $PORT 已被占用，尝试 $((PORT + 1))"
      PORT=$((PORT + 1)); i=$((i + 1))
    else
      break
    fi
  done
fi

say "==> 2/5 准备目录"
mkdir -p "$DIR/data"
cd "$DIR"

say "==> 3/5 写入 compose"
if [ -f docker-compose.yml ] && [ -z "$AWA_FORCE" ]; then
  warn "    已存在 docker-compose.yml，跳过写入（要覆盖请设 AWA_FORCE=1）"
else
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > docker-compose.yml <<YAML
services:
  awamesh:
    image: ${IMAGE}
    container_name: awamesh
    ports:
      - "${PORT}:${PORT}"
    environment:
      - AWA_SECRET=${SECRET}
      - AWA_PORT=${PORT}
      - AWA_DATA_DIR=/data
      - AWA_MODE=full
      - AWA_BACKEND=mock
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/data
    mem_limit: 192m
    restart: unless-stopped
YAML
  echo "    已生成（含随机 AWA_SECRET）"
fi

say "==> 4/5 启动"
if [ -f docker/Dockerfile ]; then
  echo "    检测到源码目录，本地构建镜像（首次约 1 分钟）"
  $DC up -d --build
else
  $DC pull -q || warn "    拉取镜像失败，请确认镜像名或网络"
  $DC up -d
fi

say "==> 5/5 等待就绪"
i=0
while [ $i -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  i=$((i+1)); sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || die "启动失败，查看日志：cd $DIR && $DC logs"

echo
say "部署完成"
echo "  面板：http://<服务器IP>:${PORT}"
if [ -f "$DIR/data/initial-admin.txt" ]; then
  echo "  首次口令：$(sed -n 2p "$DIR/data/initial-admin.txt")"
  echo "  （已保存到 $DIR/data/initial-admin.txt，登录后请修改）"
else
  echo "  首次口令见：$DIR/data/initial-admin.txt 或 $DC logs awamesh"
fi
echo
echo "  下一步：登录后在「设备 → 添加设备」生成一次性密钥，"
echo "         把命令贴到 OpenWrt / Linux / Windows 上执行。"
