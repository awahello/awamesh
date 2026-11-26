#!/bin/sh
# awamesh 一键安装（Docker）
#   curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/install.sh | sh
# 可选参数：
#   --dir /opt/awamesh      安装目录
#   --port 18443            面板端口
#   --wg-port 51820         WireGuard UDP 端口
#   --privileged            权限给满（cap_add 不生效时用）
set -u

DIR="${AWA_DIR:-/opt/awamesh}"
PORT="${AWA_PORT:-18443}"
WGPORT="${AWA_WG_PORT:-51820}"
PRIV=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --wg-port) WGPORT="$2"; shift 2 ;;
    --privileged) PRIV=1; shift ;;
    *) shift ;;
  esac
done

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "1/6 检查环境"
command -v docker >/dev/null 2>&1 || die "未安装 Docker：https://docs.docker.com/engine/install/"
DC="docker compose"
docker compose version >/dev/null 2>&1 || {
  command -v docker-compose >/dev/null 2>&1 && DC="docker-compose" || die "缺少 docker compose 插件"
}
ok "Docker 就绪"

say "2/6 端口避让"
busy() { command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"; }
i=0
while [ $i -lt 10 ] && busy "$PORT"; do
  warn "面板端口 $PORT 被占用，试 $((PORT + 1))"
  PORT=$((PORT + 1)); i=$((i + 1))
done
busyudp() { command -v ss >/dev/null 2>&1 && ss -lun 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"; }
i=0
while [ $i -lt 20 ] && busyudp "$WGPORT"; do
  warn "UDP $WGPORT 被占用，试 $((WGPORT + 1))"
  WGPORT=$((WGPORT + 1)); i=$((i + 1))
done
ok "面板 $PORT · WireGuard udp $WGPORT"

say "3/6 准备目录：$DIR"
mkdir -p "$DIR/data"
cd "$DIR" || die "进不去 $DIR"

SECRET="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[ -f .secret ] && SECRET="$(cat .secret)"
printf '%s' "$SECRET" > .secret && chmod 600 .secret

PRIV_LINE=""
[ "$PRIV" = "1" ] && PRIV_LINE="    privileged: true"

cat > docker-compose.yml <<YAML
services:
  awamesh:
    image: ghcr.io/awahello/awamesh:latest
    container_name: awamesh
${PRIV_LINE}
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      net.ipv4.ip_forward: "1"
    ports:
      - "${PORT}:${PORT}"
      - "${WGPORT}:${WGPORT}/udp"
    environment:
      - AWA_SECRET=${SECRET}
      - AWA_PORT=${PORT}
      - AWA_WG_PORT=${WGPORT}
      - AWA_DATA_DIR=/data
      - AWA_BACKEND=wg
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/data
    mem_limit: 192m
    restart: unless-stopped
YAML

$DC config >/dev/null 2>&1 || die "生成的 compose 解析失败，执行 $DC config 看报错"
ok "docker-compose.yml 已生成"

say "4/6 拉镜像"
$DC pull || die "拉取失败：检查 GHCR 是否可达"

say "5/6 启动"
$DC up -d --force-recreate || die "启动失败：$DC logs --tail 30 awamesh"

say "6/6 等待就绪"
n=0; ver=""
while [ "$n" -lt 30 ]; do
  sleep 2; n=$((n + 1))
  ver="$($DC exec -T awamesh node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(r=>r.json()).then(j=>console.log(j.version)).catch(()=>{})" 2>/dev/null | tr -d '\r\n')"
  [ -n "$ver" ] && break
done

echo
if [ -n "$ver" ]; then
  ok "awamesh $ver 已启动"
else
  warn "健康检查未通过，看日志：$DC logs --tail 40 awamesh"
fi

PW=""
[ -f data/initial-admin.txt ] && PW="$(sed -n 2p data/initial-admin.txt)"
[ -n "$PW" ] && ok "后台口令：$PW（已写入 $DIR/data/initial-admin.txt）"

echo
say "接口状态"
$DC logs --tail 30 awamesh 2>/dev/null | grep -F "[wg]" || warn "没有 [wg] 行，可能未托管"
if ! $DC logs --tail 40 awamesh 2>/dev/null | grep -q "已接管接口"; then
  warn "awa0 没建起来（缺 NET_ADMIN）。一步修："
  echo "    sed -i '/^    cap_add:/i\\    privileged: true' docker-compose.yml && $DC up -d --force-recreate"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

────────────────────────────────────────
 面板：http://${IP:-你的IP}:${PORT}
 口令：${PW:-见 $DIR/data/initial-admin.txt}

 下一步：
   1) 设置 → WireGuard 服务端 → Endpoint 填「公网IP:${WGPORT}」
      云厂商安全组要放行 UDP ${WGPORT}
   2) 设置 → 检测连通性，确认「已接管 awa0」
   3) 设备 → 添加设备 → 一键部署，把命令跑到 OpenWrt / Linux 上
────────────────────────────────────────
之后升级用：curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/upgrade.sh | sh
EOF
