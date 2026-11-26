import { cfg } from "./config.js";
import { db, now, setting, listRelays, listTunnels, listEvents, addEvent } from "./db.js";
import { backend } from "./backends/index.js";
import { cfEnabled, cfToken, setCfToken, cfAccount, setCfAccount, listAccounts, pingAccount, listTunnels as cfListTunnels, toRows } from "./cloudflare.js";
import crypto from "node:crypto";
import { wg, isManaged } from "./wgsrv.js";
import { hostInCidr, clientConfig as clientConfigText } from "./wg.js";
import { secretSetting, saveSecretSetting } from "./secrets.js";

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


export function allocAddress(subnet) {
  const used = new Set(db.prepare("SELECT address FROM wg_peers").all().map(r => r.address));
  for (const d of db.prepare("SELECT mesh_ip FROM devices WHERE mesh_ip IS NOT NULL AND revoked_at IS NULL").all()) {
    if (d.mesh_ip) used.add(d.mesh_ip);
  }
  for (let n = 2; n < 250; n++) {
    const ip = hostInCidr(subnet, n);
    if (!used.has(ip)) return ip;
  }
  throw new Error("网段里没有可用地址了");
}

/**
 * 节点自主加入：节点本地生成密钥，只把公钥交给控制台。
 * 控制台负责分配地址、把它加进服务端接口，并返回完整配置。
 */
