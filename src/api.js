import { cfg } from "./config.js";
import { db, now, setting, listRelays, listTunnels, listEvents, addEvent } from "./db.js";
import { backend } from "./backends/index.js";

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
