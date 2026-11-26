import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "./config.js";

const file = path.join(cfg.dataDir, "awamesh.db");
export const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mesh_ip TEXT,
  hostname TEXT,
  os TEXT,
  client_ver TEXT,
  tags TEXT DEFAULT '',
  roles TEXT DEFAULT 'node',
  path TEXT DEFAULT '',
  latency_ms INTEGER,
  relay TEXT,
  last_seen INTEGER,
  key_fp TEXT,
  created_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS relays (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT,
  region_code TEXT,
  addr TEXT,
  port INTEGER,
  visibility TEXT DEFAULT 'public',
  quota_gb INTEGER DEFAULT 0,
  used_gb INTEGER DEFAULT 0,
  state TEXT DEFAULT 'online',
  enabled INTEGER DEFAULT 1,
  last_health INTEGER
);

CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  name TEXT,
  hostname TEXT,
  backend TEXT,
  health TEXT DEFAULT 'unknown',
  latency_ms INTEGER,
  last_check INTEGER,
  migratable INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  device_id TEXT,
  message TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS authkeys (
  id TEXT PRIMARY KEY,
  tag TEXT,
  hash TEXT,
  expires_at INTEGER,
  used_at INTEGER,
  created_at INTEGER
);
`);

// 迁移：区分内置中转（控制台自身）与外部 DERP 中继
try { db.exec("ALTER TABLE relays ADD COLUMN kind TEXT DEFAULT 'derp'"); } catch {}
// 中继机上跑的自检凭据：控制台删除/停用这台中继时，它会自动卸载自己
try { db.exec("ALTER TABLE relays ADD COLUMN token_hash TEXT"); } catch {}

// 迁移：P2P 相关字段（节点上报的公网 endpoint 与刷新凭据）
try { db.exec("ALTER TABLE devices ADD COLUMN endpoint TEXT"); } catch {}
try { db.exec("ALTER TABLE devices ADD COLUMN wg_port INTEGER"); } catch {}
try { db.exec("ALTER TABLE devices ADD COLUMN node_token TEXT"); } catch {}
// 网关角色：这台机器发布进 mesh 的内网段（逗号分隔的 CIDR）
try { db.exec("ALTER TABLE devices ADD COLUMN routes TEXT"); } catch {}
// 节点凭据的密文副本：一键部署时不轮换，避免把已接入的节点踢成 401
try { db.exec("ALTER TABLE devices ADD COLUMN node_token_sealed TEXT"); } catch {}
// Tailscale 兜底：节点加入 tailnet 后上报的 100.x 地址
try { db.exec("ALTER TABLE devices ADD COLUMN ts_ip TEXT"); } catch {}
try { db.exec("ALTER TABLE devices ADD COLUMN ts_at INTEGER"); } catch {}
// 节点自己上报的公网地址（决定 P2P 可行性），与内核学到的实际映射分开存
try { db.exec("ALTER TABLE devices ADD COLUMN reported_endpoint TEXT"); } catch {}

// 迁移：给演示数据打标记，切到真实后端时自动清掉
for (const t of ["devices", "relays", "tunnels"]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN demo INTEGER DEFAULT 0`); } catch { /* 已存在 */ }
}

export const now = () => Math.floor(Date.now() / 1000);

/** 清空演示数据：既按 demo 标记，也按种子 ID（兼容升级前建的库，那时没有 demo 列） */
const SEED_IDS = {
  devices: ["d_router", "d_seoul", "d_win", "d_db", "d_hk", "d_nas"],
  relays: ["r_hk", "r_seoul", "r_home"],
  tunnels: ["t_blog", "t_rule", "t_nas", "t_api"],
};

export function clearDemo() {
  const out = {};
  for (const [table, ids] of Object.entries(SEED_IDS)) {
    const marks = ids.map(() => "?").join(",");
    const r = db.prepare(`DELETE FROM ${table} WHERE demo = 1 OR id IN (${marks})`).run(...ids);
    out[table] = r.changes;
  }
  if (out.devices) {
    const marks = SEED_IDS.devices.map(() => "?").join(",");
    db.prepare(`DELETE FROM events WHERE device_id IN (${marks})`).run(...SEED_IDS.devices);
  }
  return out;
}

export function setting(key, value) {
  if (value === undefined) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  }
  db.prepare("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
  return value;
}

export function addEvent(type, message, deviceId = null) {
  db.prepare("INSERT INTO events(type, device_id, message, created_at) VALUES(?,?,?,?)")
    .run(type, deviceId, message, now());
}

