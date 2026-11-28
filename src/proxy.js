import http from "node:http";
import https from "node:https";
import net from "node:net";
import { db } from "./db.js";

/* 聚合入口：把多个源站（可跨设备、可经网关）聚合成一个域名，按负载/主备转发 */

const state = { rr: new Map(), health: new Map(), server: null, port: 0 };

export function parseTargets(json) {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function listSites() {
  return db.prepare("SELECT * FROM sites ORDER BY created_at DESC").all().map(s => ({
    ...s,
    targets: parseTargets(s.targets),
  }));
}

/** 目标列表里挑一个：lb=轮询，standby=第一个健康的 */
export function pickTarget(site) {
  const list = site.targets || [];
  if (!list.length) return null;
  if (site.mode === "standby") {
    const hit = list.find(t => state.health.get(`${site.id}|${t}`) !== false);
    return hit || list[0];
  }
  const i = (state.rr.get(site.id) || 0) % list.length;
  state.rr.set(site.id, i + 1);
  return list[i];
}

function proxyOnce(req, res, target, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target.startsWith("http") ? target : `http://${target}`); }
    catch { return resolve(false); }

    const lib = u.protocol === "https:" ? https : http;
    const headers = { ...req.headers, host: u.host };
    delete headers["content-length"];

    const preq = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")) + req.url,
      method: req.method,
      headers,
      timeout: 15000,
    }, (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
      resolve(true);
    });

    preq.on("timeout", () => { preq.destroy(); resolve(false); });
    preq.on("error", () => resolve(false));
    if (body && body.length) preq.write(body);
    preq.end();
  });
}

async function handler(req, res) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const sites = listSites();
  const site = sites.find(s => s.hostname === host) || sites.find(s => s.hostname === "*");
  if (!site) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`awamesh 聚合入口：没有为 ${host || "(无 Host)"} 配置源站\n`);
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  // 最多试 2 个目标：主挂了自动换下一个
  for (let i = 0; i < Math.min(2, site.targets.length); i++) {
    const t = pickTarget(site);
    if (!t) break;
    const ok = await proxyOnce(req, res, t, body);
    if (ok) return;
    state.health.set(`${site.id}|${t}`, false);
  }
  res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`awamesh 聚合入口：${site.hostname} 的所有源站都不可达\n`);
}

export function startProxy(port) {
  if (state.server) return state.server;
  if (!port) return null;
  state.port = port;
  state.server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      try { res.writeHead(502); res.end("bad gateway"); } catch { /* ignore */ }
    });
  });
  state.server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
  state.server.listen(port, "0.0.0.0", () => {});
  return state.server;
}

export function proxyStatus() {
  return { running: !!state.server, port: state.port, sites: listSites().length };
}

/** TCP 探活所有源站，结果记在内存里（主备切换用） */
export function probeSites() {
  const sites = listSites();
  const out = [];
  let pending = 0;

  const check = (site, target) => new Promise((resolve) => {
    let u;
    try { u = new URL(target.startsWith("http") ? target : `http://${target}`); }
    catch { return resolve(false); }
    const sock = new net.Socket();
    let done = false;
    const fin = (ok) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      state.health.set(`${site.id}|${target}`, ok);
      out.push({ site: site.hostname, target, ok });
      resolve(ok);
    };
    sock.setTimeout(2500);
    sock.once("connect", () => fin(true));
    sock.once("timeout", () => fin(false));
    sock.once("error", () => fin(false));
    sock.connect(Number(u.port || (u.protocol === "https:" ? 443 : 80)), u.hostname);
  });

  return Promise.all(sites.flatMap(s => s.targets.map(t => { pending++; return check(s, t); })))
    .then(() => ({ checked: pending, results: out, health: Object.fromEntries(state.health) }));
}
