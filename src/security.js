// 安全基线：登录限速、CSRF 同源校验、安全响应头、Cookie 标志
import { cfg } from "./config.js";

/** 真实客户端 IP：默认取 socket；只有显式信任反代时才读 X-Forwarded-For */
export function clientIp(req) {
  if (cfg.trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "-";
}

export function isHttps(req) {
  if (req.socket.encrypted) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

/** 简单的滑动窗口限速器：key → {n, reset} */
export function makeLimiter({ windowMs, max }) {
  const map = new Map();
  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of map) if (t > v.reset) map.delete(k);
  }, Math.max(windowMs, 30_000));
  if (sweep.unref) sweep.unref();

  return {
    /** 返回 true 表示放行 */
    hit(key) {
      const t = Date.now();
      const rec = map.get(key);
      if (!rec || t > rec.reset) {
        map.set(key, { n: 1, reset: t + windowMs });
        return true;
      }
      rec.n++;
      return rec.n <= max;
    },
    /** 剩余等待秒数 */
    retryAfter(key) {
      const rec = map.get(key);
      if (!rec) return 0;
      return Math.max(0, Math.ceil((rec.reset - Date.now()) / 1000));
    },
  };
}

/** 同源校验：拦住跨站表单/脚本发起的写操作（CSRF） */
export function sameOriginOk(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;

  // 节点/脚本调用不带 Origin，用 Bearer 或一次性凭据鉴权，走单独判断
  if (!origin && !referer) return true;

  const pick = (v) => {
    try { return new URL(v).host; } catch { return ""; }
  };
  const h = origin ? pick(origin) : pick(referer);
  if (!h) return false;
  return h === host;
}

/** "1.2.3.0/24,10.0.0.5" 形式的白名单判断（IPv4 CIDR + 精确匹配） */
export function inAllowList(ip, spec) {
  const list = String(spec || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!list.length) return true;
  const bare = String(ip || "").replace(/^::ffff:/, "");
  const toInt = (s) => {
    const p = s.split(".").map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  };
  const target = toInt(bare);
  for (const item of list) {
    if (item === bare) return true;
    if (!item.includes("/")) continue;
    const [net, bitsRaw] = item.split("/");
    const bits = Number(bitsRaw);
    const base = toInt(net);
    if (target === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((target & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(res, req) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isHttps(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}
