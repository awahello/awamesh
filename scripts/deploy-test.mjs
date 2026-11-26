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
  r = await call("/api/wg/check");
  check("连通性自检可用", r.status === 200 && typeof r.body.managed === "boolean" && Array.isArray(r.body.hints), r.text.slice(0, 120));

  r = await call("/api/wg/profile", { method: "POST", body: JSON.stringify({ mode: "custom" }) });
  check("自定义模式缺 Endpoint 被拒", r.status >= 400, r.status + " " + r.text.slice(0, 80));

  r = await call("/api/wg/profile", { method: "POST", body: JSON.stringify({ mode: "builtin", endpoint: "" }) });
  check("自动模式保存并自动推导 Endpoint", r.status === 200 && r.body.mode === "builtin" && !!r.body.endpoint, r.text.slice(0, 140));

  r = await call("/api/update/check");
  check("升级检查接口可用", r.status === 200 && !!r.body.current && r.body.command.includes("upgrade.sh"), r.text.slice(0, 120));

  r = await call("/api/backup/export");
  check("可导出配置", r.status === 200 && r.body.app === "awamesh" && Array.isArray(r.body.devices), r.text.slice(0, 100));
  check("导出不含后端口令", r.status === 200 && !JSON.stringify(r.body.settings || {}).includes("admin_credential"), "settings 里出现了凭据字段");

  const bundle = r.body;
  r = await call("/api/backup/import", { method: "POST", body: JSON.stringify({ bundle, mode: "merge" }) });
  check("可导入（合并模式）", r.status === 200 && r.body.ok === true, r.text.slice(0, 120));

  r = await call("/api/backup/import", { method: "POST", body: JSON.stringify({ app: "other" }) });
  check("拒绝非 awamesh 备份", r.status >= 400, r.status);

  // ---- 中继：接入命令带自检凭据，删除/停用后机器自动卸载 ----
  r = await call("/api/relays", { method: "POST", body: JSON.stringify({ name: "hk-relay", region: "香港", addr: "hk.example.com", port: 18444 }) });
  check("新增中继", r.status === 200 && !!r.body.id, r.text.slice(0, 80));
  const relayId = r.body.id;

  r = await call(`/api/relays/${relayId}/command`);
  check("中继接入命令包含自检脚本", r.status === 200 && r.body.script.includes("awa-relay-check") && r.body.script.includes("/api/relay/state"), r.text.slice(0, 120));

  const relayTok = (r.body.script.match(/(rl_[a-f0-9]{16,})/) || [])[1];
  check("中继命令里带凭据", !!relayTok, String(relayTok));

  r = await call("/api/relay/state", { headers: { Authorization: `Bearer ${relayTok}`, "Content-Type": "text/plain" } });
  check("中继自检通过", r.status === 200 && r.body.ok === true, r.text.slice(0, 80));

  await call(`/api/relays/${relayId}/toggle`, { method: "POST", body: JSON.stringify({ enabled: false }) });
  r = await call("/api/relay/state", { headers: { Authorization: `Bearer ${relayTok}`, "Content-Type": "text/plain" } });
  check("停用后返回 enabled:false（机器只停容器，不卸载）", r.status === 200 && r.body.enabled === false, r.text.slice(0, 80));

  await call(`/api/relays/${relayId}/toggle`, { method: "POST", body: JSON.stringify({ enabled: true }) });
  r = await call(`/api/relays/${relayId}/delete`, { method: "POST", body: "{}" });
  check("可删除中继", r.status === 200, r.text.slice(0, 60));

  r = await call("/api/relay/state", { headers: { Authorization: `Bearer ${relayTok}`, "Content-Type": "text/plain" } });
  check("删除后才 401（机器自行卸载）", r.status === 401, r.status);

  // 反代 / Cloudflare 后面的场景：命令里必须是 https + 外部域名，且不能带容器端口
  r = await call(`/api/devices/${id}/deploy`, {
    method: "POST",
    body: "{}",
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "mesh.example.com", "CF-Ray": "test" },
  });
  check(
    "反代后生成的命令用 https 且不带端口",
    r.body.command.includes("https://mesh.example.com/dp/") && !r.body.command.includes(":18443"),
    r.body.command
  );

  r = await call("/api/settings/public-url", { method: "POST", body: JSON.stringify({ url: "https://awamesh.example.com" }) });
  check("可设置对外地址", r.status === 200, r.text.slice(0, 80));

  r = await call(`/api/devices/${id}/deploy`, { method: "POST", body: "{}" });
  check("对外地址优先生效", r.body.command.includes("https://awamesh.example.com/dp/"), r.body.command);

  await call("/api/settings/public-url", { method: "POST", body: JSON.stringify({ url: "" }) });

  r = await call(`/api/devices/${id}/deploy`, { method: "POST", body: "{}" });
  const t3 = r.body.token;

  await call(`/api/devices/${id}/revoke`, { method: "POST", body: "{}" });
  r = await call("/api/join/state?format=shell", { headers: { Authorization: `Bearer ${t3}`, "Content-Type": "text/plain" } });
  check("吊销后节点拉状态得到 401（触发自清理）", r.status === 401, r.status);

  r = await call(`/api/devices/${id}/uninstall`);
  check("可生成手动卸载命令（Linux）", r.status === 200 && r.body.shell.includes("awa-peers") && r.body.shell.includes("awa0.conf"), r.text.slice(0, 100));
  check("可生成手动卸载命令（Windows）", r.status === 200 && r.body.ps.includes("uninstalltunnelservice"), r.text.slice(0, 100));

  r = await call(`/api/devices/${id}/delete`, { method: "POST", body: "{}" });
  check("可彻底删除设备", r.status === 200, r.text.slice(0, 80));

  r = await call("/api/join/state?format=shell", { headers: { Authorization: `Bearer ${t3}`, "Content-Type": "text/plain" } });
  check("删除后凭据立即失效", r.status === 401, r.status);

} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
