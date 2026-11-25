import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cfg } from "../config.js";

const run = promisify(execFile);

async function hs(args) {
  const bin = cfg.headscaleCmd;
  const { stdout } = await run(bin, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function hsJson(args) {
  const out = await hs(args);
  const start = out.indexOf("[") >= 0 ? out.indexOf("[") : out.indexOf("{");
  if (start < 0) return null;
  return JSON.parse(out.slice(start));
}

function pickIp(node) {
  const ips = node.ipAddresses || node.ip_addresses || node.ips || [];
  const v4 = ips.map(String).find(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
  return v4 || ips[0] || "";
}

/**
 * headscale 后端：通过 headscale CLI 读取/操作节点。
 * 需要 headscale 在 PATH 里，且当前用户有权限（通常 root）。
 * 注意：不同 headscale 版本的 JSON 字段略有差异，这里做了兼容取值。
 */
export const headscaleBackend = {
  name: "headscale",
  get available() { return true; },

  async devices() {
    const raw = await hsJson(["nodes", "list", "-o", "json"]);
    const list = Array.isArray(raw) ? raw : [];
    return list.map(n => {
      const seen = n.lastSeen || n.last_seen;
      const ts = seen ? Math.floor(new Date(seen).getTime() / 1000) : null;
      const online = typeof n.online === "boolean" ? n.online : !!ts && Math.floor(Date.now() / 1000) - ts < 300;
      return {
        id: String(n.id),
        name: n.givenName || n.given_name || n.name || n.hostname || `node-${n.id}`,
        mesh_ip: pickIp(n),
        hostname: n.hostname || "",
        os: n.os || n.operatingSystem || "",
        client_ver: n.ipnVersion || n.ipn_version || "",
        tags: n.forcedTags || n.forced_tags || n.tags || [],
        roles: ["node"],
        path: online ? "direct" : "",
        latency_ms: null,
        relay: null,
        last_seen: ts,
        online,
        key_fp: n.publicKey || n.public_key || "",
        revoked_at: n.expiry && new Date(n.expiry).getTime() < Date.now() ? 1 : null,
      };
    });
  },

  async rename(id, name) {
    await hs(["nodes", "rename", "-i", String(id), String(name).trim().slice(0, 63)]);
    return true;
  },

  async revoke(id) {
    await hs(["nodes", "delete", "-i", String(id), "--force"]);
    return true;
  },

  async createKey(tag = "awamesh", ttlHours = 1) {
    const user = cfg.headscaleUser || "awamesh";
    const out = await hs([
      "preauthkeys", "create", "--user", user,
      "--expiration", `${ttlHours}h`, "--reusable=false", "-o", "json",
    ]);
    const obj = JSON.parse(out.slice(out.indexOf("{")));
    return { id: String(obj.id || ""), key: obj.key || "", tag, expiresAt: null };
  },
};
