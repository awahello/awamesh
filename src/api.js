import { cfg } from "./config.js";
import { db, now, setting, listRelays, listTunnels, listEvents, addEvent } from "./db.js";
import { backend } from "./backends/index.js";
import { cfEnabled, listAccounts, listTunnels as cfListTunnels, toRows } from "./cloudflare.js";

const r = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

function overview(devices) {
  const online = devices.filter(d => d.online && !d.revoked_at);
  const relayPaths = online.filter(d => d.path === "relay");
  const directRatio = online.length ? Math.round(((online.length - relayPaths.length) / online.length) * 100) : 0;
  const relays = listRelays();
  const tunnels = listTunnels();
  const usedGb = relays.reduce((s, x) => s + (x.used_gb || 0), 0);
  const healthyTunnels = tunnels.filter(t => t.health === "ok").length;
  const avgMs = online.filter(d => d.latency_ms).reduce((s, d) => s + d.latency_ms, 0) /
    (online.filter(d => d.latency_ms).length || 1);

  return {
    devices: { total: devices.length, online: online.length, relay: relayPaths.length },
    directRatio,
    usedGb,
    tunnels: { total: tunnels.length, ok: healthyTunnels },
    avgMs: Math.round(avgMs),
    meshCidr: cfg.meshCidr,
    relays: relays.length,
    backend: backend().name,
  };
}

