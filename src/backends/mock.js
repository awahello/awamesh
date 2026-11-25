import crypto from "node:crypto";
import { db, now, listDevices, addEvent } from "../db.js";

/** mock 后端：直接用本地表里的数据，方便没有 headscale 时跑通界面 */
export const mockBackend = {
  name: "mock",
  available: true,

  devices() {
    return listDevices().map(d => ({
      ...d,
      online: !!d.last_seen && now() - d.last_seen < 300 && !d.revoked_at,
      path: d.path || "",
    }));
  },

  rename(id, name) {
    const clean = String(name || "").trim().slice(0, 64);
    if (!clean) throw new Error("名称不能为空");
    db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(clean, id);
    addEvent("device", `重命名设备为 ${clean}`, id);
    return true;
  },

  revoke(id) {
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(now(), id);
    addEvent("device", "已吊销节点密钥", id);
    return true;
  },

  createKey(tag = "test", ttlHours = 1) {
    const plain = "awa_" + crypto.randomBytes(10).toString("hex");
    const hash = crypto.createHash("SHA256").update(plain).digest("hex");
    const id = "k_" + crypto.randomBytes(4).toString("hex");
    db.prepare("INSERT INTO authkeys(id,tag,hash,expires_at,used_at,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, tag, hash, now() + ttlHours * 3600, null, now());
    addEvent("key", `生成一次性密钥（${tag}，${ttlHours} 小时）`);
    return { id, key: plain, tag, expiresAt: now() + ttlHours * 3600 };
  },
};
