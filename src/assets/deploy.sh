#!/bin/sh
# awamesh 一键部署（受控端执行，需 root）
# 用法：curl -fsSL '@@SERVER@@/dp/@@TOKEN@@' | sh -s -- [--iface awa0] [--hostname 名字]
set -u

SERVER="@@SERVER@@"
TOKEN="@@TOKEN@@"
IFACE="awa0"
HOST="$(hostname 2>/dev/null || echo node)"

while [ $# -gt 0 ]; do
  case "$1" in
    --iface) IFACE="$2"; shift 2 ;;
    --hostname) HOST="$2"; shift 2 ;;
    --via) VIA="$2"; shift 2 ;;
    *) shift ;;
  esac
done

say() { echo "==> $*"; }
die() {
  echo "✗ $*" >&2
  echo "" >&2
  echo "（脚本已中止，会话保留；修好上面的问题后重跑同一条命令即可）" >&2
  exit 1
}

[ "$(id -u)" = "0" ] || die "需要 root，请用 sudo sh 或直接以 root 执行"

say "1/5 检查 WireGuard 工具"
if ! command -v wg >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache wireguard-tools >/dev/null 2>&1 || apk add --no-cache wireguard-tools
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y wireguard-tools >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y wireguard-tools >/dev/null 2>&1
  elif command -v opkg >/dev/null 2>&1; then
    opkg update >/dev/null 2>&1; opkg install kmod-tun wireguard-tools >/dev/null 2>&1
  fi
fi
command -v wg >/dev/null 2>&1 || die "这台机器装不上 wireguard-tools，请先手动安装（或换一台机器）"

say "2/5 拉取配置"
mkdir -p /etc/wireguard
umask 077
CONF="/etc/wireguard/$IFACE.conf"
curl -fsS --max-time 15 "$SERVER/api/deploy/config?token=$TOKEN" -o "$CONF" || die "拉取配置失败：凭据可能已失效（回面板点「一键部署」重新生成），或控制台地址不可达"

if ! grep -q "^Endpoint = [^<]" "$CONF" 2>/dev/null; then
  rm -f "$CONF"
  die "配置里的 Endpoint 是空的：先在控制台「设置 → WireGuard 服务端」填公网地址:51820"
fi
ADDR="$(sed -n 's/^Address = \(.*\)$/\1/p' "$CONF" | head -1)"

say "3/5 启动接口 $IFACE"
if command -v wg-quick >/dev/null 2>&1; then
  wg-quick down "$IFACE" >/dev/null 2>&1 || true
  wg-quick up "$IFACE" || die "wg-quick 启动失败（看上面的报错；内核无 wireguard 模块时先 modprobe wireguard）"
else
  ip link del "$IFACE" >/dev/null 2>&1 || true
  ip link add dev "$IFACE" type wireguard || die "创建接口失败：内核可能没有 wireguard 模块（modprobe wireguard）"
  wg setconf "$IFACE" "$CONF" || die "wg setconf 失败"
  ip addr add "$ADDR" dev "$IFACE" >/dev/null 2>&1 || true
  MTU="$(sed -n 's/^MTU = \(.*\)$/\1/p' "$CONF" | head -1)"
  ip link set mtu "${MTU:-1420}" up dev "$IFACE" || die "启用接口失败"
fi

