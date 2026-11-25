// awamesh 自测：node scripts/selftest.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awamesh-test-"));
const port = 18000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--no-warnings", "src/server.js"], {
  env: { ...process.env, AWA_PORT: String(port), AWA_HOST: "127.0.0.1", AWA_DATA_DIR: dir, AWA_BACKEND: "mock", AWA_DEMO: "1" },
  stdio: ["ignore", "ignore", "ignore"],
});

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  -> " + extra));
  if (!ok) fail++;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

let cookie = "";
async function call(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

try {
  check("服务启动", await waitUp(), "健康检查未通过");

  const cred = fs.readFileSync(path.join(dir, "initial-admin.txt"), "utf8").split("\n")[1].trim();
  check("首次口令已生成", cred.length >= 8, cred);

  let r = await call("/api/devices");
  check("未登录访问 API 被拒绝", r.status === 401, r.status);

  r = await call("/api/login", { method: "POST", body: JSON.stringify({ secret: "wrong-" + Date.now() }) });
  check("错误口令返回 401", r.status === 401, r.status);

  r = await call("/api/login", { method: "POST", body: JSON.stringify({ secret: cred }) });
  check("正确口令登录成功", r.status === 200 && cookie.startsWith("awa_session="), r.text);

  r = await call("/api/overview");
  check("概览返回设备数", r.status === 200 && r.body.devices.total > 0, JSON.stringify(r.body).slice(0, 120));
  check("概览含直连占比", typeof r.body.directRatio === "number", r.body.directRatio);

  r = await call("/api/devices?filter=relay");
  check("中继设备筛选", r.status === 200 && r.body.devices.length >= 1, JSON.stringify(r.body).slice(0, 120));

  r = await call("/api/devices?q=db");
  check("搜索设备", r.status === 200 && r.body.devices.some(d => d.name.includes("db")), JSON.stringify(r.body).slice(0, 120));

  r = await call("/api/devices/d_win/rename", { method: "POST", body: JSON.stringify({ name: "win-01" }) });
  check("重命名设备", r.status === 200 && r.body.ok, r.text);

  r = await call("/api/keys", { method: "POST", body: JSON.stringify({ tag: "selftest", ttl: 1 }) });
  const key = r.body.key;
  check("生成一次性密钥", r.status === 200 && /^awa_[a-f0-9]{16,}$/.test(key), r.text);

  r = await call("/join.sh?key=" + key);
  check("接入脚本可直接执行", r.status === 200 && r.text.includes(key) && r.text.includes("tailscale up"), r.text.slice(0, 80));

  r = await call("/api/relays");
  check("中继列表", r.status === 200 && r.body.relays.length >= 3, JSON.stringify(r.body).slice(0, 100));

  r = await call("/api/relays/r_hk/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) });
  check("中继可摘除", r.status === 200 && r.body.ok, r.text);

  r = await call("/api/relays/map");
  check("中继地图可导出", r.status === 200 && r.body.yaml.includes("regions:") && r.body.count >= 1, r.text.slice(0, 80));

  r = await call("/api/relays/r_hk/command");
  check("中继接入命令", r.status === 200 && r.body.script.includes("derper"), r.text.slice(0, 80));

  r = await call("/api/tunnels/sync", { method: "POST", body: "{}" });
  check("未配 Token 时同步给出明确报错", r.status === 400 && /AWA_CF_TOKEN/.test(r.body.error || ""), r.text.slice(0, 80));

  r = await call("/api/tunnels");
  check("隧道列表", r.status === 200 && r.body.tunnels.length >= 4, JSON.stringify(r.body).slice(0, 100));

  r = await call("/api/settings");
  check("设置只读信息", r.status === 200 && r.body.version, r.text.slice(0, 80));

  r = await call("/");
  check("前端页面可访问", r.status === 200 && r.text.includes("awamesh"), r.status);

  r = await call("/api/not-exist");
  check("未知接口返回 404", r.status === 404, r.status);
} catch (err) {
  check("自测执行未抛错", false, err.message);
} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