export async function joinPeer(body) {
  const token = String(body?.token || "").trim();
  const publicKey = String(body?.pubkey || "").trim();
  const hostname = String(body?.hostname || "node").trim().slice(0, 40) || "node";

  if (!/^awa_[a-f0-9]{16,}$/i.test(token)) throw Object.assign(new Error("密钥格式不对"), { status: 400 });
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(publicKey)) throw Object.assign(new Error("公钥格式不对"), { status: 400 });

  const hash = crypto.createHash("SHA256").update(token).digest("hex");
  const row = db.prepare("SELECT * FROM authkeys WHERE hash = ?").get(hash);
  if (!row) throw Object.assign(new Error("密钥不存在（请重新生成）"), { status: 401 });
  if (row.used_at) throw Object.assign(new Error("该密钥已被使用"), { status: 401 });
  if (row.expires_at && row.expires_at < now()) throw Object.assign(new Error("密钥已过期"), { status: 401 });

  const pf = backend().profile?.() || {};
  const subnet = pf.subnet || cfg.meshCidr;
  const address = allocAddress(subnet);
  const id = "d_" + crypto.randomBytes(5).toString("hex");
  const t = now();

  db.prepare(`INSERT INTO devices(id,name,mesh_ip,hostname,os,client_ver,tags,roles,path,latency_ms,relay,last_seen,key_fp,created_at,demo)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(id, hostname, address, hostname, "", "", row.tag || "", "node", "", null, null, null, publicKey, t);
  db.prepare("INSERT INTO wg_peers(device_id,private_key,public_key,address,created_at) VALUES(?,?,?,?,?)")
    .run(id, "", publicKey, address, t);
  db.prepare("UPDATE authkeys SET used_at = ? WHERE id = ?").run(t, row.id);

  // 节点上报的公网 endpoint（有则记下，用于全网状直连）
  const selfEndpoint = String(body?.endpoint || "").trim().slice(0, 120);
  const wgPort = Number(body?.port || 0) || null;
  const nodeToken = "nt_" + crypto.randomBytes(16).toString("hex");
  if (selfEndpoint) {
    db.prepare("UPDATE devices SET endpoint = ?, reported_endpoint = ?, wg_port = ? WHERE id = ?")
      .run(selfEndpoint, selfEndpoint, wgPort, id);
  }
  db.prepare("UPDATE devices SET node_token = ? WHERE id = ?")
    .run(crypto.createHash("SHA256").update(nodeToken).digest("hex"), id);

  // Endpoint 没填时，用请求 Host 兜底推导（面板域名/IP + wg 端口）
  let endpoint = pf.endpoint || "";
  if (!endpoint && body?._host) {
    const hostOnly = String(body._host).split(":")[0];
    endpoint = `${hostOnly}:${process.env.AWA_WG_PORT || 51820}`;
  }
  if (!endpoint) throw Object.assign(new Error("控制台还没填 Endpoint（设置 → WireGuard 服务端），请先填公网地址:端口"), { status: 400 });

  let applied = false;
  if (isManaged()) {
    try {
      const devRow = db.prepare("SELECT routes FROM devices WHERE id = ?").get(id);
      await wg.addPeer(publicKey, address, splitRoutes(devRow?.routes));
      if (selfEndpoint) await wg.sh("wg", ["set", wg.iface, "peer", publicKey, "endpoint", selfEndpoint]);
      applied = true;
    } catch (e) {
      addEvent("device", `加 peer 失败（${e.message}），已下发配置，需在服务端手动补一条`, id);
    }
  }
  addEvent("device", `${hostname} 通过配置加入（${address}）${applied ? "" : " · 服务端接口未接管，需手动加 peer"}`, id);

  return {
    id, name: hostname, address,
    prefix: subnet.split("/")[1] || "24",
    serverPub: pf.serverPub || setting("wg_server_pub"),
    endpoint,
    mtu: pf.mtu || 1420,
    dns: pf.dns || "",
    allowedIps: [subnet, ...(pf.lanRoutes ? pf.lanRoutes.split(",").map(x => x.trim()).filter(Boolean) : [])].join(","),
    applied,
    nodeToken,
  };
}


/** 节点用 nodeToken 拉取全网 peer 列表，用于打全直连 */
export function peersForNode(nodeToken) {
  const hash = crypto.createHash("SHA256").update(String(nodeToken || "")).digest("hex");
  const self = db.prepare("SELECT * FROM devices d WHERE d.node_token = ?").get(hash);
  if (!self) throw Object.assign(new Error("节点凭据无效"), { status: 401 });
  if (self.revoked_at) throw Object.assign(new Error("该设备已吊销，请清理本机配置"), { status: 401 });

  const rows = db.prepare(`
    SELECT d.id, d.name, d.mesh_ip, d.endpoint, d.wg_port, d.routes, d.roles, p.public_key
    FROM devices d JOIN wg_peers p ON p.device_id = d.id
    WHERE d.revoked_at IS NULL`).all();

  const peers = rows
    .filter(r => r.id !== self.id)
    .map(r => ({
      name: r.name,
      address: r.mesh_ip,
      publicKey: r.public_key,
      allowed: allowedFor(r),
      routes: splitRoutes(r.routes),
      // 有公网 endpoint 的才给直连信息，其余由 hub 兜底
      endpoint: r.endpoint ? (r.endpoint.includes(":") ? r.endpoint : `${r.endpoint}:${r.wg_port || 51820}`) : "",
    }));

  return {
    self: {
      name: self.name,
      address: self.mesh_ip,
      endpoint: self.endpoint || "",
      roles: String(self.roles || "node").split(",").filter(Boolean),
      routes: splitRoutes(self.routes),
    },
    peers,
  };
}

/** 节点每次刷新时顺带上报自己的 endpoint（公网 IP 可能变） */
export async function updateNodeEndpoint(nodeToken, endpoint, port, tsIp) {
  const hash = crypto.createHash("SHA256").update(String(nodeToken || "")).digest("hex");
  const self = db.prepare("SELECT * FROM devices WHERE node_token = ?").get(hash);
  if (!self) throw Object.assign(new Error("节点凭据无效"), { status: 401 });

  // Tailscale 地址单独记录，用于在面板上显示兜底状态
  if (tsIp !== undefined) {
    const v = String(tsIp || "").trim().slice(0, 60);
    db.prepare("UPDATE devices SET ts_ip = ?, ts_at = ? WHERE id = ?").run(v || null, v ? now() : null, self.id);
  }

  const ep = String(endpoint || "").trim().slice(0, 120);
  if (!ep) return { ok: true, changed: false };
  db.prepare("UPDATE devices SET endpoint = ?, reported_endpoint = ?, wg_port = ? WHERE id = ?")
    .run(ep, ep, Number(port) || null, self.id);
  if (isManaged()) {
    const peer = db.prepare("SELECT public_key FROM wg_peers WHERE device_id = ?").get(self.id);
    if (peer?.public_key) await wg.setEndpoint(peer.public_key, ep.includes(":") ? ep : `${ep}:${Number(port) || 51820}`);
  }
  return { ok: true, changed: self.endpoint !== ep };
}



/** 把 "192.168.1.0/24, 10.0.0.0/8" 解析成数组 */
export function splitRoutes(routes) {
  return String(routes || "").split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
}

/** 某台设备对其它节点呈现的 allowed-ips（mesh 地址 + 它发布的内网段） */
function allowedFor(device) {
  const list = [`${device.mesh_ip}/32`];
  for (const c of splitRoutes(device.routes)) if (c.includes("/")) list.push(c);
  return list.join(",");
}


/** Tailscale 兜底配置（可选）：UDP 被封时让节点改走 443 的 DERP */
function tsProfile() {
  return {
    authkey: secretSetting("ts_authkey", process.env.AWA_TS_AUTHKEY || ""),
    loginServer: setting("ts_login_server") || process.env.AWA_TS_LOGIN_SERVER || "",
    enabled: !!secretSetting("ts_authkey", process.env.AWA_TS_AUTHKEY || ""),
  };
}

/** 节点用部署凭据换取兜底配置（authkey 直接给节点，属于一次性引导凭据） */
export function deployTailscale(token) {
  const hash = crypto.createHash("SHA256").update(String(token || "")).digest("hex");
  const dev = db.prepare("SELECT * FROM devices WHERE node_token = ?").get(hash);
  if (!dev) throw Object.assign(new Error("凭据无效"), { status: 401 });
  const p = tsProfile();
  return { authkey: p.authkey, loginServer: p.loginServer, hostname: dev.name };
}


/** WireGuard 连通性自检：判断部署端有没有公网、当前配置能不能直接跑起来 */
export async function wgCheck() {
  const bk = backend();
  const pf = (typeof bk.profile === "function") ? (bk.profile() || {}) : {};
  const endpoint = String(pf.endpoint || "").trim();
  const mode = pf.mode || "builtin";

  let publicIp = "";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch("https://api.ipify.org", { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) publicIp = (await r.text()).trim();
  } catch { /* 没有外网就留空 */ }

  const epHost = endpoint.replace(/^\[/, "").replace(/\]:\d+$/, "").replace(/:\d+$/, "");
  const epPort = (endpoint.match(/:([0-9]{1,5})$/) || [])[1] || "";
  const hostIsPublic = !!publicIp && (epHost === publicIp || endpoint.startsWith(`[${publicIp}]`));
  const hostIsPrivate = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(epHost);

  const issues = [];
  const hints = [];

  if (!endpoint) {
    issues.push("还没填 Endpoint");
    hints.push("部署端有公网：填 <公网IP>:" + (process.env.AWA_WG_PORT || setting("wg_port") || 51820) + "，或直接点「自动」让控制台推导");
    hints.push("部署端没公网：① 在我们这台有公网的中继机上装服务端，Endpoint 填它的地址；② 或开「兜底通道 · Tailscale」");
  } else if (hostIsPublic) {
    hints.push("Endpoint 就是本机公网地址，部署端可以自己当服务端 ✓");
  } else if (hostIsPrivate) {
    issues.push("Endpoint 是内网地址，外部节点连不上");
    hints.push("有公网但做了端口映射：填「公网IP:映射后的端口」（不是内网地址）");
    hints.push("家里 NAS 想直接暴露：确认路由器把 UDP " + (epPort || "51820") + " 转发到这台机器");
  } else {
    hints.push("Endpoint 指向另一台机器（中继机 / OpenWrt / 手动映射地址）");
    hints.push("那台机器上必须存在对应的 WireGuard 服务端，并把每台节点的 [Peer] 加进去");
  }

  // 容器里真实监听的 UDP 端口；和 Endpoint 里的端口对不上就说明 compose 的 ports 没跟着改
  let listenPort = 0;
  if (isManaged()) {
    try { listenPort = await wg.listenPort(); } catch { listenPort = 0; }
    if (listenPort && epPort && Number(epPort) !== listenPort) {
      issues.push(`Endpoint 端口 ${epPort} 与容器实际监听 ${listenPort} 不一致`);
      hints.push(`compose 的 ports 要改成 "${listenPort}:${listenPort}/udp"，或把 Endpoint 端口改成 ${listenPort}`);
    }
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!isManaged() && uid !== null && uid !== 0) {
    issues.push(`进程运行在非 root（uid=${uid}），无法获得 NET_ADMIN`);
    hints.push("容器入口默认以 root 跑；如果 compose 里写了 AWA_WG_ENABLE=0 就会降权到 node，删掉它");
  }

  if (!isManaged()) {
    issues.push("部署端没有托管 awa0 接口（缺 NET_ADMIN 或内核无 wireguard 模块），当前只能生成配置，不能自动中转");
    hints.push("compose 补 cap_add: [NET_ADMIN, SYS_MODULE] → docker compose up -d --force-recreate（restart 不生效）");
    hints.push("还不行就临时加 privileged: true 验证：sed -i 's/^    cap_add:/    privileged: true\\n    cap_add:/' docker-compose.yml");
  }

  return {
    mode,
    managed: isManaged(),
    uid,
    listenPort,
    iface: wg.iface,
    publicIp,
    endpoint,
    endpointPort: epPort,
    endpointIsSelf: hostIsPublic,
    issues,
    hints,
    ok: issues.length === 0,
  };
}


/**
 * 生成部署命令用的「对外地址」。
 * 反代/CF 后面时绝不能拼容器端口——CF 只代理 80/443/8443 等少数端口，拼 18443 必然超时。
 * 优先级：设置里的 public_url > AWA_CONTROL_URL > 请求的 X-Forwarded-* / Host
 */
export function publicBase(req) {
  const fixed = (setting("public_url") || cfg.controlUrl || "").trim();
  if (fixed) return fixed.replace(/\/+$/, "");

  const h = req?.headers || {};
  const xfProto = String(h["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const proto = xfProto || (req?.socket?.encrypted ? "https" : "http");
  const host = String(h["x-forwarded-host"] || h.host || "").trim();
  if (!host) return `http://127.0.0.1:${cfg.port}`;

  const hasPort = /:\d+$/.test(host);
  const viaProxy = !!xfProto || !!h["x-forwarded-for"] || !!h["x-forwarded-host"] || !!h["cf-connecting-ip"] || !!h["cf-ray"];

  // 反代/CF：外部已经是 443，不能再加端口
  if (viaProxy && !hasPort) return `${proto}://${host}`;
  if (hasPort) return `${proto}://${host}`;
  if (proto === "https") return `https://${host}`;
  return `http://${host}:${cfg.port}`;
}