# ---- 兜底检测：WireGuard 20 秒内握不上手，就试 Tailscale（走 443，能穿只放行 HTTPS 的网络）----
if [ "${VIA:-auto}" != "wg" ]; then
  HS=""
  i=0
  while [ "$i" -lt 20 ]; do
    HS="$(wg show "$IFACE" latest-handshakes 2>/dev/null | awk '{print $2}' | sort -n | tail -1)"
    [ -n "$HS" ] && [ "$HS" != "0" ] && break
    sleep 1
    i=$((i + 1))
  done
  if [ -n "$HS" ] && [ "$HS" != "0" ]; then
    say "    WireGuard 已握手（${i}s），不需要兜底"
  else
    say "    WireGuard 20 秒没握上手，尝试 Tailscale 兜底"
    TSINFO="$(curl -fsS --max-time 8 "$SERVER/api/deploy/ts?token=$TOKEN" 2>/dev/null || true)"
    TS_KEY="$(printf '%s' "$TSINFO" | sed -n "s/^TS_AUTHKEY='\(.*\)'$/\1/p")"
    TS_LOGIN="$(printf '%s' "$TSINFO" | sed -n "s/^TS_LOGIN='\(.*\)'$/\1/p")"
    if [ -z "$TS_KEY" ]; then
      say "    控制台没配 Tailscale authkey：在「设置 → 兜底通道」填一个就能自动启用"
    elif command -v tailscale >/dev/null 2>&1 || command -v apk >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then
      if ! command -v tailscale >/dev/null 2>&1; then
        say "    安装 tailscale"
        if command -v apk >/dev/null 2>&1; then
          apk add --no-cache tailscale >/dev/null 2>&1 || true
        elif command -v apt-get >/dev/null 2>&1; then
          (curl -fsSL https://tailscale.com/install.sh | sh) >/dev/null 2>&1 || true
        fi
      fi
      if command -v tailscale >/dev/null 2>&1; then
        if command -v systemctl >/dev/null 2>&1; then
          systemctl enable --now tailscaled >/dev/null 2>&1 || true
        elif command -v /etc/init.d/tailscaled >/dev/null 2>&1; then
          /etc/init.d/tailscaled start >/dev/null 2>&1 || /etc/init.d/tailscale start >/dev/null 2>&1 || true
        fi
        sleep 2
        if [ -n "$TS_LOGIN" ]; then
          tailscale up --authkey "$TS_KEY" --hostname "$(hostname)-awa" --login-server "$TS_LOGIN" --accept-routes 2>&1 | tail -3
        else
          tailscale up --authkey "$TS_KEY" --hostname "$(hostname)-awa" --accept-routes 2>&1 | tail -3
        fi
        tailscale ip -4 2>/dev/null | head -1 | sed 's/^/    Tailscale 地址 /'
      else
        say "    装不上 tailscale，跳过兜底"
      fi
    fi
  fi
fi

say "4/5 上报公网地址（决定能否和其他节点直连）"
WGPORT="$(wg show "$IFACE" listen-port 2>/dev/null || echo 51820)"
PUBIP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)"
V6="$(ip -6 addr show scope global 2>/dev/null | sed -n 's/.*inet6 \([^/]*\)\/.*/\1/p' | grep -vi '^fe80' | head -1)"

# 公网 IPv4 优先（别的节点基本都有 v4）；是运营商 CGNAT（100.64/10）就退回 IPv6
ENDPOINT=""
if [ -n "${PUBIP:-}" ] && ! echo "$PUBIP" | grep -qE '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; then
  ENDPOINT="$PUBIP:$WGPORT"
elif [ -n "${V6:-}" ]; then
  ENDPOINT="[$V6]:$WGPORT"
fi

if [ -n "$ENDPOINT" ]; then
  curl -fsS -X POST "$SERVER/api/join/hit" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"endpoint\":\"$ENDPOINT\",\"port\":$WGPORT}" >/dev/null 2>&1 || true
  say "    对端地址 $ENDPOINT（别的节点可尝试直连）"
else
  say "    没有公网 IPv4/IPv6（或走了 CGNAT），P2P 直连不了，流量经控制台转发"
fi

say "5/5 安装对端自动同步（每 60 秒）"
printf '%s' "$TOKEN" > /etc/wireguard/awa.token
chmod 600 /etc/wireguard/awa.token

