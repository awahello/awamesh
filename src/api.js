import { cfg } from "./config.js";
import { db, now, setting, listRelays, listTunnels, listEvents, addEvent } from "./db.js";
import { backend } from "./backends/index.js";
import { cfEnabled, cfToken, setCfToken, cfAccount, setCfAccount, listAccounts, listTunnels as cfListTunnels, toRows } from "./cloudflare.js";
import crypto from "node:crypto";
import { wg, isManaged } from "./wgsrv.js";
import { hostInCidr } from "./wg.js";

const r = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

function overview(devices) {
  const online = devices.filter(d => d.online && !d.revoked_at);
  const relayPaths = online.filter(d => d.path === "relay");
  const directRatio = online.length ? Math.round(((online.length - relayPaths.length) / online.length) * 100) : 0;
  const relays = listRelays();
  const tunnels = listTunnels();
  const usedGb = relays.reduce((s, x) => s + (x.used_gb || 0), 0);
  const healthyTunnels = tunnels.filter(t => t.health === "ok").length;
  const avgMs = online.filter(d => d.latency_ms).reduce((s, d) => s + d.latency_ms, 0) /
    (online.filter(d => d.latency_ms).length || 1);

  return {
    devices: { total: devices.length, online: online.length, relay: relayPaths.length },
    directRatio,
    usedGb,
    tunnels: { total: tunnels.length, ok: healthyTunnels },
    avgMs: Math.round(avgMs),
    meshCidr: cfg.meshCidr,
    relays: relays.length,
    backend: backend().name,
  };
}

