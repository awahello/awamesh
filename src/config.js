import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env;

export const cfg = {
  version: "0.1.0",
  port: Number(env.AWA_PORT || 18443),
  host: env.AWA_HOST || "0.0.0.0",
  dataDir: path.resolve(env.AWA_DATA_DIR || "./data"),
  mode: (env.AWA_MODE || "full").toLowerCase(), // full | tiny
  backend: (env.AWA_BACKEND || "mock").toLowerCase(), // mock | headscale
  headscaleCmd: env.AWA_HEADSCALE_CMD || "headscale",
  headscaleUser: env.AWA_HEADSCALE_USER || "awamesh",
  meshCidr: env.AWA_MESH_CIDR || "10.88.0.0/24",
  meshDomain: env.AWA_MESH_DOMAIN || "mesh",
  mtu: Number(env.AWA_MTU || 1420),
  eventKeepDays: Number(env.AWA_EVENT_KEEP_DAYS || 30),
  controlUrl: env.AWA_CONTROL_URL || "",
  cfToken: env.AWA_CF_TOKEN || "",
  relayPort: Number(env.AWA_RELAY_PORT || 8443),
};

fs.mkdirSync(cfg.dataDir, { recursive: true });

/** 密钥落盘：优先环境变量，否则首次生成并保存在 data 目录（权限 600） */
function loadSecret() {
  if (env.AWA_SECRET && env.AWA_SECRET.length >= 16) return env.AWA_SECRET;
  const file = path.join(cfg.dataDir, "secret.key");
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v.length >= 16) return v;
  } catch {}
  const v = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

export const secret = loadSecret();

export function log(...args) {
  console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...args);
}
