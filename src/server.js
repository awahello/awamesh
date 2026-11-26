import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg, log } from "./config.js";
import { api, joinPeer, peersForNode, updateNodeEndpoint, deployConfig, splitRoutes, deployTailscale, publicBase, relayAlive, exportBundle } from "./api.js";
import { seedIfEmpty, pruneEvents, addEvent, demoHeartbeat, clearDemo } from "./db.js";
import {
  ensureAdminCredential, verifyCredential, sessionToken, validSession,
  cookieHeader, clearCookieHeader,
} from "./auth.js";
import { backend } from "./backends/index.js";
import { securityHeaders, sameOriginOk, makeLimiter, clientIp, isHttps, inAllowList } from "./security.js";
import { db, setting } from "./db.js";
import { wg, setManaged } from "./wgsrv.js";
import { hostInCidr } from "./wg.js";
import { tcpProbe } from "./probe.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authed(req) {
  return validSession(parseCookies(req).awa_session);
}

async function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function joinScript(key, _hostname, base) {
  const server = base || cfg.controlUrl || `http://${hostOfControl()}`;
  return `#!/bin/sh
# awamesh 一键接入：本地生成密钥，只把公钥交给控制台
# 用法：curl -fsSL '${server}/join.sh?key=KEY' | sh -s -- [--hostname NAME] [--iface awa0]
set -eu

SERVER="\${AWA_SERVER:-${server}}"
KEY="\${AWA_KEY:-${key}}"
HOST="$(hostname)"
IFACE="awa0"

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOST="$2"; shift 2 ;;
    --iface) IFACE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "==> 1/4 检查 WireGuard 工具"
if ! command -v wg >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then apk add --no-cache wireguard-tools
  elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y wireguard-tools
  elif command -v dnf >/dev/null 2>&1; then dnf install -y wireguard-tools
  elif command -v yum >/dev/null 2>&1; then yum install -y wireguard-tools
  else echo "    无法自动安装，请先装 wireguard-tools 后重跑"; exit 1; fi
fi

echo "==> 2/4 本地生成密钥（私钥不出本机）"
mkdir -p /etc/wireguard
umask 077
[ -f /etc/wireguard/$IFACE.key ] || wg genkey > /etc/wireguard/$IFACE.key
PUB="$(wg pubkey < /etc/wireguard/$IFACE.key)"

echo "==> 2.5/4 探测公网地址（决定能不能和别的节点直连）"
WGPORT="$(wg show "$IFACE" listen-port 2>/dev/null || echo 51820)"
PUBIP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)"
V6="$(ip -6 addr show scope global 2>/dev/null | sed -n 's/.*inet6 \\([^/]*\\)\\/.*/\\1/p' | grep -vi '^fe80' | head -1)"
ENDPOINT=""
if [ -n "$PUBIP" ] && ! echo "$PUBIP" | grep -qE '^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.'; then
  ENDPOINT="$PUBIP:$WGPORT"
elif [ -n "$V6" ]; then
  ENDPOINT="[$V6]:$WGPORT"
fi
if [ -n "$ENDPOINT" ]; then echo "    对端地址 $ENDPOINT"; else echo "    没有公网 v4/v6（或 CGNAT），流量经控制台转发"; fi

echo "==> 3/4 向控制台申请地址"
RESP="$(curl -fsS -X POST "$SERVER/api/join?format=shell" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$KEY\",\"pubkey\":\"$PUB\",\"hostname\":\"$HOST\",\"endpoint\":\"$ENDPOINT\",\"port\":$WGPORT}")" || {
  echo "    申请失败，通常是密钥已被使用或过期：$RESP"; exit 1; }

for kv in $RESP; do
  k="\${kv%%=*}"; v="\${kv#*=}"
  case "$k" in
    ADDRESS) ADDR="$v" ;;
    PREFIX) PREFIX="$v" ;;
    SERVERPUB) SERVERPUB="$v" ;;
    ENDPOINT) ENDPOINT="$v" ;;
    MTU) MTU="$v" ;;
    DNS) DNSV="$v" ;;
    ALLOWED) ALLOWED="$v" ;;
    NODETOKEN) NODETOKEN="$v" ;;
  esac
done

[ -n "\${ADDR:-}" ] || { echo "    控制台没有返回地址"; exit 1; }

echo "==> 4/4 写入配置并启动"
CONF="/etc/wireguard/$IFACE.conf"
{
  echo "[Interface]"
  echo "PrivateKey = $(cat /etc/wireguard/$IFACE.key)"
  echo "Address = $ADDR/$PREFIX"
  [ -n "\${DNSV:-}" ] && echo "DNS = $DNSV"
  echo "MTU = \${MTU:-1420}"
  echo
  echo "[Peer]"
  echo "PublicKey = $SERVERPUB"
  echo "Endpoint = $ENDPOINT"
  echo "AllowedIPs = $ALLOWED"
  echo "PersistentKeepalive = 25"
} > "$CONF"
chmod 600 "$CONF"

if command -v wg-quick >/dev/null 2>&1; then
  wg-quick down "$IFACE" 2>/dev/null || true
  wg-quick up "$IFACE"
else
  ip link del "$IFACE" 2>/dev/null || true
  ip link add dev "$IFACE" type wireguard
  wg setconf "$IFACE" <(grep -v '^#' "$CONF" | sed -n '/\[Peer\]/,$p' | grep -v '^\[' || true) 2>/dev/null || true
  ip addr add "$ADDR/$PREFIX" dev "$IFACE" 2>/dev/null || true
  ip link set mtu \${MTU:-1420} up dev "$IFACE"
  wg set "$IFACE" private-key /etc/wireguard/$IFACE.key peer "$SERVERPUB" endpoint "$ENDPOINT" allowed-ips "$ALLOWED" persistent-keepalive 25
fi

echo "==> 4.5/4 安装全网状刷新（每 60 秒同步一次对端表）"
if [ -n "\${NODETOKEN:-}" ]; then
  printf '%s' "$NODETOKEN" > /etc/wireguard/awa.token
  chmod 600 /etc/wireguard/awa.token
  cat > /usr/local/bin/awa-peers <<PEERS
#!/bin/sh
SERVER="$SERVER"; IFACE="$IFACE"; TOKEN="\$(cat /etc/wireguard/awa.token)"
PUBIP="\$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "\$PUBIP" ] && curl -fsS -X POST "\$SERVER/api/join/hit" \
  -H "Authorization: Bearer \$TOKEN" -H 'Content-Type: application/json' \
  -d "{\"endpoint\":\"\$PUBIP:$(wg show \$IFACE listen-port 2>/dev/null || echo 51820)\"}" >/dev/null 2>&1 || true
CODE="\$(curl -sS -o /tmp/awa.state -w '%{http_code}' --max-time 10 \\
  -H "Authorization: Bearer \$TOKEN" "\$SERVER/api/join/state?format=shell" 2>/dev/null || echo 000)"

case "\$CODE" in
  200) : ;;
  401|403)
    echo "awamesh: 凭据已失效（设备在控制台被删除或吊销），正在清理本机配置" >&2
    command -v wg-quick >/dev/null 2>&1 && wg-quick down "\$IFACE" >/dev/null 2>&1 || true
    ip link del "\$IFACE" >/dev/null 2>&1 || true
    rm -f /etc/wireguard/"\$IFACE.conf" /etc/wireguard/awa.token /etc/wireguard/awa.iface
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now awa-peers.timer >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/awa-peers.timer /etc/systemd/system/awa-peers.service
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    command -v crontab >/dev/null 2>&1 && { crontab -l 2>/dev/null | grep -v awa-peers | crontab - 2>/dev/null || true; }
    rm -f /usr/local/bin/awa-peers
    exit 0
    ;;
  *) exit 0 ;;
esac

while read -r kind a b c _rest; do
      case "\$kind" in
        PEER)
          if [ -n "\$c" ] && [ "\$c" != "-" ]; then
            wg set "\$IFACE" peer "\$a" allowed-ips "\$b" endpoint "\$c" persistent-keepalive 25 2>/dev/null || true
          else
            wg set "\$IFACE" peer "\$a" allowed-ips "\$b" persistent-keepalive 25 2>/dev/null || true
          fi
          ;;
        FLAG)
          if [ "\$a" = "forward" ] && [ "\$b" = "1" ]; then
            sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || true
            sysctl -qw net.ipv6.conf.all.forwarding=1 2>/dev/null || true
          fi
          ;;
      esac
    done < /tmp/awa.state
rm -f /tmp/awa.state
PEERS
  chmod +x /usr/local/bin/awa-peers

  if command -v systemctl >/dev/null 2>&1; then
    cat >/etc/systemd/system/awa-peers.service <<'EOF'
[Unit]
Description=awamesh mesh peer refresh
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/awa-peers
EOF
    cat >/etc/systemd/system/awa-peers.timer <<'EOF'
[Unit]
Description=awamesh mesh peer refresh timer
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now awa-peers.timer >/dev/null 2>&1 || true
    /usr/local/bin/awa-peers || true
    echo "    已安装 awa-peers.timer（每 60 秒）"
  else
    (crontab -l 2>/dev/null | grep -v awa-peers; echo "*/1 * * * * /usr/local/bin/awa-peers >/dev/null 2>&1") | crontab -
    /usr/local/bin/awa-peers || true
    echo "    已写入 crontab（每分钟）"
  fi
else
  echo "    控制台未返回节点凭据，跳过（只走 hub）"
fi

sleep 1
echo
echo "完成：本机 mesh 地址 $ADDR"
wg show "$IFACE" | head -12
`;
}

