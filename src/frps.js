import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";

const CONF_DIR = "/data/frp";
const CONF = `${CONF_DIR}/frps.toml`;
const state = { proc: null, lines: [], since: 0, cfg: null };

function push(line) {
  state.lines.push(line);
  if (state.lines.length > 150) state.lines.shift();
}

export function frpsConfig() {
  if (state.cfg) return state.cfg;
  try {
    const raw = fs.readFileSync(CONF, "utf8");
    const port = Number((/bindPort\s*=\s*(\d+)/.exec(raw) || [])[1] || 7000);
    const token = (/auth\.token\s*=\s*"([^"]*)"/.exec(raw) || [])[1] || "";
    const range = (/start\s*=\s*(\d+),\s*end\s*=\s*(\d+)/.exec(raw) || []);
    state.cfg = { port, token, rangeStart: Number(range[1] || 51820), rangeEnd: Number(range[2] || 51900) };
    return state.cfg;
  } catch {
    state.cfg = { port: 7000, token: "", rangeStart: 51820, rangeEnd: 51900 };
    return state.cfg;
  }
}

function writeConfig({ port, token, rangeStart, rangeEnd }) {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  const toml = [
    `bindPort = ${port}`,
    `auth.method = "token"`,
    `auth.token = "${token}"`,
    `allowPorts = [{ start = ${rangeStart}, end = ${rangeEnd} }]`,
    `log.to = "console"`,
    `log.level = "info"`,
    "",
  ].join("\n");
  fs.writeFileSync(CONF, toml, { mode: 0o600 });
  state.cfg = { port, token, rangeStart, rangeEnd };
}

async function resolveBin() {
  for (const c of ["frps", "/usr/local/bin/frps", "/data/bin/frps"]) {
    try {
      const v = execFileSync(c, ["--version"], { timeout: 4000 }).toString().trim();
      if (v) return { bin: c, version: v };
    } catch { /* next */ }
  }

  // 镜像里那个架构不对（arm64 机器上放了 amd64）→ 运行时按 process.arch 重下
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const ver = "0.61.1";
  const url = `https://github.com/fatedier/frp/releases/download/v${ver}/frp_${ver}_linux_${arch}.tar.gz`;
  const tgz = "/tmp/frp-dl.tgz";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载 frp 失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`下载的 frp 太小（${buf.length} B）`);
  fs.writeFileSync(tgz, buf);
  fs.mkdirSync("/data/bin", { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", "/tmp"], { timeout: 15000 });
  const dir = fs.readdirSync("/tmp").find(d => d.startsWith("frp_") && fs.statSync(`/tmp/${d}`).isDirectory());
  if (!dir) throw new Error("解包 frp 失败");
  fs.copyFileSync(`/tmp/${dir}/frps`, "/data/bin/frps");
  fs.chmodSync("/data/bin/frps", 0o755);
  const v = execFileSync("/data/bin/frps", ["--version"], { timeout: 5000 }).toString().trim();
  return { bin: "/data/bin/frps", version: v, downloaded: true };
}

export async function startFrps(opts) {
  if (state.proc) return { running: true, reused: true };
  const cfg = { ...frpsConfig(), ...(opts || {}) };
  if (!cfg.token) cfg.token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  writeConfig(cfg);

  const { bin, version } = await resolveBin();
  push(`[bin] ${bin} · ${version}`);
  const p = spawn(bin, ["-c", CONF], { stdio: ["ignore", "pipe", "pipe"] });
  state.proc = p;
  state.since = Date.now();
  push(`[start] frps 已启动 · bind ${cfg.port} · 允许端口 ${cfg.rangeStart}-${cfg.rangeEnd}`);
  const onData = (d) => String(d).split("\n").map(x => x.trim()).filter(Boolean).forEach(push);
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.on("exit", (code, sig) => { push(`[exit] code=${code} sig=${sig || "-"}`); state.proc = null; });
  p.on("error", (e) => { push("[error] " + e.message); state.proc = null; });
  return { running: true, port: cfg.port, rangeStart: cfg.rangeStart, rangeEnd: cfg.rangeEnd };
}

export function stopFrps() {
  if (!state.proc) return { running: false };
  try { state.proc.kill("SIGTERM"); } catch { /* ignore */ }
  state.proc = null;
  push("[stop] 已停止");
  return { running: false };
}

export function frpsStatus() {
  const cfg = frpsConfig();
  return {
    running: !!state.proc,
    since: state.since || null,
    port: cfg.port,
    tokenSet: !!cfg.token,
    rangeStart: cfg.rangeStart,
    rangeEnd: cfg.rangeEnd,
    lines: state.lines.slice(-40),
  };
}

/** 设备侧 frpc 配置模板 */
export function frpcTemplate(serverAddr, localPort = 51820, remotePort = 51820) {
  const cfg = frpsConfig();
  return [
    `serverAddr = "${serverAddr}"`,
    `serverPort = ${cfg.port}`,
    `auth.token = "${cfg.token}"`,
    "",
    `[[proxies]]`,
    `name = "awamesh-wg"`,
    `type = "udp"`,
    `localIP = "127.0.0.1"`,
    `localPort = ${localPort}`,
    `remotePort = ${remotePort}`,
    "",
  ].join("\n");
}
