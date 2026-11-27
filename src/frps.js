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

function resolveBin() {
  for (const c of ["frps", "/usr/local/bin/frps", "/data/bin/frps"]) {
    try {
      const v = execFileSync(c, ["--version"], { timeout: 4000 }).toString().trim();
      if (v) return { bin: c, version: v };
    } catch { /* next */ }
  }
  throw new Error("镜像里没有 frps（旧镜像？升级到 0.9.1+）");
}

export function startFrps(opts) {
  if (state.proc) return { running: true, reused: true };
  const cfg = { ...frpsConfig(), ...(opts || {}) };
  if (!cfg.token) cfg.token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  writeConfig(cfg);

  const { bin, version } = resolveBin();
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
