import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env;

export const cfg = {
  version: "0.2.0",
  port: Number(env.AWA_PORT || 18443),
  host: env.AWA_HOST || "0.0.0.0",
  dataDir: path.resolve(env.AWA_DATA_DIR || "./data"),
  mode: (env.AWA_MODE || "full").toLowerCase(), // full | tiny
  backend: (env.AWA_BACKEND || "wg").toLowerCase(), // mock | headscale
  headscaleCmd: env.AWA_HEADSCALE_CMD || "headscale",
  headscaleUser: env.AWA_HEADSCALE_USER || "awamesh",
  meshCidr: env.AWA_MESH_CIDR || "10.88.0.0/24",
  meshDomain: env.AWA_MESH_DOMAIN || "mesh",
  mtu: Number(env.AWA_MTU || 1420),
  eventKeepDays: Number(env.AWA_EVENT_KEEP_DAYS || 30),
  controlUrl: env.AWA_CONTROL_URL || "",
  cfToken: env.AWA_CF_TOKEN || "",
  relayPort: Number(env.AWA_RELAY_PORT || 18444),
};

// 数据目录：写坏/不可写时给出可执行的修复建议，而不是甩一段堆栈
if (/[\r\n\t]/.test(cfg.dataDir)) {
  console.error("[fatal] AWA_DATA_DIR 含空白字符（常见于 compose 粘贴时换行丢失）：" + JSON.stringify(cfg.dataDir));
  console.error("        请改成 /data 这样的绝对路径后重启");
  process.exit(1);
}
try {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.accessSync(cfg.dataDir, fs.constants.W_OK);
} catch (err) {
  console.error("[fatal] 数据目录不可写：" + cfg.dataDir + "（" + err.code + "）");
  console.error("        容器里最常见的原因：宿主机 ./data 由 root 创建，而容器以 node(uid 1000) 运行");
  console.error("        修复一：sudo chown -R 1000:1000 ./data");
  console.error("        修复二：把挂载改成命名卷  - data:/data （compose 末尾加 volumes: { data: }）");
  process.exit(1);
}

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
