import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";
import { setting } from "./db.js";

const run = promisify(execFile);
const IFACE = process.env.AWA_WG_IFACE || "awa0";

let managed = false;
export function isManaged() { return managed; }
export function setManaged(v) { managed = !!v; }

export const wg = {
  iface: IFACE,
  /** 容器里有没有 wg 命令、能不能建接口 */
  async available() {
    try {
      await run("wg", ["--version"], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  },

  async sh(cmd, args) {
    try {
      return await run(cmd, args, { timeout: 8000 });
    } catch (err) {
      const msg = (err.stderr || err.message || "").toString().trim().split("\n")[0];
      throw new Error(`${cmd} ${args[0] || ""} 失败：${msg}`);
    }
  },

  keyPath() {
    return path.join(cfg.dataDir, "wg-server.key");
  },

  /** 把服务端私钥落到文件（wg set 只认文件），权限 600 */
  writeKey() {
    const priv = setting("wg_server_priv");
    if (!priv) throw new Error("还没有服务端密钥");
    const p = this.keyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, priv, { mode: 0o600 });
    return p;
  },

  /** 建接口、设地址、监听端口；已存在则只更新 */
  async ensure(serverIp, mtu, port) {
    const keyFile = this.writeKey();
    try {
      await this.sh("ip", ["link", "add", "dev", this.iface, "type", "wireguard"]);
    } catch (e) {
      if (!/exist/i.test(e.message)) throw e; // 已存在就继续
    }
    await this.sh("wg", ["set", this.iface, "private-key", keyFile, "listen-port", String(port)]);
    try {
      await this.sh("ip", ["addr", "add", `${serverIp}/24`, "dev", this.iface]);
    } catch (e) {
      if (!/exist/i.test(e.message)) throw e;
    }
    await this.sh("ip", ["link", "set", "mtu", String(mtu), "up", "dev", this.iface]);
    return true;
  },

  async addPeer(publicKey, address, extraCidrs = []) {
    const allowed = [`${address}/32`, ...(extraCidrs || []).filter(Boolean)].join(",");
    await this.sh("wg", ["set", this.iface, "peer", publicKey, "allowed-ips", allowed]);
  },

  async setEndpoint(publicKey, endpoint) {
    if (!endpoint) return;
    try {
      await this.sh("wg", ["set", this.iface, "peer", publicKey, "endpoint", endpoint]);
    } catch {
      /* 对端暂不可达时忽略 */
    }
  },

  async removePeer(publicKey) {
    try {
      await this.sh("wg", ["set", this.iface, "peer", publicKey, "remove"]);
    } catch {
      /* 不在就忽略 */
    }
  },

  /** 解析 `wg show <iface> dump`：真实握手时间、流量、当前 endpoint */
  async dump() {
    const { stdout } = await this.sh("wg", ["show", this.iface, "dump"]);
    const lines = stdout.trim().split("\n");
    const peers = [];
    for (const line of lines.slice(1)) {
      const f = line.split("\t");
      peers.push({
        publicKey: f[0],
        endpoint: f[2] === "(none)" ? null : f[2],
        allowedIps: (f[3] || "").split(",").filter(Boolean),
        handshake: Number(f[4]) || 0,   // unix 秒；0 = 从未
        rx: Number(f[5]) || 0,
        tx: Number(f[6]) || 0,
      });
    }
    return peers;
  },
};

/** 由公钥反查是否是我们发出去的 peer（用于状态刷新） */
export function addressOf(peer) {
  const ip = (peer.allowedIps || []).find(x => x.includes("/"));
  return ip ? ip.replace(/\/\d+$/, "") : "";
}
