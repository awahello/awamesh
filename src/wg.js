import crypto from "node:crypto";

/** 生成 WireGuard 密钥对（Curve25519，clamp 后 base64） */
export function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const priv = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32));
  priv[0] &= 248;
  priv[31] = (priv[31] & 127) | 64;
  const pub = Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  return { privateKey: priv.toString("base64"), publicKey: pub.toString("base64") };
}

/** 从 CIDR 里取第 n 个可用地址（跳过网络号） */
export function hostInCidr(cidr, n) {
  const [base, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw || 24);
  const octets = base.split(".").map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error("网段格式不正确：" + cidr);
  }
  const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const hostBits = 32 - bits;
  const size = hostBits > 0 ? 2 ** hostBits : 1;
  const ipInt = (baseInt + n) >>> 0;
  if (n >= size - 1) throw new Error("网段已用满：" + cidr);
  return [24, 16, 8, 0].map((shift, i) => (ipInt >>> shift) & 255).join(".");
}

export function clientConfig({ privateKey, address, serverPubKey, endpoint, subnet, mtu, dns, keepalive = 25, extraRoutes = [] }) {
  const allowed = [subnet, ...extraRoutes].filter(Boolean).join(", ");
  return `[Interface]
PrivateKey = ${privateKey}
Address = ${address}
${dns ? `DNS = ${dns}\n` : ""}MTU = ${mtu}

[Peer]
PublicKey = ${serverPubKey}
Endpoint = ${endpoint}
AllowedIPs = ${allowed}
PersistentKeepalive = ${keepalive}
`;
}

export function serverPeerBlock({ publicKey, address, name, comment }) {
  return `${comment ? "# " + comment + "\n" : ""}[Peer]
# ${name}
PublicKey = ${publicKey}
AllowedIPs = ${address}/32
`;
}

/** OpenWrt 的 UCI 写法（贴到 /etc/config/network 后再 wg 接口里加一个 peer） */
export function openwrtPeerSnippet({ publicKey, address, name }) {
  return `# OpenWrt：/etc/config/network 里对应的 config wireguard_<iface> 段追加
config wireguard_awa
	option description '${name}'
	option public_key '${publicKey}'
	option persistent_keepalive '25'
	list allowed_ips '${address}/32'
`;
}

/**
 * 解析 `wg show` 输出，返回 [{ publicKey, endpoint, allowedIps, handshakeAgo, rx, tx }]
 * 兼容 `wg show` 与 `wg show wg0` 两种，以及中文/英文标签。
 */
export function parseWgShow(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const peer = line.match(/^peer:\s*(\S+)/i);
    if (peer) {
      cur = { publicKey: peer[1], endpoint: null, allowedIps: [], handshakeAgo: null, rx: 0, tx: 0 };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    let m = line.match(/^endpoint:\s*(\S+)/i);
    if (m) { cur.endpoint = m[1]; continue; }
    m = line.match(/^(?:allowed ips|允许的 ips|允许的ip):\s*(.+)$/i);
    if (m) { cur.allowedIps = m[1].split(",").map(s => s.trim()).filter(Boolean); continue; }
    m = line.match(/^(?:latest handshake|最近一次握手):\s*(.+)$/i);
    if (m) { cur.handshakeAgo = parseAgo(m[1]); continue; }
    m = line.match(/^(?:transfer|传输):\s*(.+)$/i);
    if (m) {
      const nums = [...m[1].matchAll(/([\d.]+)\s*([KMG]?i?B)/gi)];
      if (nums[0]) cur.rx = toBytes(nums[0][1], nums[0][2]);
      if (nums[1]) cur.tx = toBytes(nums[1][1], nums[1][2]);
      continue;
    }
  }
  return out;
}

function toBytes(num, unit) {
  const n = Number(num);
  const u = String(unit).toUpperCase();
  const mult = u.startsWith("K") ? 1024 : u.startsWith("M") ? 1024 ** 2 : u.startsWith("G") ? 1024 ** 3 : 1;
  return Math.round(n * mult);
}

/** "1 minute, 5 seconds ago" / "2 hours ago" / "从未" → 秒 */
function parseAgo(text) {
  const s = String(text);
  if (/never|从未|无/i.test(s)) return null;
  let total = 0;
  const units = { second: 1, seconds: 1, minute: 60, minutes: 60, hour: 3600, hours: 3600, day: 86400, days: 86400, 秒: 1, 分钟: 60, 小时: 3600, 天: 86400 };
  for (const m of s.matchAll(/(\d+)\s*([a-zA-Z\u4e00-\u9fa5]+)/g)) {
    const unit = units[m[2].toLowerCase()] ?? units[m[2]] ?? 0;
    total += Number(m[1]) * unit;
  }
  return total || 0;
}