function hostOfControl() {
  return cfg.controlUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") || `127.0.0.1:${cfg.port}`;
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    res.end(buf);
  });
}

const joinRate = new Map();
const loginLimit = makeLimiter({ windowMs: 60_000, max: 5 });   // 每 IP 每分钟 5 次失败
const apiLimit = makeLimiter({ windowMs: 60_000, max: 600 });   // 正常操作足够，挡爆破/扫描

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  securityHeaders(res, req);

  const ip = clientIp(req);

  // 可选 IP 白名单：AWA_ALLOW_CIDR=1.2.3.0/24,10.0.0.0/8
  if (!inAllowList(ip, cfg.allowCidr)) {
    log("[security] 拒绝来源 " + ip + "（不在 AWA_ALLOW_CIDR 内）");
    return json(res, 403, { error: "来源地址不在允许范围" });
  }

  // 登录暴力破解防护
  if (p === "/api/login" && req.method === "POST" && !loginLimit.hit(ip)) {
    const wait = loginLimit.retryAfter(ip);
    addEvent("auth", `登录被限速（${ip}，还需 ${wait}s）`);
    res.setHeader("Retry-After", String(wait));
    return json(res, 429, { error: `尝试过于频繁，请 ${wait} 秒后再试` });
  }

  // 已登录会话的写操作必须同源（挡 CSRF）
  if (p.startsWith("/api/") && req.method !== "GET" && p !== "/api/login" && p !== "/api/join" && p !== "/api/join/hit") {
    if (!sameOriginOk(req)) {
      addEvent("auth", `拒绝跨站写请求（${ip} → ${p}）`);
      return json(res, 403, { error: "跨站请求被拒绝" });
    }
  }

  if (p.startsWith("/api/") && !apiLimit.hit(ip)) {
    return json(res, 429, { error: "请求过于频繁" });
  }

  try {
    if (p === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const stored = setting("admin_credential");
      if (!verifyCredential(body?.secret || "", stored)) {
        addEvent("auth", `登录失败（${ip}）`);
        return json(res, 401, { error: "口令不正确" });
      }
      addEvent("auth", `登录成功（${ip}）`);
      res.setHeader("Set-Cookie", cookieHeader(sessionToken(), undefined, isHttps(req) || cfg.cookieSecure));
      return json(res, 200, { ok: true });
    }

    if (p === "/api/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", clearCookieHeader(isHttps(req) || cfg.cookieSecure));
      return json(res, 200, { ok: true });
    }

    if (p === "/api/bootstrap") {
      return json(res, 200, {
        authed: authed(req),
        version: cfg.version,
        backend: backend().name,
        needsLogin: true,
      });
    }

    if (p === "/api/join" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "-";
      const t = Date.now();
      const rec = joinRate.get(ip);
      if (!rec || t > rec.reset) joinRate.set(ip, { n: 1, reset: t + 60_000 });
      else if (++rec.n > 20) return json(res, 429, { error: "请求过于频繁，请一分钟后再试" });
      const body = await readBody(req);
      const r = await joinPeer({ ...(body || {}), _host: req.headers.host || "" });
      if (url.searchParams.get("format") === "shell") {
        const lines = [
          `ADDRESS=${r.address}`, `PREFIX=${r.prefix}`, `SERVERPUB=${r.serverPub}`,
          `ENDPOINT=${r.endpoint}`, `MTU=${r.mtu}`, `DNS=${r.dns}`, `ALLOWED=${r.allowedIps}`,
          `NODETOKEN=${r.nodeToken || ""}`,
        ];
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(lines.join("\n") + "\n");
      }
      return json(res, 200, r);
    }

    if (p === "/api/join/state" && req.method === "GET") {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const data = peersForNode(token);
      if (url.searchParams.get("format") !== "shell") return json(res, 200, data);

      const roles = data.self.roles || ["node"];
      const lines = [
        `SELF ${data.self.address} ${roles.join(",")}`,
        `FLAG forward ${roles.includes("gateway") ? "1" : "0"}`,
        `FLAG relay ${roles.includes("relay") ? "1" : "0"}`,
      ];
      for (const x of data.peers) {
        lines.push(`PEER ${x.publicKey} ${x.allowed} ${x.endpoint || "-"} ${x.name}`);
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(lines.join("\n") + "\n");
    }

    if (p === "/api/join/peers" && req.method === "GET") {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const data = peersForNode(token);
      if (url.searchParams.get("format") === "shell") {
        const lines = data.peers.map(x => `PEER ${x.publicKey} ${x.address}/32 ${x.endpoint || "-"} ${x.name}`);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(lines.join("\n") + "\n");
      }
      return json(res, 200, data);
    }

    if (p === "/api/join/hit" && req.method === "POST") {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const body = await readBody(req);
      return json(res, 200, updateNodeEndpoint(token, body?.endpoint, body?.port));
    }

    const dp = p.match(/^\/dp\/(dp_[a-z0-9]{8,})$/i);
    if (dp && req.method === "GET") {
      const tpl = fs.readFileSync(new URL("./assets/deploy.sh", import.meta.url), "utf8");
      const base = publicBase(req);
      const body = tpl.replace(/\r\n/g, "\n").split("@@SERVER@@").join(base).split("@@TOKEN@@").join(dp[1]);
      res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    }

    if (p === "/api/deploy/ts" && req.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const r = deployTailscale(token);
      const out = r.authkey
        ? `TS_AUTHKEY='${r.authkey}'\nTS_LOGIN='${r.loginServer}'\nTS_HOST='${r.hostname}'\n`
        : "";
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(out);
    }

    const dpWin = p.match(/^\/dp\/(dp_[a-z0-9]{8,})\/windows$/i);
    if (dpWin && req.method === "GET") {
      const tpl = fs.readFileSync(new URL("./assets/deploy.ps1", import.meta.url), "utf8");
      const base = publicBase(req);
      const body = tpl.replace(/\r\n/g, "\n").split("@@SERVER@@").join(base).split("@@TOKEN@@").join(dpWin[1]);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    }

    if (p === "/api/deploy/config" && req.method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (!/^dp_[a-z0-9]{8,}$/i.test(token)) return json(res, 400, { error: "凭据格式不正确" });
      const r = deployConfig(token, req);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(r.config);
    }

    if (p === "/join.sh") {
      const key = url.searchParams.get("key") || "";
      if (!/^awa_[a-f0-9]{8,}$/.test(key)) return json(res, 400, { error: "密钥格式不正确" });
      res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(joinScript(key, url.searchParams.get("hostname") || "", publicBase(req)));
    }

    if (p === "/api/relay/state" && req.method === "GET") {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      return json(res, 200, relayAlive(token));
    }

    if (p === "/api/health") return json(res, 200, { ok: true, version: cfg.version });

    if (p.startsWith("/api/")) {
      if (!authed(req)) return json(res, 401, { error: "未登录" });
      const body = req.method === "POST" ? await readBody(req) : null;
      const data = await api(req, res, url, body);
      return json(res, 200, data);
    }

    if (req.method === "GET") return serveStatic(res, p);
    json(res, 405, { error: "方法不允许" });
  } catch (err) {
    const code = err.status || 500;
    log("[error]", err.message);
    json(res, code, { error: err.message || "服务端错误" });
  }
});

