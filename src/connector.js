import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";

const runner = { proc: null, lines: [], since: 0, bin: "", token: "", manualStop: false, restarts: 0 };

function push(line) {
  runner.lines.push(line);
  if (runner.lines.length > 150) runner.lines.shift();
}

/** 找一个能跑的 cloudflared：内置 → /data/bin → 现场按架构下载 */
export async function resolveCloudflared() {
  for (const c of ["cloudflared", "/usr/local/bin/cloudflared", "/data/bin/cloudflared"]) {
    try {
      const v = execFileSync(c, ["--version"], { timeout: 4000 }).toString().trim();
      if (v) return { bin: c, version: v };
    } catch { /* 试下一个 */ }
  }
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  fs.mkdirSync("/data/bin", { recursive: true });
  const out = "/data/bin/cloudflared";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载 cloudflared 失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`下载的 cloudflared 太小（${buf.length} B）`);
  fs.writeFileSync(out, buf, { mode: 0o755 });
  const v = execFileSync(out, ["--version"], { timeout: 6000 }).toString().trim();
  return { bin: out, version: v };
}

export async function startConnector(token) {
  if (token) runner.token = token;
  runner.manualStop = false;
  if (runner.proc) return { running: true, reused: true };
  if (!runner.token) return { running: false, error: "没有 token" };
  token = runner.token;
  const { bin, version } = await resolveCloudflared();
  runner.bin = bin;
  push(`[bin] ${bin} · ${version}`);
  const p = spawn(bin, ["tunnel", "--no-autoupdate", "run", "--token", token], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.proc = p;
  runner.since = Date.now();
  push("[start] cloudflared 已启动");
  const onData = (d) => String(d).split("\n").map(x => x.trim()).filter(Boolean).forEach(push);
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.on("exit", (code, sig) => {
    push(`[exit] code=${code} sig=${sig || "-"}`);
    runner.proc = null;
    // 非手动停止就自动拉起来（升级、容器重启、CF 侧断连都能自愈）
    if (!runner.manualStop && runner.token && runner.restarts < 50) {
      runner.restarts += 1;
      const delay = Math.min(30000, 3000 * runner.restarts);
      push(`[supervisor] ${Math.round(delay / 1000)} 秒后重启（第 ${runner.restarts} 次）`);
      setTimeout(() => { if (!runner.manualStop && !runner.proc) startConnector().catch((e) => push("[supervisor] 重启失败：" + e.message)); }, delay).unref?.();
    }
  });
  p.on("error", (e) => { push("[error] " + e.message); runner.proc = null; });
  return { running: true, bin, version };
}

export function stopConnector() {
  runner.manualStop = true;
  runner.restarts = 0;
  if (!runner.proc) return { running: false };
  try { runner.proc.kill("SIGTERM"); } catch { /* ignore */ }
  runner.proc = null;
  push("[stop] 已停止");
  return { running: false };
}

export function connectorStatus() {
  const tail = runner.lines.slice(-40);
  return {
    running: !!runner.proc,
    since: runner.since || null,
    bin: runner.bin || "",
    connected: tail.some(l => /Registered tunnel connection/i.test(l)),
    restarts: runner.restarts,
    lines: tail,
  };
}