function groupByTag(devices) {
  const map = new Map();
  for (const d of devices) {
    const tags = d.tags.length ? d.tags : ["未分组"];
    for (const t of tags) {
      if (!map.has(t)) map.set(t, { tag: t, total: 0, online: 0 });
      const g = map.get(t);
      g.total++;
      if (d.online && !d.revoked_at) g.online++;
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}


export function allocAddress(subnet) {
  const used = new Set(db.prepare("SELECT address FROM wg_peers").all().map(r => r.address));
  for (const d of db.prepare("SELECT mesh_ip FROM devices WHERE mesh_ip IS NOT NULL AND revoked_at IS NULL").all()) {
    if (d.mesh_ip) used.add(d.mesh_ip);
  }
  for (let n = 2; n < 250; n++) {
    const ip = hostInCidr(subnet, n);
    if (!used.has(ip)) return ip;
  }
  throw new Error("网段里没有可用地址了");
}

/**
 * 节点自主加入：节点本地生成密钥，只把公钥交给控制台。
 * 控制台负责分配地址、把它加进服务端接口，并返回完整配置。
 */
export async function joinPeer(body) {
  const token = String(body?.token || "").trim();
  const publicKey = String(body?.pubkey || "").trim();
  const hostname = String(body?.hostname || "node").trim().slice(0, 40) || "node";

  if (!/^awa_[a-f0-9]{16,}$/i.test(token)) throw Object.assign(new Error("密钥格式不对"), { status: 400 });
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(publicKey)) throw Object.assign(new Error("公钥格式不对"), { status: 400 });

  const hash = crypto.createHash("SHA256").update(token).digest("hex");
  const row = db.prepare("SELECT * FROM authkeys WHERE hash = ?").get(hash);
  if (!row) throw Object.assign(new Error("密钥不存在（请重新生成）"), { status: 401 });
  if (row.used_at) throw Object.assign(new Error("该密钥已被使用"), { status: 401 });
  if (row.expires_at && row.expires_at < now()) throw Object.assign(new Error("密钥已过期"), { status: 401 });

  const pf = backend().profile?.() || {};
  const subnet = pf.subnet || cfg.meshCidr;
  const address = allocAddress(subnet);
  const id = "d_" + crypto.randomBytes(5).toString("hex");
  const t = now();

  db.prepare(`INSERT INTO devices(id,name,mesh_ip,hostname,os,client_ver,tags,roles,path,latency_ms,relay,last_seen,key_fp,created_at,demo)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(id, hostname, address, hostname, "", "", row.tag || "", "node", "", null, null, null, publicKey, t);
  db.prepare("INSERT INTO wg_peers(device_id,private_key,public_key,address,created_at) VALUES(?,?,?,?,?)")
    .run(id, "", publicKey, address, t);
  db.prepare("UPDATE authkeys SET used_at = ? WHERE id = ?").run(t, row.id);

  // 节点上报的公网 endpoint（有则记下，用于全网状直连）
  const selfEndpoint = String(body?.endpoint || "").trim().slice(0, 120);
  const wgPort = Number(body?.port || 0) || null;
  const nodeToken = "nt_" + crypto.randomBytes(16).toString("hex");
  if (selfEndpoint) {
    db.prepare("UPDATE devices SET endpoint = ?, wg_port = ? WHERE id = ?").run(selfEndpoint, wgPort, id);
  }
  db.prepare("UPDATE devices SET node_token = ? WHERE id = ?")
    .run(crypto.createHash("SHA256").update(nodeToken).digest("hex"), id);

  // Endpoint 没填时，用请求 Host 兜底推导（面板域名/IP + wg 端口）
  let endpoint = pf.endpoint || "";
  if (!endpoint && body?._host) {
    const hostOnly = String(body._host).split(":")[0];
    endpoint = `${hostOnly}:${process.env.AWA_WG_PORT || 51820}`;
  }
  if (!endpoint) throw Object.assign(new Error("控制台还没填 Endpoint（设置 → WireGuard 服务端），请先填公网地址:端口"), { status: 400 });

  let applied = false;
  if (isManaged()) {
    try {
      await wg.addPeer(publicKey, address);
      if (selfEndpoint) await wg.sh("wg", ["set", wg.iface, "peer", publicKey, "endpoint", selfEndpoint]);
      applied = true;
    } catch (e) {
      addEvent("device", `加 peer 失败（${e.message}），已下发配置，需在服务端手动补一条`, id);
    }
  }
  addEvent("device", `${hostname} 通过配置加入（${address}）${applied ? "" : " · 服务端接口未接管，需手动加 peer"}`, id);

  return {
    id, name: hostname, address,
    prefix: subnet.split("/")[1] || "24",
    serverPub: pf.serverPub || setting("wg_server_pub"),
    endpoint,
    mtu: pf.mtu || 1420,
    dns: pf.dns || "",
    allowedIps: [subnet, ...(pf.lanRoutes ? pf.lanRoutes.split(",").map(x => x.trim()).filter(Boolean) : [])].join(","),
    applied,
    nodeToken,
  };
}


/** 节点用 nodeToken 拉取全网 peer 列表，用于打全直连 */
export function peersForNode(nodeToken) {
  const hash = crypto.createHash("SHA256").update(String(nodeToken || "")).digest("hex");
  const self = db.prepare("SELECT * FROM devices d WHERE d.node_token = ?").get(hash);
  if (!self) throw Object.assign(new Error("节点凭据无效"), { status: 401 });

  const rows = db.prepare(`
    SELECT d.id, d.name, d.mesh_ip, d.endpoint, d.wg_port, p.public_key
    FROM devices d JOIN wg_peers p ON p.device_id = d.id
    WHERE d.revoked_at IS NULL`).all();

  const peers = rows
    .filter(r => r.id !== self.id)
    .map(r => ({
      name: r.name,
      address: r.mesh_ip,
      publicKey: r.public_key,
      // 有公网 endpoint 的才给直连信息，其余由 hub 兜底
      endpoint: r.endpoint ? (r.endpoint.includes(":") ? r.endpoint : `${r.endpoint}:${r.wg_port || 51820}`) : "",
    }));

  return {
    self: { name: self.name, address: self.mesh_ip, endpoint: self.endpoint || "" },
    peers,
  };
}

/** 节点每次刷新时顺带上报自己的 endpoint（公网 IP 可能变） */
export async function updateNodeEndpoint(nodeToken, endpoint, port) {
  const hash = crypto.createHash("SHA256").update(String(nodeToken || "")).digest("hex");
  const self = db.prepare("SELECT * FROM devices WHERE node_token = ?").get(hash);
  if (!self) throw Object.assign(new Error("节点凭据无效"), { status: 401 });
  const ep = String(endpoint || "").trim().slice(0, 120);
  if (!ep) return { ok: true, changed: false };
  db.prepare("UPDATE devices SET endpoint = ?, wg_port = ? WHERE id = ?").run(ep, Number(port) || null, self.id);
  if (isManaged()) {
    const peer = db.prepare("SELECT public_key FROM wg_peers WHERE device_id = ?").get(self.id);
    if (peer?.public_key) await wg.setEndpoint(peer.public_key, ep.includes(":") ? ep : `${ep}:${Number(port) || 51820}`);
  }
  return { ok: true, changed: self.endpoint !== ep };
}

/** 生成中继机的部署脚本：优先 Docker，其次 Go 安装；交互式 shell 里失败不会退出会话 */
function relayScript(relay, cfg) {
  const port = relay.port || cfg.relayPort;
  return `#!/bin/sh
# awamesh 中继节点部署（${relay.region}）
# 建议在「有公网 IP 的 Linux VPS」上执行；路由器（OpenWrt）内存与工具链都不适合跑 derper
set -u

PORT=${port}
HOSTNAME_ARG="${relay.addr}"

die() {
  echo "✗ $*" >&2
  if [ -t 0 ]; then
    echo "" >&2
    echo "（当前是交互式 shell：脚本已中止，会话保持，不会断开）" >&2
    kill -INT $$ 2>/dev/null || true
    return 1 2>/dev/null || true
  fi
  exit 1
}

echo "==> 目标：$HOSTNAME_ARG:$PORT"

# 无公网地址的机器当不了中继
case "$HOSTNAME_ARG" in
  10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*)
    die "这个地址是内网地址，中继必须用公网 IP 或解析到公网的域名" ;;
esac

if ! command -v docker >/dev/null 2>&1 && ! command -v go >/dev/null 2>&1; then
  die "这台机器既没有 docker 也没有 go。请换一台 Linux VPS，或先装 docker"
fi

if command -v docker >/dev/null 2>&1; then
  echo "==> 用 Docker 运行 derper（无需安装 Go）"
  docker rm -f awamesh-derp >/dev/null 2>&1 || true
  docker run -d --name awamesh-derp --restart unless-stopped \
    -p "$PORT:$PORT" -p "$PORT:$PORT/udp" \
    --entrypoint derper \
    ghcr.io/awahello/awamesh-relay:latest \
    -a ":$PORT" -stun -hostname "$HOSTNAME_ARG" || die "docker 启动失败，检查端口占用与镜像拉取"
else
  echo "==> 没有 docker，改用 Go 安装 derper"
  command -v go >/dev/null 2>&1 || die "没有 go，请先装 Go 1.22+ 或 docker"
  go install tailscale.com/cmd/derper@latest || die "go install 失败（网络或 Go 版本问题）"
  cp "$(go env GOPATH)/bin/derper" /usr/local/bin/derper || die "拷贝 derper 失败（需要 root）"

  cat >/etc/systemd/system/derper.service <<EOF
[Unit]
Description=awamesh DERP relay
After=network-online.target
[Service]
ExecStart=/usr/local/bin/derper -a :$PORT -stun -hostname=$HOSTNAME_ARG
Restart=always
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now derper || die "systemd 启动失败"
fi

sleep 2
echo
echo "==> 自检"
if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "    ✓ 本地 $PORT 可达"
else
  echo "    ! 本地 $PORT 未响应：可能还在起，或端口被占用"
fi
echo "    下一步：回面板中继页点「刷新」，状态应为在线；再点「中继地图」导出配置"
echo "    别忘了云厂商安全组放行 TCP/UDP $PORT"
`;
}

export async function api(req, res, url, body) {
  const be = backend();
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  if (url.pathname === "/api/health") return { ok: true, version: cfg.version };

  if (url.pathname === "/api/overview") {
    const devices = await be.devices();
    return {
      ...overview(devices),
      groups: groupByTag(devices),
      events: listEvents(8),
      relaysList: listRelays(),
      tunnelsList: listTunnels(),
    };
  }

  if (url.pathname === "/api/devices" && method === "GET") {
    const devices = await be.devices();
    const filter = url.searchParams.get("filter") || "all";
    let list = devices;
    if (filter === "online") list = devices.filter(d => d.online && !d.revoked_at);
    if (filter === "relay") list = devices.filter(d => d.path === "relay");
    if (filter === "offline") list = devices.filter(d => !d.online && !d.revoked_at);
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q) list = list.filter(d => (d.name + d.hostname + d.mesh_ip).toLowerCase().includes(q));
    return {
      total: devices.length,
      online: devices.filter(d => d.online && !d.revoked_at).length,
      relay: devices.filter(d => d.path === "relay").length,
      devices: list,
      groups: groupByTag(devices),
    };
  }


  if (url.pathname === "/api/devices" && method === "POST") {
    if (typeof be.create !== "function") throw new Error("当前后端不支持直接创建设备（mock 请改用演示数据，或切 AWA_BACKEND=wg）");
    const r = await be.create(body?.name);
    return r;
  }

  if (url.pathname === "/api/wg/profile" && method === "GET") {
    if (typeof be.profile !== "function") throw new Error("当前后端不是 wg");
    const { serverPriv, ...rest } = be.profile();
    return { ...rest, managed: isManaged() };
  }

  if (url.pathname === "/api/wg/profile" && method === "POST") {
    if (typeof be.profile !== "function") throw new Error("当前后端不是 wg");
    if (body?.endpoint !== undefined) setting("wg_endpoint", String(body.endpoint).trim());
    if (body?.subnet) setting("wg_subnet", String(body.subnet).trim());
    if (body?.mtu) setting("wg_mtu", String(body.mtu));
    if (body?.dns !== undefined) setting("wg_dns", String(body.dns).trim());
    if (body?.lanRoutes !== undefined) setting("wg_lan_routes", String(body.lanRoutes).trim());
    if (body?.serverPub) {
      const pub = String(body.serverPub).trim();
      if (!/^[A-Za-z0-9+/]{43}=?$/.test(pub)) throw new Error("服务端公钥格式不对（应为 44 字符 base64）");
      setting("wg_server_pub", pub.endsWith("=") ? pub : pub + "=");
    }
    if (body?.regen) {
      const { genKeypair } = await import("./wg.js");
      const kp = genKeypair();
      setting("wg_server_priv", kp.privateKey);
      setting("wg_server_pub", kp.publicKey);
      addEvent("settings", "已重新生成服务端密钥（需同步更新 WireGuard 服务端配置）");
    } else {
      addEvent("settings", "WireGuard 服务端参数已更新");
    }
    if (typeof globalThis.__awaWgRetry === "function") {
      try { await globalThis.__awaWgRetry(); } catch (e) { addEvent("settings", "重试接管 WireGuard 失败：" + e.message); }
    }
    const { serverPriv, ...rest } = be.profile();
    return { ...rest, managed: isManaged() };
  }

  if (url.pathname === "/api/wg/sync" && method === "POST") {
    if (typeof be.sync !== "function") throw new Error("当前后端不是 wg");
    if (!body?.text) throw new Error("请粘贴 wg show 的输出");
    return be.sync(body.text);
  }


  if (seg[0] === "devices" && seg[2] === "config" && method === "GET") {
    const peer = db.prepare("SELECT * FROM wg_peers WHERE device_id = ?").get(seg[1]);
    if (!peer) throw new Error("该设备没有配置记录");
    if (!peer.private_key) {
      throw new Error("这台是节点自助加入的，私钥只存在于节点本机（这是设计如此）");
    }
    const pf = be.profile?.() || {};
    const { clientConfig } = await import("./wg.js");
    return {
      clientConfig: clientConfig({
        privateKey: peer.private_key,
        address: `${peer.address}/${(pf.subnet || cfg.meshCidr).split("/")[1] || 24}`,
        serverPubKey: pf.serverPub,
        endpoint: pf.endpoint || "",
        subnet: pf.subnet || cfg.meshCidr,
        mtu: pf.mtu || 1420,
        dns: pf.dns || "",
        extraRoutes: pf.lanRoutes ? pf.lanRoutes.split(",").map(x => x.trim()).filter(Boolean) : [],
      }),
    };
  }

  if (seg[0] === "devices" && seg[2] === "rename" && method === "POST") {
    await be.rename(seg[1], body?.name);
    return { ok: true };
  }

  if (seg[0] === "devices" && seg[2] === "revoke" && method === "POST") {
    await be.revoke(seg[1]);
    return { ok: true };
  }

  if (url.pathname === "/api/relays" && method === "GET") {
    return { relays: listRelays(), relayPort: cfg.relayPort };
  }

  if (seg[0] === "relays" && seg[2] === "toggle" && method === "POST") {
    const row = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("中继不存在");
    const enabled = body?.enabled ? 1 : 0;
    db.prepare("UPDATE relays SET enabled = ? WHERE id = ?").run(enabled, seg[1]);
    addEvent("relay", `${row.name} ${enabled ? "已启用" : "已从地图摘除"}`);
    if (enabled && typeof globalThis.__awaProbeRelays === "function") {
      globalThis.__awaProbeRelays().catch(() => {});
    }
    return { ok: true };
  }

  if (seg[0] === "relays" && seg[2] === "visibility" && method === "POST") {
    const row = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("中继不存在");
    const vis = body?.visibility === "private" ? "private" : "public";
    db.prepare("UPDATE relays SET visibility = ? WHERE id = ?").run(vis, seg[1]);
    addEvent("relay", `${row.name} 可见性改为${vis === "private" ? "仅内网" : "公网"}`);
    return { ok: true };
  }

  if (url.pathname === "/api/tunnels" && method === "GET") {
    return { tunnels: listTunnels(), cfEnabled: !!cfg.cfToken };
  }



  if (url.pathname === "/api/cf/profile" && method === "GET") {
    return {
      enabled: cfEnabled(),
      tokenSet: !!cfToken(),
      tokenHint: cfToken() ? cfToken().slice(0, 4) + "…" + cfToken().slice(-4) : "",
      account: cfAccount(),
    };
  }

  if (url.pathname === "/api/cf/profile" && method === "POST") {
    if (body?.token !== undefined) {
      const t = String(body.token).trim();
      if (t && !/^[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error("Token 看起来不对（应是一串不含空格的字符）");
      setCfToken(t);
      addEvent("settings", t ? "Cloudflare Token 已更新" : "Cloudflare Token 已清除");
    }
    if (body?.account !== undefined) setCfAccount(String(body.account).trim());
    return { ok: true, enabled: cfEnabled(), account: cfAccount() };
  }

  if (url.pathname === "/api/cf/test" && method === "POST") {
    if (!cfEnabled()) throw new Error("还没填 Token");
    const accounts = await listAccounts();
    if (accounts[0] && !cfAccount()) setCfAccount(accounts[0].id);
    addEvent("settings", `Cloudflare 连接正常（${accounts.length} 个账户）`);
    return { ok: true, accounts: accounts.map(a => ({ id: a.id, name: a.name })) };
  }

  if (url.pathname === "/api/tunnels/sync" && method === "POST") {
    if (!cfEnabled()) throw Object.assign(new Error("未配置 AWA_CF_TOKEN，无法从 Cloudflare 同步"), { status: 400 });
    const accounts = await listAccounts();
    const accountId = body?.account || url.searchParams.get("account") || cfAccount() || accounts[0]?.id;
    if (!accountId) throw new Error("没有可用的 Cloudflare 账户（Token 需要 Account:Read）");
    const items = await cfListTunnels(accountId);
    const n = toRows(items, db);
    addEvent("tunnel", `从 Cloudflare 同步 ${n} 条 ingress 记录`);
    return { ok: true, accountId, count: n };
  }

  if (url.pathname === "/api/relays/map" && method === "GET") {
    const list = listRelays().filter(r => r.enabled);
    const lines = ["regions:"];
    list.forEach((r, i) => {
      const id = 900 + i;
      lines.push(`  ${id}:`);
      lines.push(`    regionid: ${id}`);
      lines.push(`    regioncode: ${r.region_code || "r" + id}`);
      lines.push(`    regionname: ${r.region}`);
      lines.push(`    nodes:`);
      lines.push(`      - name: ${id}a`);
      lines.push(`        regionid: ${id}`);
      lines.push(`        hostname: ${r.addr}`);
      lines.push(`        derpport: ${r.port}`);
      lines.push(`        stunonly: false`);
    });
    return { yaml: lines.join("\n") + "\n", count: list.length };
  }

  if (seg[0] === "relays" && seg[2] === "command" && method === "GET") {
    const r = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!r) throw new Error("中继不存在");
    return { script: relayScript(r, cfg), relay: r };
  }


  if (url.pathname === "/api/relays" && method === "POST") {
    const name = String(body?.name || "").trim().slice(0, 40);
    const region = String(body?.region || "").trim().slice(0, 20) || "自定义";
    const addr = String(body?.addr || "").trim();
    const port = Number(body?.port || cfg.relayPort);
    if (!name) throw new Error("中继名称不能为空");
    if (!addr || /\s/.test(addr)) throw new Error("地址不能为空且不能含空格");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口范围 1-65535");
    const id = "r_" + Math.random().toString(16).slice(2, 10);
    db.prepare(`INSERT INTO relays(id,name,region,region_code,addr,port,visibility,quota_gb,used_gb,state,enabled,last_health,demo)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(id, name, region, region.toLowerCase().replace(/[^a-z0-9]/g, "") || "relay", addr, port,
        body?.visibility === "private" ? "private" : "public", Number(body?.quotaGb || 0), 0, "pending", 1, null);
    addEvent("relay", `新增中继 ${name}（${addr}:${port}）`);
    if (typeof globalThis.__awaProbeRelays === "function") {
      globalThis.__awaProbeRelays().catch(() => {});
    }
    return { ok: true, id };
  }

  if (url.pathname === "/api/relays/probe" && method === "POST") {
    if (typeof globalThis.__awaProbeRelays !== "function") throw new Error("探测未就绪");
    await globalThis.__awaProbeRelays();
    return { ok: true, relays: listRelays().map(r => ({ id: r.id, state: r.state, last_health: r.last_health })) };
  }

  if (seg[0] === "relays" && seg[2] === "delete" && method === "POST") {
    const row = db.prepare("SELECT * FROM relays WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("中继不存在");
    db.prepare("DELETE FROM relays WHERE id = ?").run(seg[1]);
    addEvent("relay", `删除中继 ${row.name}`);
    return { ok: true };
  }

  if (url.pathname === "/api/tunnels" && method === "POST") {
    const hostname = String(body?.hostname || "").trim().toLowerCase().slice(0, 120);
    const backend = String(body?.backend || "").trim().slice(0, 120);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) throw new Error("域名格式不对，例：nas.example.com");
    if (!backend || !/^[^\s]+:\d{1,5}$/.test(backend)) throw new Error("后端写成 IP或主机:端口，例：10.88.0.5:8080");
    const id = "t_" + Math.random().toString(16).slice(2, 10);
    db.prepare(`INSERT INTO tunnels(id,name,hostname,backend,health,latency_ms,last_check,migratable,demo)
                VALUES(?,?,?,?,?,?,?,?,0)`)
      .run(id, hostname.split(".")[0], hostname, backend, "unknown", null, now(),
        /^(localhost|127\.)/.test(backend) ? 1 : 0);
    addEvent("tunnel", `新增隧道 ${hostname} → ${backend}`);
    return { ok: true, id };
  }

  if (seg[0] === "tunnels" && seg[2] === "delete" && method === "POST") {
    const row = db.prepare("SELECT * FROM tunnels WHERE id = ?").get(seg[1]);
    if (!row) throw new Error("隧道不存在");
    db.prepare("DELETE FROM tunnels WHERE id = ?").run(seg[1]);
    addEvent("tunnel", `删除隧道 ${row.hostname}`);
    return { ok: true };
  }

  if (url.pathname === "/api/events" && method === "GET") {
    return { events: listEvents(Number(url.searchParams.get("limit") || 50)) };
  }

  if (url.pathname === "/api/keys" && method === "POST") {
    const tag = String(body?.tag || "test").slice(0, 24);
    const ttl = Math.min(Math.max(Number(body?.ttl || 1), 1), 24);
    const created = await be.createKey(tag, ttl);
    return created;
  }

  if (url.pathname === "/api/settings" && method === "GET") {
    return {
      version: cfg.version,
      mode: cfg.mode,
      backend: be.name,
      meshCidr: cfg.meshCidr,
      meshDomain: cfg.meshDomain,
      mtu: cfg.mtu,
      eventKeepDays: cfg.eventKeepDays,
      controlUrl: cfg.controlUrl,
      relayPort: cfg.relayPort,
      dataDir: cfg.dataDir,
      wgManaged: isManaged(),
      wgIface: wg.iface,
      wgPeers: db.prepare("SELECT COUNT(*) c FROM wg_peers").get().c,
    };
  }

  if (url.pathname === "/api/settings" && method === "POST") {
    if (body?.mtu) setting("mtu", String(Math.min(Math.max(Number(body.mtu), 1200), 1500)));
    if (body?.meshDomain) setting("mesh_domain", String(body.meshDomain).slice(0, 32));
    addEvent("settings", "设置已更新");
    return { ok: true };
  }

  const err = new Error("接口不存在: " + url.pathname);
  err.status = 404;
  throw err;
}