if (cfg.backend === "mock") {
  // 只有显式要演示数据时才灌，避免"装完看到一堆假设备"
  if (process.env.AWA_DEMO === "1") seedIfEmpty();
} else {
  const cleared = clearDemo();
  if (cleared.devices || cleared.relays || cleared.tunnels) {
    log(`已清理演示数据：设备 ${cleared.devices} / 中继 ${cleared.relays} / 隧道 ${cleared.tunnels}`);
  }
}
ensureAdminCredential();
if (cfg.backend === "mock") { demoHeartbeat(); setInterval(demoHeartbeat, 30_000).unref(); }
pruneEvents();
setInterval(pruneEvents, 6 * 3600 * 1000).unref();

// wg 模式：托管本机 WireGuard 接口，并定时读取真实状态
async function wgBoot() {
  if (cfg.backend !== "wg") return;

  // 先确保服务端密钥存在，否则会以"还没有服务端密钥"失败
  if (!setting("wg_server_priv")) {
    const { genKeypair } = await import("./wg.js");
    const kp = genKeypair();
    setting("wg_server_priv", kp.privateKey);
    setting("wg_server_pub", kp.publicKey);
    log("[wg] 已生成服务端密钥");
  }
  _wgOn = await wg.available();
  if (!_wgOn) {
    log("[wg] 容器里没有 wg 命令，保持“手动复制配置”模式（compose 加 cap_add: NET_ADMIN 并装 wireguard-tools 可自动接管）");
    return;
  }
  try {
    const subnet = setting("wg_subnet") || cfg.meshCidr;
    const serverIp = hostInCidr(subnet, 1);
    // 端口避让：AWA_WG_PORT 是显式指定，尊重；否则从 wg_port/51820 起找空闲的
    let port = Number(process.env.AWA_WG_PORT || setting("wg_port") || 51820);
    if (!process.env.AWA_WG_PORT) {
      const free = await wg.pickPort(port);
      if (free !== port) {
        log(`[wg] UDP ${port} 已被占用，改用 ${free}（不会顶掉已有服务）`);
        port = free;
        setting("wg_port", port);
      } else {
        setting("wg_port", port);
      }
    }
    const bits = Number((setting("wg_subnet") || cfg.meshCidr).split("/")[1]) || 24;
    await wg.ensure(serverIp, Number(setting("wg_mtu") || cfg.mtu), port, bits);
    log(`[wg] 已接管接口 ${wg.iface}：${serverIp}/${bits} · udp ${port}`);
    _wgOn = true;
    setManaged(true);

    // 容器/netns 重建后接口是空的：从库里恢复历史对端，否则重启一次全网断
    const rows = db.prepare(`
      SELECT p.public_key, p.address, d.endpoint, d.routes
      FROM wg_peers p JOIN devices d ON d.id = p.device_id
      WHERE d.revoked_at IS NULL AND p.public_key IS NOT NULL AND p.public_key != ''`).all();
    let restored = 0;
    for (const r of rows) {
      try {
        await wg.addPeer(r.public_key, r.address, splitRoutes(r.routes));
        if (r.endpoint) await wg.setEndpoint(r.public_key, r.endpoint);
        restored++;
      } catch (e) {
        log(`[wg] 恢复对端失败（${r.address}）：${e.message}`);
      }
    }
    log(`[wg] 已恢复 ${restored}/${rows.length} 个历史对端`);
    setInterval(syncWgStatus, 20000).unref();
    await syncWgStatus();
  } catch (e) {
    _wgOn = false;
    setManaged(false);
    log("[wg] 接管失败，回退到手动模式：" + e.message);
    const cap = capNetAdmin();
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    log(`[wg] 运行身份：uid=${uid === null ? "?" : uid}${uid === 0 ? "（root）" : "（非 root，能力会被清空）"}`);
    log("[wg] 排查清单：");
    if (uid !== 0 && uid !== null) {
      log("[wg]   ✗ 进程不是 root：即使容器给了 privileged / NET_ADMIN，非 root 也建不了接口");
      log("[wg]     这不是 compose 的问题，是入口脚本降权了 —— 确认 AWA_WG_ENABLE 没有设成 0");
    } else if (cap === false) {
      log("[wg]   ✗ 容器实际没有 NET_ADMIN —— compose 的 cap_add 没生效");
      log("[wg]     改完 compose 必须重建容器：docker compose up -d --force-recreate（restart 不会应用新权限）");
      log("[wg]     仍然不行就临时加 privileged: true 验证，通了再回来收敛");
    } else if (cap === true) {
      log("[wg]   ✓ 容器已有 NET_ADMIN，那问题在内核：modprobe wireguard && lsmod | grep wireguard");
    } else {
      log("[wg]   1) compose 里要有 cap_add: [NET_ADMIN, SYS_MODULE]（建接口必需）");
      log("[wg]   2) 改完必须 up -d --force-recreate，restart 不会应用新权限");
    }
    log("[wg]   3) rootless Docker 里 NET_ADMIN 无效：docker info | grep -i rootless 应为 false");
    log("[wg]   4) 宿主机内核要有 wireguard 模块：modprobe wireguard && lsmod | grep wireguard");
  }
}

