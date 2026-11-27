import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";

/* ================= frpc（反向接入：控制台主动连到有公网的 frps） ================= */

const FRPC_DIR = "/data/frpc";
const FRPC_CONF = `${FRPC_DIR}/frpc.toml`;
const frpc = { proc: null, lines: [], since: 0, cfg: null };

function fpush(line) {
  frpc.lines.push(line);
  if (frpc.lines.length > 120) frpc.lines.shift();
}

export function frpcConfig() {
  if (frpc.cfg) return frpc.cfg;
  try {
    const raw = fs.readFileSync(FRPC_CONF, "utf8");
    frpc.cfg = {
      serverAddr: (/serverAddr\s*=\s*"([^"]*)"/.exec(raw) || [])[1] || "",
      serverPort: Number((/serverPort\s*=\s*(\d+)/.exec(raw) || [])[1] || 7000),
      token: (/auth\.token\s*=\s*"([^"]*)"/.exec(raw) || [])[1] || "",
      wgPort: Number((/name = "awamesh-wg"[\s\S]*?remotePort = (\d+)/.exec(raw) || [])[1] || 51820),
      panelPort: Number((/name = "awamesh-panel"[\s\S]*?remotePort = (\d+)/.exec(raw) || [])[1] || 18443),
    };
  } catch {
    frpc.cfg = { serverAddr: "", serverPort: 7000, token: "", wgPort: 51820, panelPort: 18443 };
  }
  return frpc.cfg;
}

function writeFrpc(c) {
  fs.mkdirSync(FRPC_DIR, { recursive: true });
  const toml = [
    `serverAddr = "${c.serverAddr}"`,
    `serverPort = ${c.serverPort}`,
    `auth.token = "${c.token}"`,
    `log.to = "console"`,
    `log.level = "info"`,
    "",
    `[[proxies]]`,
    `name = "awamesh-wg"`,
    `type = "udp"`,
    `localIP = "127.0.0.1"`,
    `localPort = 51820`,
    `remotePort = ${c.wgPort}`,
    "",
    `[[proxies]]`,
    `name = "awamesh-panel"`,
    `type = "tcp"`,
    `localIP = "127.0.0.1"`,
    `localPort = 18443`,
    `remotePort = ${c.panelPort}`,
    "",
  ].join("\n");
  fs.writeFileSync(FRPC_CONF, toml, { mode: 0o600 });
  frpc.cfg = c;
}

