import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg, log } from "./config.js";
import { api, joinPeer, peersForNode, updateNodeEndpoint } from "./api.js";
import { seedIfEmpty, pruneEvents, addEvent, demoHeartbeat, clearDemo } from "./db.js";
import {
  ensureAdminCredential, verifyCredential, sessionToken, validSession,
  cookieHeader, clearCookieHeader,
} from "./auth.js";
import { backend } from "./backends/index.js";
import { db, setting } from "./db.js";
import { wg, setManaged } from "./wgsrv.js";
import { hostInCidr } from "./wg.js";

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

function joinScript(key) {
  const server = cfg.controlUrl || `http://${hostOfControl()}`;
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

echo "==> 2.5/4 探测公网地址（有公网 IP 才能和别的节点直连）"
PUBIP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)"
WGPORT="$(wg show "$IFACE" listen-port 2>/dev/null || echo 51820)"
ENDPOINT=""
[ -n "$PUBIP" ] && ENDPOINT="$PUBIP:$WGPORT"
if [ -n "$ENDPOINT" ]; then echo "    公网地址 $ENDPOINT（可直连）"; else echo "    未探测到公网地址，走控制台兜底"; fi

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
curl -fsS -H "Authorization: Bearer \$TOKEN" "\$SERVER/api/join/peers?format=shell" \
  | while read -r kind pub addr ep name; do
      [ "\$kind" = "PEER" ] || continue
      if [ "\$ep" != "-" ]; then
        wg set "\$IFACE" peer "\$pub" allowed-ips "\$addr" endpoint "\$ep" persistent-keepalive 25
      else
        wg set "\$IFACE" peer "\$pub" allowed-ips "\$addr" persistent-keepalive 25
      fi
    done
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    if (p === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const stored = setting("admin_credential");
      if (!verifyCredential(body?.secret || "", stored)) {
        addEvent("auth", `登录失败（${req.socket.remoteAddress || "-"}）`);
        return json(res, 401, { error: "口令不正确" });
      }
      addEvent("auth", "登录成功");
      res.setHeader("Set-Cookie", cookieHeader(sessionToken()));
      return json(res, 200, { ok: true });
    }

    if (p === "/api/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", clearCookieHeader());
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

    if (p === "/join.sh") {
      const key = url.searchParams.get("key") || "";
      if (!/^awa_[a-f0-9]{8,}$/.test(key)) return json(res, 400, { error: "密钥格式不正确" });
      res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(joinScript(key, url.searchParams.get("hostname") || ""));
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
    const port = Number(process.env.AWA_WG_PORT || 51820);
    await wg.ensure(serverIp, Number(setting("wg_mtu") || cfg.mtu), port);
    log(`[wg] 已接管接口 ${wg.iface}：${serverIp}/${subnet.split("/")[1] || 24} · udp ${port}`);
    _wgOn = true;
    setManaged(true);

    // 容器/netns 重建后接口是空的：从库里恢复历史对端，否则重启一次全网断
    const rows = db.prepare(`
      SELECT p.public_key, p.address, d.endpoint
      FROM wg_peers p JOIN devices d ON d.id = p.device_id
      WHERE d.revoked_at IS NULL AND p.public_key IS NOT NULL AND p.public_key != ''`).all();
    let restored = 0;
    for (const r of rows) {
      try {
        await wg.addPeer(r.public_key, r.address);
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
    log("[wg] 排查清单：");
    log("[wg]   1) compose 里要有  cap_add: [NET_ADMIN]（建接口必需）与 SYS_MODULE（加载模块）");
    log("[wg]   2) 宿主机内核要有 wireguard 模块：modprobe wireguard && lsmod | grep wireguard");
    log("[wg]   3) rootless Docker 里 NET_ADMIN 无效：docker info | grep -i rootless 应为 false");
    log("[wg]   4) 实在不行把 privileged: true 打开（能跑通再回来收敛权限）");
  }
}

let _wgOn = false;

async function syncWgStatus() {
  if (!_wgOn) return;
  try {
    const peers = await wg.dump();
    const byKey = new Map(db.prepare("SELECT device_id, public_key FROM wg_peers").all().map(r => [r.public_key, r.device_id]));
    const cur = new Map(db.prepare("SELECT id, last_seen, path FROM devices").all().map(r => [r.id, r]));
    const t = Math.floor(Date.now() / 1000);
    const upd = db.prepare("UPDATE devices SET last_seen = ?, path = ? WHERE id = ?");
    let changed = 0;
    for (const p of peers) {
      const id = byKey.get(p.publicKey);
      if (!id) continue;
      const seen = p.handshake || null;
      const path = seen && t - seen < 180 ? "direct" : "";
      const old = cur.get(id);
      if (old && old.last_seen === seen && old.path === path) continue; // 没变就不写库
      upd.run(seen, path, id);
      changed++;
    }
    if (changed) log(`[wg] 状态更新 ${changed} 台`);
  } catch (e) {
    log("[wg] 状态同步失败：" + e.message);
  }
}

globalThis.__awaWgRetry = () => wgBoot();

server.listen(cfg.port, cfg.host, () => {
  log(`awamesh v${cfg.version} 已启动：http://${cfg.host}:${cfg.port}`);
  log(`后端：${cfg.backend} ｜ 网段：${cfg.meshCidr} ｜ 数据目录：${cfg.dataDir}`);
  if (cfg.mode === "tiny") log("tiny 模式：事件保留 " + cfg.eventKeepDays + " 天，健康检查间隔放宽");
  wgBoot();
});
