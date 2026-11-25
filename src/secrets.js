import crypto from "node:crypto";
import { secret } from "./config.js";
import { setting } from "./db.js";

const KEY = crypto.createHash("SHA256").update(secret).digest(); // 32 字节

/** AES-256-GCM 加密，存库用；密钥来自 AWA_SECRET */
export function seal(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function open(box) {
  if (!box) return "";
  try {
    const buf = Buffer.from(box, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** 读取写在库里的敏感配置（环境变量优先） */
export function secretSetting(name, envValue) {
  if (envValue) return envValue;
  return open(setting("enc_" + name) || "");
}

export function saveSecretSetting(name, plain) {
  setting("enc_" + name, seal(plain));
}