async function frpcBin() {
  for (const c of ["frpc", "/usr/local/bin/frpc", "/data/bin/frpc"]) {
    try {
      const v = execFileSync(c, ["--version"], { timeout: 4000 }).toString().trim();
      if (v) return { bin: c, version: v };
    } catch { /* next */ }
  }
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const ver = "0.61.1";
  const url = `https://github.com/fatedier/frp/releases/download/v${ver}/frp_${ver}_linux_${arch}.tar.gz`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载 frp 失败：HTTP ${r.status}`);
  fs.writeFileSync("/tmp/frp-dl.tgz", Buffer.from(await r.arrayBuffer()));
  fs.mkdirSync("/data/bin", { recursive: true });
  execFileSync("tar", ["-xzf", "/tmp/frp-dl.tgz", "-C", "/tmp"], { timeout: 15000 });
  const dir = fs.readdirSync("/tmp").find((d) => d.startsWith("frp_") && fs.statSync(`/tmp/${d}`).isDirectory());
  if (!dir) throw new Error("解包 frp 失败");
  fs.copyFileSync(`/tmp/${dir}/frpc`, "/data/bin/frpc");
  fs.chmodSync("/data/bin/frpc", 0o755);
  return { bin: "/data/bin/frpc", version: execFileSync("/data/bin/frpc", ["--version"], { timeout: 5000 }).toString().trim() };
}

export async function startFrpc(opts) {
  if (frpc.proc) return { running: true, reused: true };
  const cfg = { ...frpcConfig(), ...(opts || {}) };
  if (!cfg.serverAddr) throw new Error("填远端 frps 的地址");
  if (!cfg.token) throw new Error("填远端 frps 的 token");
  writeFrpc(cfg);

  const { bin, version } = await frpcBin();
  fpush(`[bin] ${bin} · ${version}`);
  const p = spawn(bin, ["-c", FRPC_CONF], { stdio: ["ignore", "pipe", "pipe"] });
  frpc.proc = p;
  frpc.since = Date.now();
  fpush(`[start] frpc → ${cfg.serverAddr}:${cfg.serverPort}`);
  const onData = (d) => String(d).split("\n").map((x) => x.trim()).filter(Boolean).forEach(fpush);
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.on("exit", (code, sig) => { fpush(`[exit] code=${code} sig=${sig || "-"}`); frpc.proc = null; });
  p.on("error", (e) => { fpush("[error] " + e.message); frpc.proc = null; });
  return { running: true, ...cfg };
}

export function stopFrpc() {
  if (!frpc.proc) return { running: false };
  try { frpc.proc.kill("SIGTERM"); } catch { /* ignore */ }
  frpc.proc = null;
  fpush("[stop] 已停止");
  return { running: false };
}

export function frpcStatus() {
  const c = frpcConfig();
  return {
    running: !!frpc.proc,
    since: frpc.since || null,
    serverAddr: c.serverAddr,
    serverPort: c.serverPort,
    wgPort: c.wgPort,
    panelPort: c.panelPort,
    tokenSet: !!c.token,
    lines: frpc.lines.slice(-30),
  };
}

/* ================= tailscaled（控制台自己也上 tailnet） ================= */

const TS_DIR = "/data/tailscale";
const TS_SOCK = `${TS_DIR}/tailscaled.sock`;
const ts = { proc: null, lines: [], since: 0, ip: "" };

function tpush(line) {
  ts.lines.push(line);
  if (ts.lines.length > 120) ts.lines.shift();
}

function tsCli(args) {
  return execFileSync("tailscale", [`--socket=${TS_SOCK}`, ...args], { timeout: 8000 }).toString().trim();
}

export function startTailscaled() {
  if (ts.proc) return { running: true };
  fs.mkdirSync(TS_DIR, { recursive: true });
  const p = spawn(
    "tailscaled",
    [`--state=${TS_DIR}/tailscaled.state`, `--socket=${TS_SOCK}`, "--tun=tailscale0", "--port=41641"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  ts.proc = p;
  ts.since = Date.now();
  tpush("[start] tailscaled 已启动");
  const onData = (d) => String(d).split("\n").map((x) => x.trim()).filter(Boolean).forEach(tpush);
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.on("exit", (code) => { tpush(`[exit] code=${code}`); ts.proc = null; });
  p.on("error", (e) => { tpush("[error] " + e.message); ts.proc = null; });
  return { running: true };
}

export function tailscaleUp(authkey, hostname = "awamesh-console", loginServer = "") {
  const args = ["up", `--authkey=${authkey}`, `--hostname=${hostname}`, "--accept-routes", "--reset"];
  if (loginServer) args.push(`--login-server=${loginServer}`);
  const out = tsCli(args);
  try { ts.ip = tsCli(["ip", "-4"]).split("\n")[0] || ""; } catch { ts.ip = ""; }
  tpush(`[up] ${out || "ok"}${ts.ip ? " · " + ts.ip : ""}`);
  return { ok: true, ip: ts.ip };
}

export function tailscaleStatus() {
  let state = "stopped";
  let ip = ts.ip;
  try {
    const s = JSON.parse(tsCli(["status", "--json"]));
    state = s.BackendState || "unknown";
    ip = (s.Self && s.Self.TailscaleIPs && s.Self.TailscaleIPs[0]) || ip;
    ts.ip = ip;
  } catch { /* 未运行 */ }
  return { running: !!ts.proc, state, ip: ip || "", since: ts.since || null, lines: ts.lines.slice(-30) };
}

export function stopTailscaled() {
  try { tsCli(["down"]); } catch { /* ignore */ }
  if (ts.proc) { try { ts.proc.kill("SIGTERM"); } catch { /* ignore */ } }
  ts.proc = null;
  tpush("[stop] 已停止");
  return { running: false };
}
