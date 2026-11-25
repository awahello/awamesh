import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg, log } from "./config.js";
import { api, joinPeer } from "./api.js";
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

echo "==> 3/4 向控制台申请地址"
RESP="$(curl -fsS -X POST "$SERVER/api/join?format=shell" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$KEY\",\"pubkey\":\"$PUB\",\"hostname\":\"$HOST\"}")" || {
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
      const body = await readBody(req);
      const r = await joinPeer({ ...(body || {}), _host: req.headers.host || "" });
      if (url.searchParams.get("format") === "shell") {
        const lines = [
          `ADDRESS=${r.address}`, `PREFIX=${r.prefix}`, `SERVERPUB=${r.serverPub}`,
          `ENDPOINT=${r.endpoint}`, `MTU=${r.mtu}`, `DNS=${r.dns}`, `ALLOWED=${r.allowedIps}`,
        ];
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(lines.join("\n") + "\n");
      }
      return json(res, 200, r);
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
    setInterval(syncWgStatus, 20000).unref();
    await syncWgStatus();
  } catch (e) {
    _wgOn = false;
    setManaged(false);
    log("[wg] 接管失败，回退到手动模式：" + e.message);
  }
}

let _wgOn = false;

async function syncWgStatus() {
  if (!_wgOn) return;
  try {
    const peers = await wg.dump();
    const byKey = new Map(db.prepare("SELECT device_id, public_key FROM wg_peers").all().map(r => [r.public_key, r.device_id]));
    const t = Math.floor(Date.now() / 1000);
    for (const p of peers) {
      const id = byKey.get(p.publicKey);
      if (!id) continue;
      const seen = p.handshake || null;
      db.prepare("UPDATE devices SET last_seen = ?, path = ?, latency_ms = NULL WHERE id = ?")
        .run(seen, seen && t - seen < 180 ? "direct" : "", id);
    }
  } catch (e) {
    log("[wg] 状态同步失败：" + e.message);
  }
}

server.listen(cfg.port, cfg.host, () => {
  log(`awamesh v${cfg.version} 已启动：http://${cfg.host}:${cfg.port}`);
  log(`后端：${cfg.backend} ｜ 网段：${cfg.meshCidr} ｜ 数据目录：${cfg.dataDir}`);
  if (cfg.mode === "tiny") log("tiny 模式：事件保留 " + cfg.eventKeepDays + " 天，健康检查间隔放宽");
  wgBoot();
});