let _wgOn = false;

async function syncWgStatus() {
  if (!_wgOn) return;
  try {
    const peers = await wg.dump();
    const byKey = new Map(db.prepare("SELECT device_id, public_key FROM wg_peers").all().map(r => [r.public_key, r.device_id]));
    const cur = new Map(db.prepare("SELECT id, last_seen, path, endpoint, reported_endpoint FROM devices").all().map(r => [r.id, r]));
    const t = Math.floor(Date.now() / 1000);
    const upd = db.prepare("UPDATE devices SET last_seen = ?, path = ? WHERE id = ?");
    const updEp = db.prepare("UPDATE devices SET endpoint = ?, wg_port = ? WHERE id = ?");
    let changed = 0, learned = 0;
    for (const p of peers) {
      const id = byKey.get(p.publicKey);
      if (!id) continue;

      // 从内核看到的真实 source address 学习对端公网 endpoint。
      // 这比节点自己猜（公网IP + 本地监听端口）准得多：NAT 常常改写源端口。
      if (isPublicEndpoint(p.endpoint)) {
        const oldEp = cur.get(id)?.endpoint || "";
        if (oldEp !== p.endpoint) {
          const m = p.endpoint.match(/:([0-9]{1,5})$/);
          updEp.run(p.endpoint, m ? Number(m[1]) : null, id);
          if (cur.get(id)) cur.get(id).endpoint = p.endpoint;
          learned++;
        }
      }

      const seen = p.handshake || null;
      const alive = !!seen && t - seen < 180;
      const path = alive ? ((cur.get(id)?.reported_endpoint) ? "direct" : "relay") : "";
      const old = cur.get(id);
      if (old && old.last_seen === seen && old.path === path) continue; // 没变就不写库
      upd.run(seen, path, id);
      changed++;
    }
    if (changed || learned) log(`[wg] 状态更新 ${changed} 台${learned ? `，学到 ${learned} 个公网地址` : ""}`);
  } catch (e) {
    log("[wg] 状态同步失败：" + e.message);
  }
}

