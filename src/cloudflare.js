import { cfg } from "./config.js";
import { secretSetting, saveSecretSetting } from "./secrets.js";
import { setting } from "./db.js";

const API = "https://api.cloudflare.com/client/v4";

/** Token 可以写在环境变量，也可以在面板里填（加密存库） */
export function cfToken() {
  return secretSetting("cf_token", cfg.cfToken);
}

export function setCfToken(token) {
  saveSecretSetting("cf_token", token || "");
}

export function cfAccount() {
  return setting("cf_account") || "";
}

export function setCfAccount(id) {
  setting("cf_account", id || "");
}

export function cfEnabled() {
  return !!cfToken();
}

async function cf(path, init = {}) {
  const token = cfToken();
  if (!token) throw Object.assign(new Error("还没填 Cloudflare API Token（设置 → Cloudflare）"), { status: 400 });
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const msg = body?.errors?.[0]?.message || `Cloudflare 返回 ${res.status}`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  return body.result;
}

/** 取账户列表（Token 需要 Account:Read） */
export async function listAccounts() {
  return cf("/accounts?per_page=50");
}

/** 找一个同名隧道，没有就建一个（需要 Account → Cloudflare Tunnel → Write） */
export async function ensureTunnel(accountId, name = "awamesh") {
  const list = (await cf(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=50`)) || [];
  const hit = list.find(t => t.name === name);
  if (hit) return hit;
  return cf(`/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({ name, config_src: "cloudflare" }),
  });
}

/** 把某个域名指向 mesh 地址，写进隧道 ingress（保留其它规则，末尾补 404） */
export async function publishIngress(accountId, tunnelId, hostname, backend) {
  let ingress = [];
  try {
    const cur = await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
    ingress = (cur?.config?.ingress || []).filter(r => r.hostname && r.hostname !== hostname);
  } catch { ingress = []; }
  const rules = [...ingress, { hostname, service: backend }, { service: "http_status:404" }];
  await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    body: JSON.stringify({ config: { ingress: rules } }),
  });
  return rules;
}

/** 列账户下的 zone（需要 Zone → Zone → Read） */
export async function listZones() {
  const zones = await cf("/zones?per_page=50").catch(() => []);
  return (zones || []).map(z => ({ id: z.id, name: z.name, status: z.status }));
}

/** 从最长的后缀开始找这个域名属于哪个 zone */
export async function zoneFor(hostname) {
  const parts = String(hostname).split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join(".");
    const zones = await cf(`/zones?name=${cand}`).catch(() => []);
    if (zones && zones[0]) return zones[0];
  }
  return null;
}

/** 把域名 CNAME 到 <tunnelId>.cfargotunnel.com 并开启代理（需要 Zone → DNS → Write） */
export async function pointDns(zone, hostname, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`;
  const body = JSON.stringify({ type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1 });
  const existing = await cf(`/zones/${zone.id}/dns_records?name=${hostname}`).catch(() => []);
  if (existing && existing[0]) {
    return cf(`/zones/${zone.id}/dns_records/${existing[0].id}`, { method: "PATCH", body });
  }
  return cf(`/zones/${zone.id}/dns_records`, { method: "POST", body });
}

/** 取连接器 token，给 cloudflared 用 */
export async function tunnelToken(accountId, tunnelId) {
  const r = await cf(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`).catch(() => null);
  return typeof r === "string" ? r : r?.token || "";
}

/** 只验证「这个 Token 能不能读这个账户的隧道」，轻量调用 */
export async function pingAccount(accountId) {
  const list = await cf(`/accounts/${accountId}/cfd_tunnel?per_page=1`);
  return { ok: true, tunnels: Array.isArray(list) ? list.length : 0 };
}

/** 取某个账户下的隧道，并展开 ingress 规则 */
export async function listTunnels(accountId) {
  const tunnels = await cf(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=50`);
  const out = [];
  for (const t of tunnels) {
    let ingress = [];
    try {
      const conf = await cf(`/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`);
      ingress = conf?.config?.ingress || [];
    } catch {
      /* 没有配置的隧道会报错，忽略 */
    }
    const connected = (t.connections || []).length;
    for (const rule of ingress) {
      if (!rule.hostname) continue;
      out.push({
        cfId: t.id,
        name: t.name,
        hostname: rule.hostname,
        backend: String(rule.service || "").replace(/^https?:\/\//, ""),
        connectors: connected,
        status: t.status || (connected ? "healthy" : "down"),
      });
    }
  }
  return out;
}

/**
 * 同步到本地表：只做展示（v0.1 不改 ingress）。
 * health 先按连接器数量粗判；真实后端探活需要走 mesh，放到 v0.2。
 */
export function toRows(items, db) {
  const upsert = db.prepare(`
    INSERT INTO tunnels(id, name, hostname, backend, health, latency_ms, last_check, migratable)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, hostname=excluded.hostname, backend=excluded.backend,
      health=excluded.health, last_check=excluded.last_check`);
  const now = Math.floor(Date.now() / 1000);
  for (const t of items) {
    upsert.run(
      "cf_" + t.cfId + "_" + t.hostname,
      t.name,
      t.hostname,
      t.backend,
      t.connectors > 0 ? "ok" : "down",
      null,
      now,
      /^localhost|^127\./.test(t.backend) ? 1 : 0
    );
  }
  return items.length;
}
