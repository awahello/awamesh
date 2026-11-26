import { execFile } from "node:child_process";
import dgram from "node:dgram";
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

  /** 探测本命名空间里某 UDP 端口能不能占（不影响宿主机其它服务的判断） */
  async udpFree(port) {
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: false });
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { s.close(); } catch {} resolve(v); } };
      s.once("error", () => finish(false));
      s.once("listening", () => finish(true));
      try { s.bind({ address: "0.0.0.0", port }); } catch { finish(false); }
      setTimeout(() => finish(false), 800);
    });
  },

  /** 从 preferred 往后找一个空闲 UDP 端口，避免顶掉已有的 WireGuard / 服务 */
  async pickPort(preferred) {
    const start = Number(preferred) || 51820;
    for (let p = start; p < start + 50; p++) {
      if (p > 65535) break;
      if (await this.udpFree(p)) return p;
    }
    return start;
  },
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
  async ensure(serverIp, mtu, port, subnetBits = 24) {
    const keyFile = this.writeKey();
    try {
      await this.sh("ip", ["link", "add", "dev", this.iface, "type", "wireguard"]);
    } catch (e) {
      if (!/exist/i.test(e.message)) throw e; // 已存在就继续
    }
    await this.sh("wg", ["set", this.iface, "private-key", keyFile, "listen-port", String(port)]);
    try {
      await this.sh("ip", ["addr", "add", `${serverIp}/${subnetBits}`, "dev", this.iface]);
    } catch (e) {
      if (!/exist/i.test(e.message)) throw e;
    }
    await this.sh("ip", ["link", "set", "mtu", String(mtu), "up", "dev", this.iface]);
    return true;
  },

  /** 当前接口真实的 UDP 监听端口（建接口后可能与配置里的不同） */
  async listenPort() {
    try {
      const { stdout } = await this.sh("wg", ["show", this.iface, "listen-port"]);
      return Number(String(stdout).trim()) || 0;
    } catch {
      return 0;
    }
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