globalThis.__awaWgRetry = () => wgBoot();
globalThis.__awaProbeRelays = () => probeRelays();


/** 每日把整份配置写到 data/auto-backup/，方便 rsync 到备机（保留 7 份） */
function autoBackupOnce() {
  if (process.env.AWA_AUTO_BACKUP === "0") return;
  try {
    const dir = path.join(cfg.dataDir, "auto-backup");
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `awamesh-${day}.json`);
    fs.writeFileSync(file, JSON.stringify(exportBundle(), null, 2), { mode: 0o600 });
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    while (files.length > 7) {
      try { fs.unlinkSync(path.join(dir, files.shift())); } catch { break; }
    }
    log(`[backup] 已写入 ${file}`);
  } catch (e) {
    log("[backup] 自动备份失败：" + e.message);
  }
}

/** 内置中转：控制台本身就是星型转发点，不需要额外部署 */
function ensureBuiltinRelay() {
  if (cfg.backend !== "wg") return;
  const row = db.prepare("SELECT id FROM relays WHERE id = 'r_builtin'").get();
  const t = Math.floor(Date.now() / 1000);
  if (!row) {
    db.prepare(`INSERT INTO relays(id,name,region,region_code,addr,port,visibility,quota_gb,used_gb,state,enabled,last_health,demo,kind)
                VALUES('r_builtin','本机 · 控制台','本机','local',?,0,'private',0,0,'online',1,?,0,'builtin')`)
      .run(process.env.AWA_PUBLIC_HOST || "console", t);
    addEvent("relay", "内置中转已启用：控制台自身承担转发（无需部署 DERP）");
  } else {
    db.prepare("UPDATE relays SET state = 'online', last_health = ? WHERE id = 'r_builtin'").run(t);
  }
}


