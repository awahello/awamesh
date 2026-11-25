import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg, log } from "./config.js";
import { api } from "./api.js";
import { seedIfEmpty, pruneEvents, addEvent, demoHeartbeat } from "./db.js";
import {
  ensureAdminCredential, verifyCredential, sessionToken, validSession,
  cookieHeader, clearCookieHeader,
} from "./auth.js";
import { backend } from "./backends/index.js";
import { setting } from "./db.js";

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

function joinScript(key, hostname) {
  const server = cfg.controlUrl || `http://${hostOfControl()}`;
  return `#!/bin/sh
# awamesh 接入脚本（由控制台生成，密钥一次性有效）
# 用法：curl -fsSL '${server}/join.sh?key=KEY' | sh -s -- [--hostname NAME]
set -e

SERVER="\${AWA_SERVER:-${server}}"
KEY="\${AWA_KEY:-${key}}"
HOSTNAME_ARG="${hostname || ""}"
MESH_DOMAIN="\${AWA_MESH_DOMAIN:-${cfg.meshDomain}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_ARG="$2"; shift 2 ;;
    --tag) shift 2 ;;
    *) shift ;;
  esac
done

echo "==> 1/3 安装 tailscale"
if command -v tailscale >/dev/null 2>&1; then
  echo "    已安装，跳过"
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache tailscale >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  (curl -fsSL https://tailscale.com/install.sh | sh) >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y tailscale >/dev/null
elif command -v yum >/dev/null 2>&1; then
  yum install -y tailscale >/dev/null
else
  echo "    无法识别包管理器，请手动安装 tailscale 后重跑" >&2
  exit 1
fi

echo "==> 2/3 接入 awamesh 控制面：$SERVER"
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
else
  (tailscaled --state=/var/lib/tailscale/tailscaled.state >/dev/null 2>&1 &) || true
fi

tailscale up \\
  --login-server="$SERVER" \\
  --authkey="$KEY" \\
  --accept-routes \\
  --accept-dns=false \\
  --hostname="\${HOSTNAME_ARG:-$(hostname)}" \\
  --timeout=60s

echo "==> 3/3 完成"
tailscale status | head -20
echo
echo "Mesh 地址：$(tailscale ip -4 2>/dev/null | head -1)"
echo "提示：本机可用 <name>.$MESH_DOMAIN 访问其他设备（需控制面已开启 MagicDNS）"
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

if (cfg.backend === "mock") seedIfEmpty();
ensureAdminCredential();
if (cfg.backend === "mock") { demoHeartbeat(); setInterval(demoHeartbeat, 30_000).unref(); }
pruneEvents();
setInterval(pruneEvents, 6 * 3600 * 1000).unref();

server.listen(cfg.port, cfg.host, () => {
  log(`awamesh v${cfg.version} 已启动：http://${cfg.host}:${cfg.port}`);
  log(`后端：${cfg.backend} ｜ 网段：${cfg.meshCidr} ｜ 数据目录：${cfg.dataDir}`);
  if (cfg.mode === "tiny") log("tiny 模式：事件保留 " + cfg.eventKeepDays + " 天，健康检查间隔放宽");
});
