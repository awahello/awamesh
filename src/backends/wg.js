import crypto from "node:crypto";
import { db, now, setting, listDevices, addEvent } from "../db.js";
import { cfg } from "../config.js";
import { genKeypair, hostInCidr, clientConfig, serverPeerBlock, openwrtPeerSnippet, parseWgShow } from "../wg.js";

db.exec(`
CREATE TABLE IF NOT EXISTS wg_peers (
  device_id TEXT PRIMARY KEY,
  private_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER
);
`);

function profile() {
  let serverPriv = setting("wg_server_priv");
  let serverPub = setting("wg_server_pub");
  if (!serverPriv || !serverPub) {
    const kp = genKeypair();
    serverPriv = kp.privateKey;
    serverPub = kp.publicKey;
    setting("wg_server_priv", serverPriv);
    setting("wg_server_pub", serverPub);
  }
  return {
    endpoint: setting("wg_endpoint") || "",
    serverPub,
    serverPriv,
    subnet: setting("wg_subnet") || cfg.meshCidr,
    mtu: Number(setting("wg_mtu") || cfg.mtu),
    dns: setting("wg_dns") || "",
    lanRoutes: setting("wg_lan_routes") || "",
  };
}

export const wgBackend = {
  name: "wg",
  available: true,
  profile,

  devices() {
    const rows = db.prepare(`
      SELECT d.*, p.public_key AS wg_pub, p.address AS wg_addr
      FROM devices d LEFT JOIN wg_peers p ON p.device_id = d.id
      ORDER BY (d.revoked_at IS NOT NULL), d.mesh_ip`).all();
    return rows.map(d => ({
      ...d,
      tags: d.tags ? d.tags.split(",").filter(Boolean) : [],
      roles: (d.roles || "node").split(","),
      online: !!d.last_seen && now() - d.last_seen < 180 && !d.revoked_at,
      path: d.last_seen && now() - d.last_seen < 180 ? "direct" : "",
    }));
  },

  /** 新建一台真实设备：分配地址、生成密钥、返回可直接粘贴的配置 */
  create(nameRaw) {
    const name = String(nameRaw || "").trim().slice(0, 40);
    if (!name) throw new Error("设备名不能为空");
    const pf = profile();

    const used = new Set(db.prepare("SELECT address FROM wg_peers").all().map(r => r.address));
    for (const d of db.prepare("SELECT mesh_ip FROM devices WHERE mesh_ip IS NOT NULL AND revoked_at IS NULL").all()) {
      if (d.mesh_ip) used.add(d.mesh_ip);
    }
    let n = 2, address = "";
    for (; n < 250; n++) {
      const candidate = hostInCidr(pf.subnet, n);
      if (!used.has(candidate)) { address = candidate; break; }
    }
    if (!address) throw new Error("网段里没有可用地址了");

    const kp = genKeypair();
    const id = "d_" + crypto.randomBytes(5).toString("hex");
    const t = now();
    db.prepare(`INSERT INTO devices(id,name,mesh_ip,hostname,os,client_ver,tags,roles,path,latency_ms,relay,last_seen,key_fp,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, address, name, "", "", "", "node", "", null, null, null, kp.publicKey, t);
    db.prepare("INSERT INTO wg_peers(device_id,private_key,public_key,address,created_at) VALUES(?,?,?,?,?)")
      .run(id, kp.privateKey, kp.publicKey, address, t);

    addEvent("device", `已创建设备 ${name}（${address}）`, id);

    return {
      id,
      name,
      address,
      publicKey: kp.publicKey,
      clientConfig: clientConfig({
        privateKey: kp.privateKey,
        address: `${address}/${pf.subnet.split("/")[1] || 24}`,
        serverPubKey: pf.serverPub,
        endpoint: pf.endpoint || "<你的服务器地址>:51820",
        subnet: pf.subnet,
        mtu: pf.mtu,
        dns: pf.dns,
        extraRoutes: pf.lanRoutes ? pf.lanRoutes.split(",").map(s => s.trim()).filter(Boolean) : [],
      }),
      serverPeer: serverPeerBlock({ publicKey: kp.publicKey, address, name }),
      openwrt: openwrtPeerSnippet({ publicKey: kp.publicKey, address, name }),
    };
  },

  rename(id, name) {
    const clean = String(name || "").trim().slice(0, 40);
    if (!clean) throw new Error("名称不能为空");
    db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(clean, id);
    addEvent("device", `重命名为 ${clean}`, id);
    return true;
  },

  revoke(id) {
    db.prepare("DELETE FROM wg_peers WHERE device_id = ?").run(id);
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(now(), id);
    addEvent("device", "已吊销（记得同步删除服务端的 [Peer] 段）", id);
    return true;
  },

  /** 粘贴 `wg show` 的输出，刷新真实握手与流量 */
  sync(text) {
    const rows = parseWgShow(text);
    const byIp = new Map(db.prepare("SELECT device_id, address FROM wg_peers").all().map(r => [r.address, r.device_id]));
    const byKey = new Map(db.prepare("SELECT device_id, public_key FROM wg_peers").all().map(r => [r.public_key, r.device_id]));
    let matched = 0;
    const t = now();
    for (const p of rows) {
      let id = byKey.get(p.publicKey);
      if (!id) {
        for (const ip of p.allowedIps) {
          const bare = ip.replace(/\/32$/, "");
          if (byIp.has(bare)) { id = byIp.get(bare); break; }
        }
      }
      if (!id) continue;
      matched++;
      const seen = p.handshakeAgo === null ? null : t - p.handshakeAgo;
      db.prepare("UPDATE devices SET last_seen = ?, path = ?, relay = NULL WHERE id = ?")
        .run(seen, seen && t - seen < 180 ? "direct" : "", id);
    }
    addEvent("sync", `导入 wg show：识别 ${rows.length} 个 peer，匹配 ${matched} 台设备`);
    return { parsed: rows.length, matched };
  },
};