function groupByTag(devices) {
  const map = new Map();
  for (const d of devices) {
    const tags = d.tags.length ? d.tags : ["未分组"];
    for (const t of tags) {
      if (!map.has(t)) map.set(t, { tag: t, total: 0, online: 0 });
      const g = map.get(t);
      g.total++;
      if (d.online && !d.revoked_at) g.online++;
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}


/** 生成中继机的部署脚本（derper + systemd），只做打印，不远程执行 */
function relayScript(relay, cfg) {
  const port = relay.port || cfg.relayPort;
  return `#!/bin/sh
# awamesh 中继节点部署脚本（${relay.region}）
# 在 ${relay.addr} 这台机器上以 root 执行；需要 Go 1.22+ 或已安装 derper
set -e

PORT=${port}
HOSTNAME_ARG="${relay.addr}"

if ! command -v derper >/dev/null 2>&1; then
  echo "==> 安装 derper（需要 Go）"
  command -v go >/dev/null 2>&1 || { echo "请先安装 Go 1.22+：https://go.dev/dl/"; exit 1; }
  go install tailscale.com/cmd/derper@latest
  cp "$(go env GOPATH)/bin/derper" /usr/local/bin/derper
fi

echo "==> 写 systemd 单元"
cat >/etc/systemd/system/derper.service <<EOF
[Unit]
Description=awamesh DERP relay
After=network-online.target

[Service]
ExecStart=/usr/local/bin/derper -a :$PORT -stun -hostname=$HOSTNAME_ARG
Restart=always
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now derper
sleep 2
systemctl --no-pager status derper | head -8

echo
echo "==> 自检"
curl -fsS "http://127.0.0.1:$PORT/" >/dev/null && echo "  本地 443 端口可达"
echo "  下一步：在 awamesh 的「中继节点」页确认状态为在线，地图会自动推送"
`;
}

export async function api(req, res, url, body) {
  const be = backend();
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  if (url.pathname === "/api/health") return { ok: true, version: cfg.version };

  if (url.pathname === "/api/overview") {
    const devices = await be.devices();
    return { ...overview(devices), groups: groupByTag(devices), events: listEvents(8) };
  }

  if (url.pathname === "/api/devices" && method === "GET") {
    const devices = await be.devices();
    const filter = url.searchParams.get("filter") || "all";
    let list = devices;
    if (filter === "online") list = devices.filter(d => d.online && !d.revoked_at);
    if (filter === "relay") list = devices.filter(d => d.path === "relay");
    if (filter === "offline") list = devices.filter(d => !d.online && !d.revoked_at);
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q) list = list.filter(d => (d.name + d.hostname + d.mesh_ip).toLowerCase().includes(q));
    return {
      total: devices.length,
      online: devices.filter(d => d.online && !d.revoked_at).length,
      relay: devices.filter(d => d.path === "relay").length,
      devices: list,
      groups: groupByTag(devices),
    };
  }


  if (url.pathname === "/api/devices" && method === "POST") {
    if (typeof be.create !== "function") throw new Error("当前后端不支持直接创建设备（mock 请改用演示数据，或切 AWA_BACKEND=wg）");
    const r = await be.create(body?.name);
    return r;
  }

  if (url.pathname === "/api/wg/profile" && method === "GET") {
    if (typeof be.profile !== "function") throw new Error("当前后端不是 wg");
    const { serverPriv, ...rest } = be.profile();
    return rest;
  }

  if (url.pathname === "/api/wg/profile" && method === "POST") {
    if (typeof be.profile !== "function") throw new Error("当前后端不是 wg");
    if (body?.endpoint !== undefined) setting("wg_endpoint", String(body.endpoint).trim());
    if (body?.subnet) setting("wg_subnet", String(body.subnet).trim());
    if (body?.mtu) setting("wg_mtu", String(body.mtu));
    if (body?.dns !== undefined) setting("wg_dns", String(body.dns).trim());
    if (body?.lanRoutes !== undefined) setting("wg_lan_routes", String(body.lanRoutes).trim());
    if (body?.regen) {
      const { genKeypair } = await import("./wg.js");
      const kp = genKeypair();
      setting("wg_server_priv", kp.privateKey);
      setting("wg_server_pub", kp.publicKey);
      addEvent("settings", "已重新生成服务端密钥（需同步更新 WireGuard 服务端配置）");
    } else {
      addEvent("settings", "WireGuard 服务端参数已更新");
    }
    const { serverPriv, ...rest } = be.profile();
    return rest;
  }

  if (url.pathname === "/api/wg/sync" && method === "POST") {
    if (typeof be.sync !== "function") throw new Error("当前后端不是 wg");
    if (!body?.text) throw new Error("请粘贴 wg show 的输出");
    return be.sync(body.text);
  }

  if (seg[0] === "devices" && seg[2] === "rename" && method === "POST") {
    await be.rename(seg[1], body?.name);
    return { ok: true };
  }

  if (seg[0] === "devices" && seg[2] === "revoke" && method === "POST") {
    await be.revoke(seg[1]);
    return { ok: true };
  }

  if (url.pathname === "/api/relays" && method === "GET") {
    return { relays: listRelays(), relayPort: cfg.relayPort };
  }

  if (seg[0] === "relays" && seg[2] === "toggle" && method === "POST") {
    const row = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("中继不存在");
    const enabled = body?.enabled ? 1 : 0;
    db.prepare("UPDATE relays SET enabled = ? WHERE id = ?").run(enabled, seg[1]);
    addEvent("relay", `${row.name} ${enabled ? "已启用" : "已从地图摘除"}`);
    return { ok: true };
  }

  if (seg[0] === "relays" && seg[2] === "visibility" && method === "POST") {
    const row = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("中继不存在");
    const vis = body?.visibility === "private" ? "private" : "public";
    db.prepare("UPDATE relays SET visibility = ? WHERE id = ?").run(vis, seg[1]);
    addEvent("relay", `${row.name} 可见性改为${vis === "private" ? "仅内网" : "公网"}`);
    return { ok: true };
  }

  if (url.pathname === "/api/tunnels" && method === "GET") {
    return { tunnels: listTunnels(), cfEnabled: !!cfg.cfToken };
  }


  if (url.pathname === "/api/tunnels/sync" && method === "POST") {
    if (!cfEnabled()) throw Object.assign(new Error("未配置 AWA_CF_TOKEN，无法从 Cloudflare 同步"), { status: 400 });
    const accounts = await listAccounts();
    const accountId = body?.account || url.searchParams.get("account") || accounts[0]?.id;
    if (!accountId) throw new Error("没有可用的 Cloudflare 账户（Token 需要 Account:Read）");
    const items = await cfListTunnels(accountId);
    const n = toRows(items, db);
    addEvent("tunnel", `从 Cloudflare 同步 ${n} 条 ingress 记录`);
    return { ok: true, accountId, count: n };
  }

  if (url.pathname === "/api/relays/map" && method === "GET") {
    const list = listRelays().filter(r => r.enabled);
    const lines = ["regions:"];
    list.forEach((r, i) => {
      const id = 900 + i;
      lines.push(`  ${id}:`);
      lines.push(`    regionid: ${id}`);
      lines.push(`    regioncode: ${r.region_code || "r" + id}`);
      lines.push(`    regionname: ${r.region}`);
      lines.push(`    nodes:`);
      lines.push(`      - name: ${id}a`);
      lines.push(`        regionid: ${id}`);
      lines.push(`        hostname: ${r.addr}`);
      lines.push(`        derpport: ${r.port}`);
      lines.push(`        stunonly: false`);
    });
    return { yaml: lines.join("\n") + "\n", count: list.length };
  }

  if (seg[0] === "relays" && seg[2] === "command" && method === "GET") {
    const r = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!r) throw new Error("中继不存在");
    return { script: relayScript(r, cfg), relay: r };
  }

  if (url.pathname === "/api/events" && method === "GET") {
    return { events: listEvents(Number(url.searchParams.get("limit") || 50)) };
  }

  if (url.pathname === "/api/keys" && method === "POST") {
    const tag = String(body?.tag || "test").slice(0, 24);
    const ttl = Math.min(Math.max(Number(body?.ttl || 1), 1), 24);
    const created = await be.createKey(tag, ttl);
    return created;
  }

  if (url.pathname === "/api/settings" && method === "GET") {
    return {
      version: cfg.version,
      mode: cfg.mode,
      backend: be.name,
      meshCidr: cfg.meshCidr,
      meshDomain: cfg.meshDomain,
      mtu: cfg.mtu,
      eventKeepDays: cfg.eventKeepDays,
      controlUrl: cfg.controlUrl,
      relayPort: cfg.relayPort,
      dataDir: cfg.dataDir,
    };
  }

  if (url.pathname === "/api/settings" && method === "POST") {
    if (body?.mtu) setting("mtu", String(Math.min(Math.max(Number(body.mtu), 1200), 1500)));
    if (body?.meshDomain) setting("mesh_domain", String(body.meshDomain).slice(0, 32));
    addEvent("settings", "设置已更新");
    return { ok: true };
  }

  const err = new Error("接口不存在: " + url.pathname);
  err.status = 404;
  throw err;
}
