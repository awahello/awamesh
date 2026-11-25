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
      t.connectors > 0 ? "unknown" : "down",
      null,
      now,
      /^localhost|^127\./.test(t.backend) ? 1 : 0
    );
  }
  return items.length;
}
