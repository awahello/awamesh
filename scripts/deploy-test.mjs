// 一键部署链路自测：node scripts/deploy-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awamesh-deploy-"));
const port = 18500 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--no-warnings", "src/server.js"], {
  env: { ...process.env, AWA_PORT: String(port), AWA_HOST: "127.0.0.1", AWA_DATA_DIR: dir, AWA_BACKEND: "wg" },
  stdio: ["ignore", "ignore", "ignore"],
});

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  -> " + extra));
  if (!ok) fail++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    await sleep(200);
  }

  const cred = fs.readFileSync(path.join(dir, "initial-admin.txt"), "utf8").split("\n")[1].trim();
  await call("/api/login", { method: "POST", body: JSON.stringify({ secret: cred }) });

  let r = await call("/api/devices", { method: "POST", body: JSON.stringify({ name: "node-a" }) });
  check("创建设备", r.status === 200 && r.body.address === "10.88.0.2", r.text.slice(0, 120));
  const id = r.body.id;

  r = await call(`/api/devices/${id}/deploy`, { method: "POST", body: "{}" });
  check("生成一键部署命令", r.status === 200 && /\/dp\/dp_[a-f0-9]{8,}/.test(r.body.command), r.text.slice(0, 160));
  check("命令带 curl|sh 形态", r.status === 200 && r.body.command.startsWith("curl -fsSL"), r.body.command);
  const token = r.body.token;

  r = await call(`/dp/${token}`);
  check("部署脚本可下载且已填 token", r.status === 200 && r.text.includes(token) && r.text.includes("wg-quick up"), r.text.slice(0, 80));
  check("脚本没有残留占位符", !r.text.includes("@@SERVER@@") && !r.text.includes("@@TOKEN@@"));

  r = await call(`/api/deploy/config?token=${token}`);
  check("凭据可换到完整配置", r.status === 200 && r.text.includes("[Interface]") && /^Endpoint = \S+$/m.test(r.text), r.text.slice(0, 200));
  check("配置里没有空 Endpoint", !r.text.includes("Endpoint = <"), r.text);

  r = await call("/api/deploy/config?token=dp_notarealtoken00");
  check("错误凭据被拒绝", r.status === 401, r.text.slice(0, 80));

  r = await call(`/api/devices/${id}/deploy`, { method: "POST", body: "{}" });
  const token2 = r.body.token;
  check("重新生成会换掉旧凭据", token2 && token2 !== token, token2);

  r = await call(`/api/deploy/config?token=${token}`);
  check("旧凭据随即失效", r.status === 401, r.text.slice(0, 60));

  r = await call(`/api/join/peers`, { headers: { Authorization: `Bearer ${token2}`, "Content-Type": "text/plain" } });
  check("部署凭据同时能拉对端表", r.status === 200 && Array.isArray(r.body.peers), r.text.slice(0, 80));
} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