export function pruneEvents() {
  if (!cfg.eventKeepDays) return;
  const cut = now() - cfg.eventKeepDays * 86400;
  db.prepare("DELETE FROM events WHERE created_at < ?").run(cut);
}

/** 演示模式心跳：让 mock 数据看起来是活的（真实后端不用） */
export function demoHeartbeat() {
  const t = now();
  const rows = db.prepare("SELECT id, path FROM devices WHERE revoked_at IS NULL").all();
  const upd = db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?");
  for (const r of rows) {
    if (!r.path) continue; // 保持一台离线，方便看"离线"状态
    upd.run(t - Math.floor(Math.random() * 20) - 1, r.id);
  }
}

export function listDevices() {
  return db.prepare("SELECT * FROM devices ORDER BY (revoked_at IS NOT NULL), name").all()
    .map(d => ({ ...d, tags: d.tags ? d.tags.split(",").filter(Boolean) : [], roles: (d.roles || "node").split(",") }));
}

export function listRelays() {
  return db.prepare("SELECT * FROM relays ORDER BY enabled DESC, region").all();
}

export function listTunnels() {
  return db.prepare("SELECT * FROM tunnels ORDER BY hostname").all();
}

export function listEvents(limit = 50) {
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
}

/** 首次启动灌一份演示数据，方便没有 headscale 时也能看到界面 */
export function seedIfEmpty() {
  const { c } = db.prepare("SELECT COUNT(*) c FROM devices").get();
  if (c > 0) return;

  const t = now();
  const dev = (id, name, ip, os, roles, path, ms, relay, seen, tags) =>
    db.prepare(`INSERT INTO devices(id,name,mesh_ip,hostname,os,client_ver,tags,roles,path,latency_ms,relay,last_seen,key_fp,created_at,demo)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(id, name, ip, name, os, "1.90.1", tags, roles, path, ms, relay, seen, "ek:" + crypto.randomBytes(4).toString("hex"), t - 86400);

  dev("d_router", "router-home", "10.88.0.1", "openwrt", "node,gateway", "direct", 12, null, t - 3, "home,gateway");
  dev("d_seoul", "seoul-vps", "10.88.0.2", "linux", "node,relay", "direct", 38, null, t - 1, "relay,edge");
  dev("d_win", "win-laptop", "10.88.0.3", "windows", "node", "direct", 12, null, t - 8, "home");
  dev("d_db", "db-01", "10.88.0.11", "linux", "node", "relay", 41, "seoul", t - 5, "prod,db");
  dev("d_hk", "hk-edge", "10.88.0.12", "linux", "node,relay", "direct", 22, null, t - 2, "relay,edge");
  dev("d_nas", "old-nas", "10.88.0.20", "linux", "node", "", null, null, t - 3 * 86400, "home");

  db.prepare("UPDATE devices SET revoked_at = NULL").run();

  const rel = (id, name, region, code, addr, port, vis, quota, used, enabled) =>
    db.prepare(`INSERT INTO relays(id,name,region,region_code,addr,port,visibility,quota_gb,used_gb,state,enabled,last_health,demo)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(id, name, region, code, addr, port, vis, quota, used, "online", enabled, t - 10);

  rel("r_hk", "香港 · hk-edge", "香港", "hk", "hk.edge.example.com", 18444, "public", 500, 62, 1);
  rel("r_seoul", "首尔 · seoul-vps", "首尔", "seoul", "seoul.example.com", 18444, "public", 1024, 128, 1);
  rel("r_home", "家宽 · router-home", "家宽", "home", "home.example.com", 18444, "private", 0, 18, 1);

  const tun = (id, name, host, back, health, ms, mig) =>
    db.prepare(`INSERT INTO tunnels(id,name,hostname,backend,health,latency_ms,last_check,migratable,demo) VALUES(?,?,?,?,?,?,?,?,1)`)
      .run(id, name, host, back, health, ms, t - 30, mig);

  tun("t_blog", "blog", "blog.akkdiy.cn", "10.88.0.1:8080", "ok", 8, 0);
  tun("t_rule", "rule", "rule.akkdiy.cn", "10.88.0.1:8000", "ok", 7, 0);
  tun("t_nas", "nas", "nas.akkdiy.cn", "10.88.0.20:5000", "down", null, 0);
  tun("t_api", "api", "api.akkdiy.cn", "localhost:3000", "ok", 6, 1);

  addEvent("relay", "地图已推送到 18 台设备");
  addEvent("device", "db-01 切换到中继 seoul（41 ms）", "d_db");
  addEvent("tunnel", "nas.akkdiy.cn 后端不可达（设备 3 天未上线）", null);
  addEvent("device", "win-laptop 上线", "d_win");
}