/** 读 /proc/self/status 判断容器实际拿到了 NET_ADMIN（bit 12） */
function capNetAdmin() {
  try {
    const line = fs.readFileSync("/proc/self/status", "utf8").split("\n").find(l => l.startsWith("CapEff:"));
    const hex = (line || "").split(/\s+/)[1] || "0";
    return ((BigInt("0x" + hex) >> 12n) & 1n) === 1n;
  } catch {
    return null;
  }
}


/** 是否是可用于 P2P 的公网 endpoint（排除内网/回环） */
function isPublicEndpoint(ep) {
  if (!ep) return false;
  const h = ep.replace(/^\[/, "").replace(/\]:\d+$/, "").replace(/:\d+$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    return !/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  }
  if (h.includes(":")) return !/^(::1|fe80|fc|fd)/i.test(h);
  return false;
}

/** 中继健康检查：TCP 连得上才算在线；状态变化写事件 */
async function probeRelays() {
  const rows = db.prepare("SELECT * FROM relays WHERE enabled = 1 AND (kind IS NULL OR kind != 'builtin')").all();
  for (const r of rows) {
    const res = await tcpProbe(r.addr, r.port || 18444, 3000).catch(() => ({ ok: false, error: "probe-error" }));
    const state = res.ok ? "online" : "offline";
    if (r.state !== state) {
      db.prepare("UPDATE relays SET state = ?, last_health = ? WHERE id = ?").run(state, Math.floor(Date.now() / 1000), r.id);
      addEvent("relay", `${r.name} ${res.ok ? "已上线（" + res.ms + " ms）" : "不可达（" + (res.error || "超时") + "）"}`);
    } else {
      db.prepare("UPDATE relays SET last_health = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), r.id);
    }
  }
}

server.listen(cfg.port, cfg.host, () => {
  log(`awamesh v${cfg.version} 已启动：http://${cfg.host}:${cfg.port}`);
  log(`后端：${cfg.backend} ｜ 网段：${cfg.meshCidr} ｜ 数据目录：${cfg.dataDir}`);
  if (cfg.mode === "tiny") log("tiny 模式：事件保留 " + cfg.eventKeepDays + " 天，健康检查间隔放宽");
  wgBoot();
  ensureBuiltinRelay();
  setTimeout(autoBackupOnce, 30_000).unref();
  setInterval(autoBackupOnce, 24 * 3600_000).unref();
  probeRelays().catch(() => {});
  setInterval(() => probeRelays().catch(() => {}), 60_000).unref();
});
