import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cfg, secret } from "./config.js";
import { setting } from "./db.js";

const DIGEST = "SHA256";
const SESSION_TTL = Math.max(1, Number(process.env.AWA_SESSION_DAYS || 7)) * 86400;

export function hashCredential(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 32).toString("hex");
  return `s2$${salt}$${hash}`;
}

export function verifyCredential(plain, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s2") return false;
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(String(plain), parts[1], expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** 会话纪元：改口令时 +1，让所有已签发的会话立即失效 */
function epoch() {
  return String(setting("session_epoch") || "0");
}

export function rotateSessions() {
  setting("session_epoch", String(Number(epoch()) + 1));
}

export function sessionToken() {
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac(DIGEST, secret).update(`s|${epoch()}|${ts}`).digest("hex");
  return `${ts}.${mac}`;
}

export function validSession(token) {
  if (!token) return false;
  const [ts, mac] = String(token).split(".");
  if (!ts || !mac) return false;
  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_TTL) return false;
  const expect = crypto.createHmac(DIGEST, secret).update(`s|${epoch()}|${ts}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expect, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 首次启动：生成后台口令，落盘 + 打印一次，避免默认口令 */
export function ensureAdminCredential() {
  if (setting("admin_credential")) return false;
  const plain = crypto.randomBytes(9).toString("base64url");
  setting("admin_credential", hashCredential(plain));
  const file = path.join(cfg.dataDir, "initial-admin.txt");
  fs.writeFileSync(
    file,
    `awamesh 首次启动的后台口令（登录后请在设置里修改）：\n${plain}\n`,
    { mode: 0o600 }
  );
  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │  awamesh 首次启动                             │");
  console.log("  │  后台口令：" + plain.padEnd(34) + "│");
  console.log("  │  已写入 data/initial-admin.txt                │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");
  return true;
}

export function cookieHeader(token, maxAge = SESSION_TTL, secure = false) {
  return `awa_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearCookieHeader(secure = false) {
  return `awa_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