let _updCache = { at: 0, latest: "" };

/** 检查上游版本（10 分钟缓存，失败不报错） */
export async function updateCheck() {
  const nowMs = Date.now();
  if (!_updCache.latest || nowMs - _updCache.at > 600_000) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch("https://raw.githubusercontent.com/awahello/awamesh/main/package.json", { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        if (j && j.version) _updCache = { at: nowMs, latest: String(j.version) };
      }
    } catch { /* 离线就不提示 */ }
  }
  const latest = _updCache.latest;
  const cmp = (a, b) => {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };
  return {
    current: cfg.version,
    latest: latest || "",
    outdated: !!latest && cmp(latest, cfg.version) > 0,
    command: "curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/upgrade.sh | sh",
    docs: "https://github.com/awahello/awamesh#更新升级到新版本",
  };
}


/** 导出配置：设备、对端、中继、隧道、接入密钥、设置（不含后端口令） */
export function exportBundle() {
  const pick = (t) => db.prepare(`SELECT * FROM ${t}`).all();
  const skip = new Set(["admin_credential", "session_epoch"]);
  const settings = {};
  for (const r of db.prepare("SELECT key, value FROM settings").all()) {
    if (!skip.has(r.key)) settings[r.key] = r.value;
  }
  return {
    app: "awamesh",
    version: cfg.version,
    exportedAt: Math.floor(Date.now() / 1000),
    note: "enc_* 与 wg-server 相关字段用 AWA_SECRET 加密，导入端必须使用同一个 AWA_SECRET 才能解开",
    settings,
    devices: pick("devices"),
    wgPeers: pick("wg_peers"),
    relays: pick("relays"),
    tunnels: pick("tunnels"),
    authkeys: pick("authkeys"),
  };
}

