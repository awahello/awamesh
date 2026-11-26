// 安全与角色自测：node scripts/security-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awamesh-sec-"));
const port = 19000 + Math.floor(Math.random() * 500);
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
  return { status: res.status, body, text, headers: res.headers };
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    await sleep(200);
  }

  let r = await call("/api/health");
  check("安全响应头：CSP", /default-src 'self'/.test(r.headers.get("content-security-policy") || ""), r.headers.get("content-security-policy"));
  check("安全响应头：禁止被 iframe", (r.headers.get("x-frame-options") || "") === "DENY", r.headers.get("x-frame-options"));
  check("安全响应头：nosniff", (r.headers.get("x-content-type-options") || "") === "nosniff");

  const cred = fs.readFileSync(path.join(dir, "initial-admin.txt"), "utf8").split("\n")[1].trim();
  r = await call("/api/login", { method: "POST", body: JSON.stringify({ secret: cred }) });
  check("登录成功", r.status === 200, r.status);
  const setCookie = r.headers.get("set-cookie") || "";
  check("会话 Cookie 带 HttpOnly + SameSite=Strict", /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);

  r = await call("/api/devices", { method: "POST", body: JSON.stringify({ name: "sec-node" }), headers: { Origin: "http://evil.example" } });
  check("跨站写请求被拒（CSRF）", r.status === 403, r.status + " " + r.text.slice(0, 60));

  r = await call("/api/devices", { method: "POST", body: JSON.stringify({ name: "sec-node" }) });
  check("同源写请求正常", r.status === 200, r.text.slice(0, 80));
  const id = r.body.id;

  r = await call(`/api/devices/${id}/roles`, { method: "POST", body: JSON.stringify({ roles: ["gateway", "relay"], routes: "192.168.1.0/24" }) });
  check("设置角色 + 发布网段", r.status === 200 && r.body.roles.includes("gateway") && r.body.routes[0] === "192.168.1.0/24", r.text.slice(0, 120));

  r = await call(`/api/devices/${id}/roles`, { method: "POST", body: JSON.stringify({ roles: [], routes: "not-a-cidr" }) });
  check("非法网段被丢弃、节点角色兜底保留", r.status === 200 && r.body.roles.includes("node") && r.body.routes.length === 0, r.text.slice(0, 120));

  r = await call(`/api/devices/${id}/roles`, { method: "POST", body: JSON.stringify({ roles: ["gateway"], routes: "192.168.1.0/24" }) });
  r = await call(`/api/devices/${id}/deploy`, { method: "POST", body: "{}" });
  const token = r.body.token;
  r = await call(`/api/join/state?format=shell`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" } });
  check("节点能拉到自身角色与 forward 开关", /SELF 10\.88\.0\.\d+ node,gateway/.test(r.text) && /FLAG forward 1/.test(r.text), r.text.slice(0, 160));

  r = await call(`/api/devices/${id}/publish`, { method: "POST", body: JSON.stringify({ hostname: "nas.example.com", port: 8080 }) });
  check("发布到 CF 隧道：后端指向 mesh 地址", r.status === 200 && /service: http:\/\/10\.88\.0\.\d+:8080/.test(r.body.ingress), r.text.slice(0, 160));

  r = await call(`/api/devices/${id}/publish`, { method: "POST", body: JSON.stringify({ hostname: "bad", port: 99999 }) });
  check("发布参数校验", r.status >= 400, r.status);

  r = await call("/api/ts/profile");
  check("兜底通道默认未配置", r.status === 200 && r.body.enabled === false, r.text.slice(0, 80));
  r = await call("/api/ts/profile", { method: "POST", body: JSON.stringify({ authkey: "not-a-key" }) });
  check("错误 authkey 被拒", r.status >= 400, r.status);

  r = await call("/api/security/credential", { method: "POST", body: JSON.stringify({ old: "wrong-" + Date.now(), next: "abcdefghijkl" }) });
  check("改口令需校验旧口令", r.status === 401, r.status);

  r = await call("/api/security/credential", { method: "POST", body: JSON.stringify({ old: cred, next: "abcdefghijkl" }) });
  check("改口令成功", r.status === 200, r.text.slice(0, 80));

  r = await call("/api/devices");
  check("改口令后旧会话立即失效", r.status === 401, r.status);

  for (let i = 0; i < 6; i++) {
    await call("/api/login", { method: "POST", body: JSON.stringify({ secret: "bad-" + i }) });
  }
  r = await call("/api/login", { method: "POST", body: JSON.stringify({ secret: cred }) });
  check("连续失败后登录被限速", r.status === 429, r.status + " " + r.text.slice(0, 60));
} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