cat > /usr/local/bin/awa-peers <<'PEERS'
#!/bin/sh
SERVER="@@SERVER@@"
IFACE="awa0"
[ -f /etc/wireguard/awa.iface ] && IFACE="$(cat /etc/wireguard/awa.iface)"
TOKEN="$(cat /etc/wireguard/awa.token 2>/dev/null)" || exit 0
[ -n "$TOKEN" ] || exit 0
PUBIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [ -n "$PUBIP" ]; then
  curl -fsS -X POST "$SERVER/api/join/hit" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"endpoint\":\"$PUBIP:$(wg show "$IFACE" listen-port 2>/dev/null || echo 51820)\"}" >/dev/null 2>&1 || true
fi
CODE="$(curl -sS -o /tmp/awa.state -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $TOKEN" "$SERVER/api/join/state?format=shell" 2>/dev/null || echo 000)"

case "$CODE" in
  200) : ;;
  401|403)
    # 控制台已删除/吊销这台设备：把本机配置一并清掉，不留残余
    echo "awamesh: 凭据已失效（设备在控制台被删除或吊销），正在清理本机配置" >&2
    command -v wg-quick >/dev/null 2>&1 && wg-quick down "$IFACE" >/dev/null 2>&1 || true
    ip link del "$IFACE" >/dev/null 2>&1 || true
    rm -f /etc/wireguard/"$IFACE.conf" /etc/wireguard/awa.token /etc/wireguard/awa.iface
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now awa-peers.timer >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/awa-peers.timer /etc/systemd/system/awa-peers.service
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    command -v crontab >/dev/null 2>&1 && { crontab -l 2>/dev/null | grep -v awa-peers | crontab - 2>/dev/null || true; }
    rm -f /usr/local/bin/awa-peers
    echo "awamesh: 已清理（接口、配置、定时器、凭据都已移除）" >&2
    exit 0
    ;;
  *)
    exit 0
    ;;
esac

while read -r kind a b c _rest; do
      case "$kind" in
        PEER)
          # a=公钥 b=allowed-ips（含网关发布的网段） c=endpoint 或 -
          if [ -n "$c" ] && [ "$c" != "-" ]; then
            wg set "$IFACE" peer "$a" allowed-ips "$b" endpoint "$c" persistent-keepalive 25 2>/dev/null || true
          else
            wg set "$IFACE" peer "$a" allowed-ips "$b" persistent-keepalive 25 2>/dev/null || true
          fi
          ;;
        FLAG)
          # 控制台下发的角色开关：a=名字 b=值
          if [ "$a" = "forward" ] && [ "$b" = "1" ]; then
            sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || \
              (echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true)
            sysctl -qw net.ipv6.conf.all.forwarding=1 2>/dev/null || true
          fi
          ;;
      esac
    done < /tmp/awa.state
rm -f /tmp/awa.state
PEERS
printf '%s' "$IFACE" > /etc/wireguard/awa.iface
chmod +x /usr/local/bin/awa-peers

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/awa-peers.service <<'EOF'
[Unit]
Description=awamesh mesh peer refresh
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/awa-peers
EOF
  cat > /etc/systemd/system/awa-peers.timer <<'EOF'
[Unit]
Description=awamesh mesh peer refresh timer
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now awa-peers.timer >/dev/null 2>&1 || true
  /usr/local/bin/awa-peers >/dev/null 2>&1 || true
  say "    已启用 awa-peers.timer"
elif command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v awa-peers; echo "*/1 * * * * /usr/local/bin/awa-peers >/dev/null 2>&1") | crontab - 2>/dev/null || true
  /usr/local/bin/awa-peers >/dev/null 2>&1 || true
  say "    已写入 crontab（每分钟）"
else
  say "    没有 systemd/cron，对端表需手动刷新：/usr/local/bin/awa-peers"
fi

echo
echo "✓ 完成：$HOST 已接入，本机地址 $ADDR"
wg show "$IFACE" 2>/dev/null | head -12
echo
echo "回控制台刷新设备页，这台应变为「在线」；不通就看：wg show $IFACE latest-handshakes"