/** 导入配置：replace=覆盖同类数据（默认），merge=只补不覆盖 */
export function importBundle(bundle, mode = "replace") {
  if (!bundle || bundle.app !== "awamesh") throw new Error("不是 awamesh 导出的文件");
  const replace = mode !== "merge";
  const tables = { devices: bundle.devices, wg_peers: bundle.wgPeers, relays: bundle.relays, tunnels: bundle.tunnels, authkeys: bundle.authkeys };
  const counts = {};

  const insertRow = (table, row) => {
    const cols = Object.keys(row).filter(k => row[k] !== undefined);
    if (!cols.length) return;
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    try { db.prepare(sql).run(...cols.map(k => row[k])); counts[table] = (counts[table] || 0) + 1; } catch { /* 列不匹配就跳过这一行 */ }
  };

  db.exec("BEGIN");
  try {
    for (const [table, rows] of Object.entries(tables)) {
      if (!Array.isArray(rows)) continue;
      if (replace) db.prepare(`DELETE FROM ${table}`).run();
      for (const row of rows) insertRow(table, row);
    }
    if (bundle.settings && typeof bundle.settings === "object") {
      const skip = new Set(["admin_credential", "session_epoch"]); // 永不覆盖后端口令与会话纪元
      for (const [k, v] of Object.entries(bundle.settings)) {
        if (skip.has(k)) continue;
        setting(k, v);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }

  addEvent("settings", `导入配置：${Object.entries(counts).map(([k, v]) => k + " " + v).join(" / ") || "仅设置"}（${replace ? "覆盖" : "合并"}）`);
  return { ok: true, mode: replace ? "replace" : "merge", counts };
}

/** 有效 Endpoint：设置里的 > AWA_PUBLIC_HOST > 请求 Host 推导 */
export function effectiveEndpoint(host) {
  const bk = backend();
  const pf = (typeof bk.profile === "function") ? (bk.profile() || {}) : {};
  if (pf.endpoint) return String(pf.endpoint).trim();
  const raw = process.env.AWA_PUBLIC_HOST || String(host || "").split(":")[0] || "";
  const h = raw.trim();
  if (!h || h === "localhost") return "";
  return `${h}:${process.env.AWA_WG_PORT || setting("wg_port") || 51820}`;
}

/** 一键部署：签发长期部署凭据（可吊销），返回一条可直接执行的命令 */
export async function deployInfo(deviceId, req) {
  const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!dev) throw Object.assign(new Error("设备不存在"), { status: 404 });
  if (dev.revoked_at) throw new Error("该设备已吊销，请先删除后重新添加");
  const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(deviceId);
  if (!peer) throw new Error("该设备没有密钥记录");

  const endpoint = effectiveEndpoint(req?.headers?.host || "");
  if (!endpoint) {
    throw new Error("还没填 Endpoint：设置 → WireGuard 服务端，填这台机器的公网地址:51820（或给容器加 AWA_PUBLIC_HOST）");
  }

  const token = "dp_" + crypto.randomBytes(20).toString("hex");
  db.prepare("UPDATE devices SET node_token = ?, endpoint = endpoint WHERE id = ?")
    .run(crypto.createHash("SHA256").update(token).digest("hex"), deviceId);

  const base = publicBase(req);
  const command = `curl -fsSL --connect-timeout 10 '${base}/dp/${token}' | sh -s -- --iface awa0`;

  // 已经被控时顺手把对端补进本机接口（重建过容器也不会漏）
  let applied = false;
  if (isManaged()) {
    try { await wg.addPeer(peer.public_key, peer.address); applied = true; } catch { /* ignore */ }
  }

  addEvent("device", `为 ${dev.name} 生成一键部署命令${applied ? "（已自动加入服务端）" : ""}`, deviceId);
  return { command, endpoint, token, applied, name: dev.name, address: peer.address };
}

/** 部署脚本取配置：凭 token 换完整 wg 配置 */
export function deployConfig(token, req) {
  const hash = crypto.createHash("SHA256").update(String(token || "")).digest("hex");
  const dev = db.prepare("SELECT * FROM devices WHERE node_token = ?").get(hash);
  if (!dev) throw Object.assign(new Error("部署凭据无效"), { status: 401 });
  if (dev.revoked_at) throw Object.assign(new Error("该设备已吊销"), { status: 401 });
  const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(dev.id);
  if (!peer?.private_key) throw Object.assign(new Error("该设备没有私钥（自助加入的节点请用 /join.sh）"), { status: 400 });

  const bk = backend();
  const pf = (typeof bk.profile === "function") ? (bk.profile() || {}) : {};
  const endpoint = effectiveEndpoint(req?.headers?.host || "");
  if (!endpoint) throw Object.assign(new Error("控制台未设置 Endpoint"), { status: 400 });
  const subnet = pf.subnet || cfg.meshCidr;

  return {
    iface: "awa0",
    hostname: dev.name,
    endpoint,
    config: clientConfigText({
      privateKey: peer.private_key,
      address: `${peer.address}/${subnet.split("/")[1] || 24}`,
      serverPubKey: pf.serverPub,
      endpoint,
      subnet,
      mtu: pf.mtu || cfg.mtu,
      dns: pf.dns || "",
      extraRoutes: pf.lanRoutes ? pf.lanRoutes.split(",").map(x => x.trim()).filter(Boolean) : [],
    }),
  };
}


/** 中继机自检：凭据有效且仍启用才返回，否则让那台机器卸载自己 */
export function relayAlive(token) {
  const hash = crypto.createHash("SHA256").update(String(token || "")).digest("hex");
  const row = db.prepare("SELECT * FROM relays WHERE token_hash = ?").get(hash);
  if (!row) throw Object.assign(new Error("中继凭据无效（已删除）"), { status: 401 });
  // 记录被删 → 401，机器自行卸载；只是停用 → 200 + enabled:false，机器停容器、保留配置
  return { ok: true, enabled: !!row.enabled, id: row.id, name: row.name, port: row.port };
}

/** 生成中继机的部署脚本：优先 Docker，其次 Go 安装；交互式 shell 里失败不会退出会话 */
function relayScript(relay, cfg, token, base) {
  const port = relay.port || cfg.relayPort;
  return `#!/bin/sh
# awamesh 中继节点部署（${relay.region}）
# 建议在「有公网 IP 的 Linux VPS」上执行；路由器（OpenWrt）内存与工具链都不适合跑 derper
set -u

PORT=${port}
HOSTNAME_ARG="${relay.addr}"

die() {
  echo "✗ $*" >&2
  if [ -t 0 ]; then
    echo "" >&2
    echo "（当前是交互式 shell：脚本已中止，会话保持，不会断开）" >&2
    kill -INT $$ 2>/dev/null || true
    return 1 2>/dev/null || true
  fi
  exit 1
}

echo "==> 目标：$HOSTNAME_ARG:$PORT"

# 无公网地址的机器当不了中继
case "$HOSTNAME_ARG" in
  10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*)
    die "这个地址是内网地址，中继必须用公网 IP 或解析到公网的域名" ;;
esac

if ! command -v docker >/dev/null 2>&1 && ! command -v go >/dev/null 2>&1; then
  die "这台机器既没有 docker 也没有 go。请换一台 Linux VPS，或先装 docker"
fi

if command -v docker >/dev/null 2>&1; then
  echo "==> 用 Docker 运行 derper（无需安装 Go）"
  docker rm -f awamesh-derp >/dev/null 2>&1 || true
  docker run -d --name awamesh-derp --restart unless-stopped \
    -p "$PORT:$PORT" -p "$PORT:$PORT/udp" \
    --entrypoint derper \
    ghcr.io/awahello/awamesh-relay:latest \
    -a ":$PORT" -stun -hostname "$HOSTNAME_ARG" || die "docker 启动失败，检查端口占用与镜像拉取"
else
  echo "==> 没有 docker，改用 Go 安装 derper"
  command -v go >/dev/null 2>&1 || die "没有 go，请先装 Go 1.22+ 或 docker"
  go install tailscale.com/cmd/derper@latest || die "go install 失败（网络或 Go 版本问题）"
  cp "$(go env GOPATH)/bin/derper" /usr/local/bin/derper || die "拷贝 derper 失败（需要 root）"

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
  systemctl daemon-reload && systemctl enable --now derper || die "systemd 启动失败"
fi

sleep 2
echo
echo "==> 自检"
if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "    ✓ 本地 $PORT 可达"
else
  echo "    ! 本地 $PORT 未响应：可能还在起，或端口被占用"
fi
echo "    下一步：回面板中继页点「刷新」，状态应为在线；再点「中继地图」导出配置"
echo "    别忘了云厂商安全组放行 TCP/UDP $PORT"

# ---- 注册到控制台：控制台删除这台中继时，本机自动卸载 ----
printf '%s' "${token || ""}" > /etc/awa-relay.token
printf '%s' "${base || ""}" > /etc/awa-relay.server
chmod 600 /etc/awa-relay.token /etc/awa-relay.server

cat > /usr/local/bin/awa-relay-check <<'CHK'
#!/bin/sh
TOKEN="$(cat /etc/awa-relay.token 2>/dev/null)" || exit 0
SERVER="$(cat /etc/awa-relay.server 2>/dev/null)" || exit 0
[ -n "$TOKEN" ] && [ -n "$SERVER" ] || exit 0

CODE="$(curl -sS -o /tmp/awa-relay.state -w '%{http_code}' --max-time 8 \
  -H "Authorization: Bearer $TOKEN" "$SERVER/api/relay/state" 2>/dev/null || echo 000)"

case "$CODE" in
  200)
    : > /tmp/awa-relay.401 2>/dev/null || true
    BODY="$(cat /tmp/awa-relay.state 2>/dev/null || true)"
    case "$BODY" in
      *'"enabled":false'*)
        command -v docker >/dev/null 2>&1 && docker stop awamesh-derp >/dev/null 2>&1
        command -v systemctl >/dev/null 2>&1 && systemctl stop derper >/dev/null 2>&1
        ;;
      *'"enabled":true'*)
        command -v docker >/dev/null 2>&1 && docker start awamesh-derp >/dev/null 2>&1
        command -v systemctl >/dev/null 2>&1 && systemctl start derper >/dev/null 2>&1
        ;;
    esac
    exit 0
    ;;
  401)
    n="$(cat /tmp/awa-relay.401 2>/dev/null || echo 0)"
    n=$((n + 1))
    echo "$n" > /tmp/awa-relay.401
    if [ "$n" -lt 3 ]; then
      echo "awamesh: 中继自检收到 401（第 $n/3 次），下一轮再确认" >&2
      exit 0
    fi
    echo "awamesh: 连续 3 次 401，确认已在控制台删除，开始卸载" >&2
    if command -v docker >/dev/null 2>&1; then
      docker rm -f awamesh-derp >/dev/null 2>&1 || true
      docker image rm -f ghcr.io/awahello/awamesh-relay:latest >/dev/null 2>&1 || true
    fi
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now awa-relay.timer >/dev/null 2>&1 || true
      systemctl disable --now derper >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/awa-relay.timer /etc/systemd/system/awa-relay.service \
            /etc/systemd/system/derper.service
      rm -f /usr/local/bin/derper
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    command -v crontab >/dev/null 2>&1 && { crontab -l 2>/dev/null | grep -v awa-relay-check | crontab - 2>/dev/null || true; }
    rm -f /etc/awa-relay.token /etc/awa-relay.server /usr/local/bin/awa-relay-check /tmp/awa-relay.401
    echo "awamesh: 中继已卸载（容器 / systemd / 凭据全部清除）" >&2
    ;;
esac
CHK
chmod +x /usr/local/bin/awa-relay-check

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat >/etc/systemd/system/awa-relay.service <<'EOF'
[Unit]
Description=awamesh relay keepalive check
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/awa-relay-check
EOF
  cat >/etc/systemd/system/awa-relay.timer <<'EOF'
[Unit]
Description=awamesh relay keepalive timer
[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now awa-relay.timer >/dev/null 2>&1 || true
  echo "    已安装 awa-relay.timer：控制台删除这台中继后，60 秒内自动卸载"
elif command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v awa-relay-check; echo "*/1 * * * * /usr/local/bin/awa-relay-check >/dev/null 2>&1") | crontab - 2>/dev/null || true
  echo "    已写入 crontab：控制台删除这台中继后，60 秒内自动卸载"
fi
`;
}

export async function api(req, res, url, body) {
  const be = backend();
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  if (url.pathname === "/api/health") return { ok: true, version: cfg.version };

  if (url.pathname === "/api/overview") {
    const devices = await be.devices();
    return {
      ...overview(devices),
      groups: groupByTag(devices),
      events: listEvents(8),
      relaysList: listRelays(),
      tunnelsList: listTunnels(),
    };
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


  // 改后台口令：改完所有已登录会话立即失效
  if (url.pathname === "/api/security/credential" && method === "POST") {
    const { verifyCredential, hashCredential, rotateSessions } = await import("./auth.js");
    const oldPw = String(body?.old || "");
    const next = String(body?.next || "");
    if (!verifyCredential(oldPw, setting("admin_credential"))) throw Object.assign(new Error("当前口令不正确"), { status: 401 });
    if (next.length < 10) throw new Error("新口令至少 10 位");
    if (next === oldPw) throw new Error("新口令不能和旧的一样");
    setting("admin_credential", hashCredential(next));
    rotateSessions();
    addEvent("auth", "后台口令已修改，所有会话失效");
    return { ok: true };
  }

  if (url.pathname === "/api/backup/export" && method === "GET") {
    return exportBundle();
  }

  if (url.pathname === "/api/backup/import" && method === "POST") {
    return importBundle(body?.bundle || body, body?.mode === "merge" ? "merge" : "replace");
  }

  if (url.pathname === "/api/update/check" && method === "GET") {
    return updateCheck();
  }

  if (url.pathname === "/api/settings/public-url" && method === "POST") {
    const v = String(body?.url || "").trim().replace(/\/+$/, "");
    if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw new Error("要写成 https://域名（不要带路径）");
    setting("public_url", v);
    addEvent("settings", v ? `对外地址设为 ${v}` : "对外地址已清空（改为自动推导）");
    return { ok: true, publicUrl: v };
  }

  if (url.pathname === "/api/wg/profile" && method === "GET") {
    if (typeof be.profile !== "function") throw new Error("当前后端不是 wg");
    const { serverPriv, ...rest } = be.profile();
    return { ...rest, managed: isManaged() };
  }

  if (url.pathname === "/api/wg/profile" && method === "POST") {
    if (typeof be.profile !== "function") throw new Error("当前后端不是 wg");
    const mode = body?.mode === "custom" ? "custom" : body?.mode === "builtin" ? "builtin" : (setting("wg_mode") || "builtin");
    setting("wg_mode", mode);

    if (body?.endpoint !== undefined) {
      const ep = String(body.endpoint).trim();
      setting(mode === "custom" ? "wg_external_endpoint" : "wg_endpoint", ep);
    }
    if (body?.subnet) setting("wg_subnet", String(body.subnet).trim());
    if (body?.mtu) setting("wg_mtu", String(body.mtu));
    if (body?.dns !== undefined) setting("wg_dns", String(body.dns).trim());
    if (body?.lanRoutes !== undefined) setting("wg_lan_routes", String(body.lanRoutes).trim());
    if (mode === "custom" && body?.serverPub !== undefined) {
      const pub = String(body.serverPub).trim();
      if (!/^[A-Za-z0-9+/]{43}=?$/.test(pub)) throw new Error("服务端公钥格式不对（应为 44 字符 base64）");
      setting("wg_external_pub", pub.endsWith("=") ? pub : pub + "=");
    }
    // 默认模式：Endpoint 没填就用当前访问地址推导，做到「开箱即用」
    if (mode === "builtin" && !setting("wg_endpoint")) {
      const hostOnly = String(req.headers?.host || "").split(":")[0];
      if (hostOnly && hostOnly !== "localhost") {
        setting("wg_endpoint", `${hostOnly}:${process.env.AWA_WG_PORT || setting("wg_port") || 51820}`);
      }
    }
    // 自定义模式必须两样都齐，否则生成的客户端配置连不上
    if (mode === "custom") {
      const ep = setting("wg_external_endpoint") || "";
      const pub = setting("wg_external_pub") || "";
      if (!ep || !pub) throw new Error("自定义服务端需要同时填「Endpoint」和「服务端公钥」（OpenWrt 上 wg show 的 public key）");
    }
    if (body?.regen) {
      const { genKeypair } = await import("./wg.js");
      const kp = genKeypair();
      setting("wg_server_priv", kp.privateKey);
      setting("wg_server_pub", kp.publicKey);
      addEvent("settings", "已重新生成服务端密钥（需同步更新 WireGuard 服务端配置）");
    } else {
      addEvent("settings", "WireGuard 服务端参数已更新");
    }
    if (typeof globalThis.__awaWgRetry === "function") {
      try { await globalThis.__awaWgRetry(); } catch (e) { addEvent("settings", "重试接管 WireGuard 失败：" + e.message); }
    }
    const { serverPriv, ...rest } = be.profile();
    return { ...rest, managed: isManaged() };
  }

  if (url.pathname === "/api/wg/check" && method === "GET") {
    return wgCheck();
  }

  if (url.pathname === "/api/wg/sync" && method === "POST") {
    if (typeof be.sync !== "function") throw new Error("当前后端不是 wg");
    if (!body?.text) throw new Error("请粘贴 wg show 的输出");
    return be.sync(body.text);
  }


  if (seg[0] === "devices" && seg[2] === "config" && method === "GET") {
    const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(seg[1]);
    if (!peer) throw new Error("该设备没有配置记录");
    if (!peer.private_key) {
      throw new Error("这台是节点自助加入的，私钥只存在于节点本机（这是设计如此）");
    }
    const pf = be.profile?.() || {};
    const { clientConfig } = await import("./wg.js");
    const endpoint = effectiveEndpoint(req.headers?.host || "");
    return {
      endpointSet: !!endpoint,
      clientConfig: clientConfig({
        privateKey: peer.private_key,
        address: `${peer.address}/${(pf.subnet || cfg.meshCidr).split("/")[1] || 24}`,
        serverPubKey: pf.serverPub,
        endpoint: endpoint || "<先在设置里填 Endpoint>",
        subnet: pf.subnet || cfg.meshCidr,
        mtu: pf.mtu || 1420,
        dns: pf.dns || "",
        extraRoutes: pf.lanRoutes ? pf.lanRoutes.split(",").map(x => x.trim()).filter(Boolean) : [],
      }),
    };
  }


  // 把 mesh 内某台设备的端口，经 Cloudflare 隧道发布成域名
  if (seg[0] === "devices" && seg[2] === "publish" && method === "POST") {
    const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(seg[1]);
    if (!dev) throw new Error("设备不存在");
    if (dev.revoked_at) throw new Error("该设备已吊销");
    if (!dev.mesh_ip) throw new Error("这台还没有 mesh 地址");

    const hostname = String(body?.hostname || "").trim().toLowerCase().slice(0, 120);
    const port = Number(body?.port || 0);
    const scheme = body?.scheme === "https" ? "https" : "http";
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) throw new Error("域名格式不对，例：nas.example.com");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口范围 1-65535");

    const backend = `${dev.mesh_ip}:${port}`;
    const exist = db.prepare("SELECT * FROM tunnels WHERE hostname = ?").get(hostname);
    if (exist) {
      db.prepare("UPDATE tunnels SET backend = ?, health = 'unknown', last_check = ?, migratable = ? WHERE id = ?")
        .run(backend, now(), 0, exist.id);
    } else {
      const id = "t_" + crypto.randomBytes(4).toString("hex");
      db.prepare(`INSERT INTO tunnels(id,name,hostname,backend,health,latency_ms,last_check,migratable,demo)
                  VALUES(?,?,?,?,?,?,?,?,0)`)
        .run(id, hostname.split(".")[0], hostname, backend, "unknown", null, now(), 0);
    }
    addEvent("tunnel", `${hostname} → ${backend}（发布自 ${dev.name}）`, dev.id);

    const ingress = `# cloudflared 的 config.yml（命名隧道）或 Dashboard → Public Hostname
ingress:
  - hostname: ${hostname}
    service: ${scheme}://${backend}
  - service: http_status:404
`;
    const command = `docker run -d --name cf-${hostname.split(".")[0]} --restart unless-stopped \
  --network host \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <CF_TUNNEL_TOKEN>`;

    return { ok: true, hostname, backend, ingress, command,
      note: "cloudflared 必须跑在 mesh 内的一台机器上（控制台或任意节点），用 --network host 才能看到 10.88.0.0/24" };
  }

  if (seg[0] === "devices" && seg[2] === "roles" && method === "POST") {
    const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(seg[1]);
    if (!dev) throw new Error("设备不存在");
    const allowed = ["node", "relay", "gateway", "exit", "server"];
    const roles = (Array.isArray(body?.roles) ? body.roles : [])
      .map(r => String(r).trim()).filter(r => allowed.includes(r));
    if (!roles.includes("node")) roles.unshift("node");
    const routes = splitRoutes(body?.routes).filter(c => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(c));
    db.prepare("UPDATE devices SET roles = ?, routes = ? WHERE id = ?")
      .run(roles.join(","), routes.join(","), seg[1]);

    // 网段变化要同步到服务端对端的 allowed-ips，否则控制台到不了那个网段
    const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(seg[1]);
    if (peer && isManaged()) {
      try { await wg.addPeer(peer.public_key, peer.address, routes); } catch { /* 接口不在就忽略 */ }
    }
    addEvent("device", `${dev.name} 角色设为 ${roles.join("+")}${routes.length ? "，发布 " + routes.join(",") : ""}`, seg[1]);
    return { ok: true, roles, routes };
  }

  if (seg[0] === "devices" && seg[2] === "deploy" && method === "POST") {
    return deployInfo(seg[1], req);
  }


  // 彻底删除设备（与吊销不同：连记录和凭据一起清掉）
  if (seg[0] === "devices" && seg[2] === "delete" && method === "POST") {
    const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(seg[1]);
    if (!dev) throw new Error("设备不存在");
    const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(seg[1]);
    if (peer?.public_key && isManaged()) {
      try { await wg.removePeer(peer.public_key); } catch { /* 忽略 */ }
    }
    db.prepare("DELETE FROM wg_peers WHERE device_id = ?").run(seg[1]);
    db.prepare("DELETE FROM devices WHERE id = ?").run(seg[1]);
    db.prepare("DELETE FROM events WHERE device_id = ?").run(seg[1]);
    addEvent("device", `已删除设备 ${dev.name}（节点下次同步时会自动清理本机配置）`);
    return { ok: true };
  }


  // 手动卸载命令：节点离线 / 控制台地址变了导致自动清理跑不到时用

  // 单台设备的实时握手（控制台自己读 wg dump，不用登那台机器）
  if (seg[0] === "devices" && seg[2] === "status" && method === "GET") {
    const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(seg[1]);
    if (!dev) throw new Error("设备不存在");
    const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(seg[1]);
    if (!peer) throw new Error("该设备没有对端记录（自助加入的需要节点先连上）");

    let row = null;
    let managed = false;
    try {
      if (isManaged()) {
        managed = true;
        const dump = await wg.dump();
        row = dump.find(p => p.publicKey === peer.public_key) || null;
      }
    } catch { /* 读取失败当作未知 */ }

    const t = now();
    const hs = row?.handshake || 0;
    return {
      managed,
      iface: wg.iface,
      found: !!row,
      endpoint: row?.endpoint || dev.endpoint || "",
      handshake: hs || null,
      handshakeAgo: hs ? t - hs : null,
      rx: row?.rx ?? null,
      tx: row?.tx ?? null,
      alive: !!hs && t - hs < 180,
      tsIp: dev.ts_ip || "",
      tsAgo: dev.ts_at ? t - dev.ts_at : null,
      hints: !managed
        ? ["控制台未托管 awa0，读不到握手状态：先解决 NET_ADMIN（见设置页检测结果）"]
        : !row
          ? ["控制台接口里没有这个对端：点一次「一键部署」重新下发，或重启容器让它从库里恢复"]
          : !hs
            ? ["从未握手：UDP 51820 到控制台不通（云安全组 / 实例 iptables / 端口映射）"]
            : [],
    };
  }


  // 生成这台设备的 Tailscale 加入命令（管理端才可调用，会返回明文 key）
  if (seg[0] === "devices" && seg[2] === "ts-command" && method === "POST") {
    const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(seg[1]);
    if (!dev) throw new Error("设备不存在");
    const p = tsProfile();
    if (!p.authkey) throw new Error("还没配 Tailscale authkey（设置 → 兜底通道）");
    const cmd = p.loginServer
      ? `tailscale up --authkey '${p.authkey}' --hostname '${dev.name}-awa' --login-server '${p.loginServer}' --accept-routes`
      : `tailscale up --authkey '${p.authkey}' --hostname '${dev.name}-awa' --accept-routes`;
    addEvent("device", `为 ${dev.name} 生成 Tailscale 加入命令`, seg[1]);
    return { command: cmd, installed: !!dev.ts_ip, tsIp: dev.ts_ip || "" };
  }

  if (seg[0] === "devices" && seg[2] === "uninstall" && method === "GET") {
    const dev = db.prepare("SELECT * FROM devices WHERE id = ?").get(seg[1]);
    if (!dev) throw new Error("设备不存在");
    const iface = "awa0";
    const sh = [
      `wg-quick down ${iface} 2>/dev/null || ip link del ${iface} 2>/dev/null || true`,
      `rm -f /etc/wireguard/${iface}.conf /etc/wireguard/awa.token /etc/wireguard/awa.iface`,
      `systemctl disable --now awa-peers.timer 2>/dev/null || true`,
      `systemctl disable --now awa-peers.service 2>/dev/null || true`,
      `rm -f /etc/systemd/system/awa-peers.timer /etc/systemd/system/awa-peers.service`,
      `systemctl daemon-reload 2>/dev/null || true`,
      `crontab -l 2>/dev/null | grep -v awa-peers | crontab - 2>/dev/null || true`,
      `rm -f /usr/local/bin/awa-peers`,
      `echo "awamesh: 已卸载 ${iface} 与相关定时任务"`,
    ].join("\n");
    const ps = [
      '%WGP% = Join-Path $env:ProgramFiles "WireGuard\\wireguard.exe"',
      '& %WGP% /uninstalltunnelservice ' + iface,
      'Remove-Item (Join-Path $env:ProgramFiles "WireGuard\\Data\\Configurations\\' + iface + '.conf") -Force -ErrorAction SilentlyContinue',
      'Write-Host "awamesh: 已卸载 ' + iface + '"',
    ].join("\n").replace(/%WGP%/g, "$wg");
    return { shell: sh, ps, iface, name: dev.name };
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
    if (enabled && typeof globalThis.__awaProbeRelays === "function") {
      globalThis.__awaProbeRelays().catch(() => {});
    }
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
    return { tunnels: listTunnels(), cfEnabled: cfEnabled() };
  }



  if (url.pathname === "/api/ts/profile" && method === "GET") {
    const p = tsProfile();
    return {
      enabled: p.enabled,
      hint: p.authkey ? p.authkey.slice(0, 8) + "…" : "",
      loginServer: p.loginServer,
      devices: db.prepare("SELECT COUNT(*) c FROM devices WHERE ts_ip IS NOT NULL AND revoked_at IS NULL").get().c,
    };
  }

  if (url.pathname === "/api/ts/profile" && method === "POST") {
    if (body?.authkey !== undefined) {
      const k = String(body.authkey).trim();
      if (k && !/^tskey-[A-Za-z0-9_-]{10,}$/.test(k)) throw new Error("Tailscale authkey 形如 tskey-auth-xxxx");
      saveSecretSetting("ts_authkey", k);
      addEvent("settings", k ? "Tailscale 兜底已启用" : "Tailscale 兜底已关闭");
    }
    if (body?.loginServer !== undefined) setting("ts_login_server", String(body.loginServer).trim());
    return { ok: true, enabled: tsProfile().enabled };
  }

  if (url.pathname === "/api/cf/profile" && method === "GET") {
    return {
      enabled: cfEnabled(),
      tokenSet: !!cfToken(),
      tokenHint: cfToken() ? cfToken().slice(0, 4) + "…" + cfToken().slice(-4) : "",
      account: cfAccount(),
    };
  }

  if (url.pathname === "/api/cf/profile" && method === "POST") {
    if (body?.token !== undefined) {
      const t = String(body.token).trim();
      if (t && !/^[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error("Token 看起来不对（应是一串不含空格的字符）");
      setCfToken(t);
      addEvent("settings", t ? "Cloudflare Token 已更新" : "Cloudflare Token 已清除");
    }
    if (body?.account !== undefined) setCfAccount(String(body.account).trim());
    return { ok: true, enabled: cfEnabled(), account: cfAccount() };
  }

  if (url.pathname === "/api/cf/test" && method === "POST") {
    if (!cfEnabled()) throw new Error("还没填 Token（设置 → Cloudflare）");

    // GET /accounts 需要「Account → Account Settings → Read」；
    // 只给 Cloudflare Tunnel 权限的 Token 会返回空数组，这不是 Token 错，是权限不够列账户。
    const accounts = await listAccounts().catch(() => []);

    let account = cfAccount();
    if (accounts.length && !account) {
      account = accounts[0].id;
      setCfAccount(account);
    }
    if (!account) {
      throw Object.assign(
        new Error("这个 Token 没有「Account → Account Settings → Read」，列不出账户。请在下面「Account ID」填上那串 32 位字符串再测"),
        { status: 400 }
      );
    }

    let ping;
    try {
      ping = await pingAccount(account);
    } catch (e) {
      throw Object.assign(
        new Error(`读该账户的隧道失败：${e.message}（Token 需要 Account → Cloudflare Tunnel → Read）`),
        { status: 502 }
      );
    }

    addEvent("settings", `Cloudflare 连接正常（账户 ${account.slice(0, 8)}…，${ping.tunnels} 条隧道可读）`);
    return {
      ok: true,
      account,
      tunnelCount: ping.tunnels,
      accounts: accounts.map(a => ({ id: a.id, name: a.name })),
      canListAccounts: accounts.length > 0,
    };
  }

  if (url.pathname === "/api/tunnels/sync" && method === "POST") {
    if (!cfEnabled()) throw Object.assign(new Error("未配置 AWA_CF_TOKEN，无法从 Cloudflare 同步"), { status: 400 });
    const accounts = await listAccounts();
    const accountId = body?.account || url.searchParams.get("account") || cfAccount() || accounts[0]?.id;
    if (!accountId) throw new Error("没有可用的 Cloudflare 账户（Token 需要 Account:Read）");
    const items = await cfListTunnels(accountId);
    const n = toRows(items, db);
    addEvent("tunnel", `从 Cloudflare 同步 ${n} 条 ingress 记录`);
    return { ok: true, accountId, count: n };
  }

  if (url.pathname === "/api/relays/map" && method === "GET") {
    const list = listRelays().filter(r => r.enabled && r.kind !== "builtin");
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
    if (r.kind === "builtin") throw new Error("内置中转不需要部署命令");

    const token = "rl_" + crypto.randomBytes(20).toString("hex");
    db.prepare("UPDATE relays SET token_hash = ? WHERE id = ?")
      .run(crypto.createHash("SHA256").update(token).digest("hex"), r.id);
    addEvent("relay", `为 ${r.name} 生成接入命令（重生成后旧命令失效）`);
    return { script: relayScript(r, cfg, token, publicBase(req)), relay: r };
  }

  if (url.pathname === "/api/relay/state" && method === "GET") {
    return { ok: true };
  }


  if (url.pathname === "/api/relays" && method === "POST") {
    const name = String(body?.name || "").trim().slice(0, 40);
    const region = String(body?.region || "").trim().slice(0, 20) || "自定义";
    const addr = String(body?.addr || "").trim();
    const port = Number(body?.port || cfg.relayPort);
    if (!name) throw new Error("中继名称不能为空");
    if (!addr || /\s/.test(addr)) throw new Error("地址不能为空且不能含空格");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口范围 1-65535");
    const id = "r_" + Math.random().toString(16).slice(2, 10);
    db.prepare(`INSERT INTO relays(id,name,region,region_code,addr,port,visibility,quota_gb,used_gb,state,enabled,last_health,demo)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(id, name, region, region.toLowerCase().replace(/[^a-z0-9]/g, "") || "relay", addr, port,
        body?.visibility === "private" ? "private" : "public", Number(body?.quotaGb || 0), 0, "pending", 1, null);
    addEvent("relay", `新增中继 ${name}（${addr}:${port}）`);
    if (typeof globalThis.__awaProbeRelays === "function") {
      globalThis.__awaProbeRelays().catch(() => {});
    }
    return { ok: true, id };
  }

  if (url.pathname === "/api/relays/probe" && method === "POST") {
    if (typeof globalThis.__awaProbeRelays !== "function") throw new Error("探测未就绪");
    await globalThis.__awaProbeRelays();
    return { ok: true, relays: listRelays().map(r => ({ id: r.id, state: r.state, last_health: r.last_health })) };
  }

  if (seg[0] === "relays" && seg[2] === "delete" && method === "POST") {
    const row = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("中继不存在");
    if (row.id === "r_builtin") throw new Error("内置中转是控制台自身，不能删除（可在设置里关闭内置中转）");
    db.prepare("DELETE FROM relays WHERE id = ?").run(seg[1]);
    addEvent("relay", `删除中继 ${row.name}`);
    return { ok: true };
  }

  if (url.pathname === "/api/tunnels" && method === "POST") {
    const hostname = String(body?.hostname || "").trim().toLowerCase().slice(0, 120);
    const backend = String(body?.backend || "").trim().slice(0, 120);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) throw new Error("域名格式不对，例：nas.example.com");
    if (!backend || !/^[^\s]+:\d{1,5}$/.test(backend)) throw new Error("后端写成 IP或主机:端口，例：10.88.0.5:8080");
    const id = "t_" + Math.random().toString(16).slice(2, 10);
    db.prepare(`INSERT INTO tunnels(id,name,hostname,backend,health,latency_ms,last_check,migratable,demo)
                VALUES(?,?,?,?,?,?,?,?,0)`)
      .run(id, hostname.split(".")[0], hostname, backend, "unknown", null, now(),
        /^(localhost|127\.)/.test(backend) ? 1 : 0);
    addEvent("tunnel", `新增隧道 ${hostname} → ${backend}`);
    return { ok: true, id };
  }

  if (seg[0] === "tunnels" && seg[2] === "delete" && method === "POST") {
    const row = db.prepare("SELECT * FROM tunnels WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("隧道不存在");
    db.prepare("DELETE FROM tunnels WHERE id = ?").run(seg[1]);
    addEvent("tunnel", `删除隧道 ${row.hostname}`);
    return { ok: true };
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
      publicUrl: setting("public_url") || cfg.controlUrl || "",
      allowCidr: cfg.allowCidr || "",
      trustProxy: cfg.trustProxy,
      sessionDays: cfg.sessionDays,
      wgManaged: isManaged(),
      wgIface: wg.iface,
      wgPeers: db.prepare("SELECT COUNT(*) c FROM wg_peers").get().c,
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
