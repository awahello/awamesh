const S = {
  authed: false,
  view: "overview",
  filter: "all",
  q: "",
  data: {},
  version: "",
  backend: "",
  timer: null,
};

const app = document.getElementById("app");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => {
  if (!ts) return "—";
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return d + " 秒前";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  return Math.floor(d / 86400) + " 天前";
};
const fmtGb = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + " TB" : Math.round(n) + " GB");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    S.authed = false;
    render();
    throw new Error("登录已失效");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败 " + res.status);
  return data;
}

function toast(msg, bad) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.color = bad ? "var(--bad)" : "";
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function logo(size = 20) {
  return `<svg viewBox="0 0 72 72" width="${size}" height="${size}" aria-hidden="true">
    <path d="M22 24 L50 24 M22 24 L36 48 M50 24 L36 48" stroke="currentColor" stroke-width="4" fill="none"/>
    <circle cx="22" cy="24" r="6" fill="currentColor"/><circle cx="50" cy="24" r="6" fill="currentColor"/>
    <circle cx="36" cy="48" r="6" fill="currentColor"/></svg>`;
}

const NAV = [
  ["overview", "概览"],
  ["devices", "设备"],
  ["relays", "中继节点"],
  ["tunnels", "Cloudflare 隧道"],
  ["events", "事件"],
  ["settings", "设置"],
];

function render() {
  clearInterval(S.timer);
  if (!S.authed) return renderLogin();
  app.innerHTML = `
    <div class="shell">
      <aside class="side" id="side">
        <div class="brand">${logo(20)}<b>awamesh</b></div>
        ${NAV.map(([k, label]) => `<button class="nav-item ${S.view === k ? "on" : ""}" data-nav="${k}">${label}</button>`).join("")}
        <div class="side-foot">v${esc(S.version)} · ${esc(S.backend)}<br><a href="#" data-act="logout">退出登录</a></div>
      </aside>
      <main class="main" id="main"></main>
    </div>`;
  app.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => { S.view = b.dataset.nav; render(); });
  const logout = app.querySelector('[data-act="logout"]');
  if (logout) logout.onclick = async (e) => { e.preventDefault(); await api("/api/logout", { method: "POST" }); S.authed = false; render(); };
  renderView();
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login" id="loginForm">
        <div class="brand">${logo(20)}<b>awamesh</b></div>
        <p class="hint">自托管组网控制台 · 请输入后台口令</p>
        <input id="secret" placeholder="后台口令" autofocus>
        <div class="err" id="err"></div>
        <button class="btn primary" type="submit">登录</button>
        <p class="hint" style="margin-top:14px">首次启动的口令在 <span class="mono">data/initial-admin.txt</span>，也打印在容器日志里。</p>
      </form>
    </div>`;
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ secret: document.getElementById("secret").value }) });
      S.authed = true;
      render();
    } catch (err) {
      document.getElementById("err").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
}

async function renderView() {
  const main = document.getElementById("main");
  if (!main) return;
  main.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    if (S.view === "overview") await viewOverview(main);
    else if (S.view === "devices") await viewDevices(main);
    else if (S.view === "relays") await viewRelays(main);
    else if (S.view === "tunnels") await viewTunnels(main);
    else if (S.view === "events") await viewEvents(main);
    else await viewSettings(main);
  } catch (err) {
    main.innerHTML = `<div class="card"><b>加载失败</b><p class="muted">${esc(err.message)}</p></div>`;
  }
}

/* ---------------- 概览 ---------------- */
async function viewOverview(main) {
  const d = await api("/api/overview");
  S.data.overview = d;
  main.innerHTML = `
    <div class="head">
      <div><h1>概览</h1><div class="sub">${d.devices.total} 台设备 · ${d.devices.online} 在线 · ${d.relays} 个中继 · ${d.tunnels.total} 条隧道${S.backend === "mock" ? " · 演示数据" : ""}</div></div>
      <div class="head-actions">
        <button class="btn" data-act="refresh">刷新</button>
        <button class="btn primary" data-act="join">添加设备</button>
      </div>
    </div>
    ${S.backend === "mock" ? `<div class="card" style="margin-bottom:12px;border-color:var(--warn)"><b>当前是演示模式</b><span class="muted"> · 这些设备/中继/隧道都是假数据。把 AWA_BACKEND 改成 wg（管理你自己的 WireGuard）或 headscale（接真实控制面）后重启容器。</span></div>` : ""}
    <div class="grid c4" style="margin-bottom:14px">
      <div class="kpi"><div class="l">在线设备</div><div class="v">${d.devices.online}<small> / ${d.devices.total}</small></div></div>
      <div class="kpi"><div class="l">本月中继流量</div><div class="v">${fmtGb(d.usedGb)}</div></div>
      <div class="kpi"><div class="l">直连占比</div><div class="v">${d.directRatio}<small>%</small></div></div>
      <div class="kpi"><div class="l">隧道健康</div><div class="v">${d.tunnels.ok}<small> / ${d.tunnels.total}</small></div></div>
    </div>
    <div class="grid c2">
      <div class="card">
        <div class="card-h"><b>网络</b><span>${esc(d.meshCidr)}</span></div>
        <div class="rows">
          ${d.groups.slice(0, 6).map(g => `
            <div class="row" style="grid-template-columns:10px 1fr auto">
              <span class="dot ${g.online === g.total ? "ok" : "warn"}"></span>
              <div class="cell"><b>${esc(g.tag)}</b><div class="dim" style="font-size:11px">${g.online}/${g.total} 在线</div></div>
              <div class="muted" style="font-size:12px">${g.total} 台</div>
            </div>`).join("") || `<div class="empty">暂无分组</div>`}
        </div>
        <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
          <div class="dim" style="font-size:11px;margin-bottom:6px">实时事件</div>
          ${d.events.slice(0, 4).map(e => `<div class="muted" style="font-size:12px">${fmtTime(e.created_at)} · ${esc(e.message)}</div>`).join("") || `<div class="empty">暂无事件</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-h"><b>中继与隧道</b><span>${d.relays} + ${d.tunnels.total}</span></div>
        <div class="dim" style="font-size:11px;margin-bottom:8px">中继流量</div>
        ${(S.data.relays?.relays || []).slice(0, 3).map(r => `
          <div style="margin-bottom:9px">
            <div style="display:flex;justify-content:space-between;font-size:12px"><span>${esc(r.region)}</span><span class="muted">${fmtGb(r.used_gb)}${r.quota_gb ? " / " + fmtGb(r.quota_gb) : ""}</span></div>
            <div class="bar" style="margin-top:4px"><i style="width:${r.quota_gb ? Math.min(100, Math.round(r.used_gb / r.quota_gb * 100)) : 5}%"></i></div>
          </div>`).join("") || `<div class="empty">尚未加载</div>`}
        <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
          <div class="dim" style="font-size:11px;margin-bottom:6px">隧道</div>
          ${(S.data.tunnels?.tunnels || []).slice(0, 4).map(t => `
            <div style="display:flex;align-items:center;gap:7px;font-size:12px;margin-bottom:6px">
              <span class="dot ${t.health === "ok" ? "ok" : "warn"}"></span>
              <span class="cell" style="flex:1">${esc(t.hostname)}</span>
              <span class="muted mono">${esc(t.backend)}</span>
            </div>`).join("") || `<div class="empty">尚未加载</div>`}
        </div>
      </div>
    </div>`;
  main.querySelector('[data-act="refresh"]').onclick = () => renderView();
  main.querySelector('[data-act="join"]').onclick = openKeyModal;
  if (!S.data.relays) api("/api/relays").then(r => { S.data.relays = r; if (S.view === "overview") renderView(); });
  if (!S.data.tunnels) api("/api/tunnels").then(r => { S.data.tunnels = r; if (S.view === "overview") renderView(); });
  S.timer = setInterval(() => { if (S.view === "overview") renderView(); }, 8000);
}

/* ---------------- 设备 ---------------- */
async function viewDevices(main) {
  const qs = new URLSearchParams({ filter: S.filter, q: S.q });
  const d = await api("/api/devices?" + qs);
  main.innerHTML = `
    <div class="head">
      <div><h1>设备</h1><div class="sub">${d.total} 台 · ${d.online} 在线 · ${d.relay} 台走中继</div></div>
      <div class="head-actions">
        <input id="q" placeholder="搜索名称 / IP" value="${esc(S.q)}" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);width:150px">
        ${S.backend === "wg" ? `<button class="btn" data-act="sync">同步状态</button>` : ""}
        <button class="btn primary" data-act="join">添加设备</button>
      </div>
    </div>
    <div class="head-actions" style="margin-bottom:10px">
      ${[["all", "全部"], ["online", "在线"], ["relay", "中继"], ["offline", "离线"]].map(([k, l]) =>
        `<button class="btn sm ${S.filter === k ? "primary" : ""}" data-filter="${k}">${l}</button>`).join("")}
    </div>
    <div class="devices">
      <div class="row head"><div>设备</div><div>Mesh 地址</div><div>角色</div><div>路径</div><div>最后在线</div><div></div></div>
      <div class="rows">
        ${d.devices.map(x => rowDevice(x)).join("") || `<div class="empty">没有匹配的设备</div>`}
      </div>
    </div>`;
  main.querySelector("#q").oninput = (e) => { S.q = e.target.value; clearTimeout(S._qt); S._qt = setTimeout(renderView, 220); };
  main.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { S.filter = b.dataset.filter; renderView(); });
  main.querySelector('[data-act="join"]').onclick = openKeyModal;
  const syncBtn2 = main.querySelector('[data-act="sync"]');
  if (syncBtn2) syncBtn2.onclick = openWgSync;
  main.querySelectorAll("[data-dev]").forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.dev;
      const dev = d.devices.find(x => x.id === id);
      if (b.dataset.op === "rename") {
        const name = prompt("新的设备名", dev.name);
        if (!name || name === dev.name) return;
        try { await api(`/api/devices/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ name }) }); toast("已重命名"); renderView(); }
        catch (e) { toast(e.message, true); }
      }
      if (b.dataset.op === "revoke") {
        if (!confirm(`吊销 ${dev.name}？该设备会立即断网，只能重新加入。`)) return;
        try { await api(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }); toast("已吊销"); renderView(); }
        catch (e) { toast(e.message, true); }
      }
    };
  });
}

function rowDevice(x) {
  const roles = (x.roles || []).map(r => `<span class="tag ${r === "gateway" || r === "relay" ? "info" : ""}">${{ node: "节点", relay: "中继", gateway: "网关", exit: "出口" }[r] || esc(r)}</span>`).join(" ");
  const path = x.revoked_at
    ? `<span class="dim">已吊销</span>`
    : x.path === "relay"
      ? `中继 · ${esc(x.relay || "")} ${x.latency_ms ? x.latency_ms + " ms" : ""}`
      : x.path === "direct" ? `直连 · ${x.latency_ms ?? "—"} ms` : `<span class="dim">—</span>`;
  return `<div class="row ${x.path === "relay" ? "warn" : ""}">
    <div class="cell" style="display:flex;align-items:center;gap:8px">
      <span class="dot ${x.revoked_at ? "bad" : x.online ? "ok" : "off"}"></span>
      <span><b>${esc(x.name)}</b>${x.tags?.length ? `<div class="dim" style="font-size:11px">${esc(x.tags.join(" · "))}</div>` : ""}</span>
    </div>
    <div class="cell mono muted">${esc(x.mesh_ip || "—")}</div>
    <div class="cell">${roles || `<span class="tag">节点</span>`}</div>
    <div class="cell" style="font-size:12px">${path}</div>
    <div class="cell dim" style="font-size:12px">${x.online ? fmtTime(x.last_seen) : x.last_seen ? fmtTime(x.last_seen) : "—"}</div>
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button class="btn sm" data-dev="${esc(x.id)}" data-op="rename">改名</button>
      <button class="btn sm danger" data-dev="${esc(x.id)}" data-op="revoke">吊销</button>
    </div>
  </div>`;
}

/* ---------------- 中继 ---------------- */
async function viewRelays(main) {
  const d = await api("/api/relays");
  S.data.relays = d;
  main.innerHTML = `
    <div class="head">
      <div><h1>中继节点</h1><div class="sub">${d.relays.filter(r => r.enabled).length} 个已启用 · 中继端口 ${d.relayPort}</div></div>
      <div class="head-actions">
        <button class="btn" data-act="map">中继地图</button>
        <button class="btn" data-act="refresh">刷新</button>
      </div>
    </div>
    <div class="grid c2e">
      ${d.relays.map(r => `
        <div class="card">
          <div class="card-h">
            <b style="display:flex;align-items:center;gap:7px">
              <span class="dot ${r.enabled ? (r.state === "online" ? "ok" : "warn") : "off"}"></span>${esc(r.region)} · ${esc(r.name.split("·").pop().trim())}
            </b>
            ${r.visibility === "private" ? `<span class="tag info">仅内网</span>` : `<span class="tag">公网</span>`}
          </div>
          <div class="mono muted" style="font-size:12px;margin-bottom:8px">${esc(r.addr)}:${r.port}</div>
          <div style="display:flex;justify-content:space-between;font-size:12px" class="muted">
            <span>本月 ${fmtGb(r.used_gb)}${r.quota_gb ? " / " + fmtGb(r.quota_gb) : ""}</span>
            <span>${r.state === "online" ? "健康" : r.state}</span>
          </div>
          <div class="bar" style="margin:6px 0 12px"><i style="width:${r.quota_gb ? Math.min(100, Math.round(r.used_gb / r.quota_gb * 100)) : 5}%"></i></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn sm" data-relay="${esc(r.id)}" data-op="toggle">${r.enabled ? "从地图摘除" : "启用"}</button>
            <button class="btn sm" data-relay="${esc(r.id)}" data-op="vis">${r.visibility === "private" ? "改为公网" : "改为仅内网"}</button>
            <button class="btn sm" data-relay="${esc(r.id)}" data-op="cmd">接入命令</button>
          </div>
        </div>`).join("")}
    </div>`;
  main.querySelector('[data-act="refresh"]').onclick = renderView;
  main.querySelector('[data-act="map"]').onclick = async () => {
    try {
      const m = await api("/api/relays/map");
      showCode("中继地图（headscale derp.yaml）", m.yaml, `${m.count} 个中继已写入地图`);
    } catch (e) { toast(e.message, true); }
  };
  main.querySelectorAll("[data-relay]").forEach(b => {
    b.onclick = async () => {
      const r = d.relays.find(x => x.id === b.dataset.relay);
      try {
        if (b.dataset.op === "cmd") {
          const d2 = await api(`/api/relays/${encodeURIComponent(r.id)}/command`);
          showCode(`中继接入命令 · ${r.region}`, d2.script, "在目标机器上以 root 执行");
          return;
        }
        if (b.dataset.op === "toggle") {
          await api(`/api/relays/${encodeURIComponent(r.id)}/toggle`, { method: "POST", body: JSON.stringify({ enabled: !r.enabled }) });
          toast(r.enabled ? "已从地图摘除" : "已启用");
        } else {
          await api(`/api/relays/${encodeURIComponent(r.id)}/visibility`, { method: "POST", body: JSON.stringify({ visibility: r.visibility === "private" ? "public" : "private" }) });
          toast("可见性已更新");
        }
        renderView();
      } catch (e) { toast(e.message, true); }
    };
  });
}

/* ---------------- 隧道 ---------------- */
async function viewTunnels(main) {
  const d = await api("/api/tunnels");
  S.data.tunnels = d;
  main.innerHTML = `
    <div class="head">
      <div><h1>Cloudflare 隧道</h1><div class="sub">${d.tunnels.length} 个域名 · ${d.cfEnabled ? "已配置 API Token" : "未配置 API Token（仅本地数据）"}</div></div>
      <div class="head-actions">
        <button class="btn" data-act="sync" ${d.cfEnabled ? "" : "disabled title='未配置 AWA_CF_TOKEN'"}>从 Cloudflare 同步</button>
        <button class="btn" data-act="refresh">刷新</button>
      </div>
    </div>
    <div class="card">
      <div class="rows">
        <div class="row head" style="grid-template-columns:2fr 1.4fr 0.8fr 0.8fr"><div>域名</div><div>后端</div><div>状态</div><div>检查</div></div>
        ${d.tunnels.map(t => `
          <div class="row" style="grid-template-columns:2fr 1.4fr 0.8fr 0.8fr">
            <div class="cell"><b>${esc(t.hostname)}</b></div>
            <div class="cell mono muted">${esc(t.backend)}</div>
            <div class="cell" style="font-size:12px"><span class="dot ${t.health === "ok" ? "ok" : "warn"}"></span> ${t.health === "ok" ? "正常" : "后端异常"}</div>
            <div class="cell dim" style="font-size:12px">${fmtTime(t.last_check)}</div>
          </div>`).join("") || `<div class="empty">暂无隧道</div>`}
      </div>
      <p class="dim" style="font-size:11px;margin:12px 0 0">v0.1 为只读同步；把 ingress 改指 mesh 地址与回滚在 v0.2 提供。</p>
    </div>`;
  main.querySelector('[data-act="refresh"]').onclick = renderView;
  const syncBtn = main.querySelector('[data-act="sync"]');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "同步中…";
    try {
      const r = await api("/api/tunnels/sync", { method: "POST", body: "{}" });
      toast(`已同步 ${r.count} 条记录`);
      renderView();
    } catch (e) {
      toast(e.message, true);
      syncBtn.disabled = false;
      syncBtn.textContent = "从 Cloudflare 同步";
    }
  };
}

/* ---------------- 事件 ---------------- */
async function viewEvents(main) {
  const d = await api("/api/events?limit=80");
  main.innerHTML = `
    <div class="head"><div><h1>事件</h1><div class="sub">最近 ${d.events.length} 条</div></div>
      <div class="head-actions"><button class="btn" data-act="refresh">刷新</button></div></div>
    <div class="card events">
      <div class="row head"><div>时间</div><div>内容</div><div>类型</div></div>
      <div class="rows">
        ${d.events.map(e => `<div class="row">
          <div class="cell dim" style="font-size:12px">${new Date(e.created_at * 1000).toLocaleString("zh-CN", { hour12: false })}</div>
          <div class="cell">${esc(e.message)}</div>
          <div class="cell"><span class="tag">${esc(e.type)}</span></div>
        </div>`).join("") || `<div class="empty">暂无事件</div>`}
      </div>
    </div>`;
  main.querySelector('[data-act="refresh"]').onclick = renderView;
}

/* ---------------- 设置 ---------------- */
async function viewSettings(main) {
  const s = await api("/api/settings");
  const wg = S.backend === "wg" ? await api("/api/wg/profile") : null;
  main.innerHTML = `
    <div class="head"><div><h1>设置</h1><div class="sub">只读信息 + 少量可改项</div></div></div>
    <div class="grid c2e">
      <div class="card">
        <div class="card-h"><b>运行信息</b></div>
        <div style="display:grid;grid-template-columns:96px 1fr;row-gap:8px;font-size:12px">
          <div class="dim">版本</div><div>v${esc(s.version)}</div>
          <div class="dim">后端</div><div>${esc(s.backend)}</div>
          <div class="dim">模式</div><div>${esc(s.mode)}</div>
          <div class="dim">Mesh 网段</div><div class="mono">${esc(s.meshCidr)}</div>
          <div class="dim">中继端口</div><div class="mono">${s.relayPort}</div>
          <div class="dim">数据目录</div><div class="mono">${esc(s.dataDir)}</div>
          <div class="dim">控制面地址</div><div class="mono">${esc(s.controlUrl || "未设置")}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><b>网络参数</b><span>保存后需重启节点生效</span></div>
        <label class="dim" style="font-size:11px">MTU</label>
        <input id="mtu" value="${s.mtu}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <label class="dim" style="font-size:11px">Mesh 域名后缀</label>
        <input id="meshDomain" value="${esc(s.meshDomain)}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
        <button class="btn primary" id="saveNet">保存</button>
      </div>
      ${wg ? `
      <div class="card">
        <div class="card-h"><b>WireGuard 服务端</b><span>这些值只写进生成的客户端配置</span></div>
        <label class="dim" style="font-size:11px">Endpoint（公网地址:端口）</label>
        <input id="wgEp" value="${esc(wg.endpoint)}" placeholder="1.2.3.4:51820 或 host.example.com:51820" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <label class="dim" style="font-size:11px">服务端公钥（用你 OpenWrt 上 wg 的真实公钥，或直接用下面生成的）</label>
        <input id="wgPub" value="${esc(wg.serverPub)}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);font-family:var(--mono);font-size:12px;margin:4px 0 10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label class="dim" style="font-size:11px">Mesh 网段</label>
            <input id="wgSubnet" value="${esc(wg.subnet)}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0">
          </div>
          <div>
            <label class="dim" style="font-size:11px">MTU</label>
            <input id="wgMtu" value="${wg.mtu}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0">
          </div>
        </div>
        <label class="dim" style="font-size:11px">DNS（可空）</label>
        <input id="wgDns" value="${esc(wg.dns)}" placeholder="10.88.0.1 或 1.1.1.1" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <label class="dim" style="font-size:11px">额外下发路由（家里 LAN，逗号分隔，可空）</label>
        <input id="wgLan" value="${esc(wg.lanRoutes)}" placeholder="192.168.1.0/24" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="saveWg">保存</button>
          <button class="btn" id="regenWg">重新生成服务端密钥</button>
        </div>
      </div>` : ""}
    </div>`;
  if (wg) {
    const payload = () => ({
      endpoint: main.querySelector("#wgEp").value,
      serverPub: main.querySelector("#wgPub").value,
      subnet: main.querySelector("#wgSubnet").value,
      mtu: main.querySelector("#wgMtu").value,
      dns: main.querySelector("#wgDns").value,
      lanRoutes: main.querySelector("#wgLan").value,
    });
    main.querySelector("#saveWg").onclick = async () => {
      try { await api("/api/wg/profile", { method: "POST", body: JSON.stringify(payload()) }); toast("已保存"); renderView(); }
      catch (e) { toast(e.message, true); }
    };
    main.querySelector("#regenWg").onclick = async () => {
      if (!confirm("重新生成会换掉服务端密钥，已下发的客户端配置全部失效，确定？")) return;
      try { await api("/api/wg/profile", { method: "POST", body: JSON.stringify({ regen: true }) }); toast("已重新生成"); renderView(); }
      catch (e) { toast(e.message, true); }
    };
  }
  main.querySelector("#saveNet").onclick = async () => {
    try {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ mtu: Number(main.querySelector("#mtu").value), meshDomain: main.querySelector("#meshDomain").value }),
      });
      toast("已保存");
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 通用代码弹层 ---------------- */
function showCode(title, code, hint) {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>${esc(title)}</h3>
      <div class="sub">${esc(hint || "")}</div>
      <div class="code" style="max-height:44vh">${esc(code)}</div>
      <div class="modal-actions">
        <button class="btn" data-act="copy">复制</button>
        <button class="btn primary" data-act="close">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast("已复制"); }
    catch { toast("复制失败，请手动选择", true); }
  };
  mask.onclick = (e) => { if (e.target === mask) close(); };
}

/* ---------------- 添加设备弹层 ---------------- */
async function openKeyModal() {
  if (S.backend === "wg") return openWgCreate();
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>添加设备</h3>
      <div class="sub">生成一次性密钥，1 小时内有效；把命令贴到目标机器执行。</div>
      <label class="dim" style="font-size:11px">标签</label>
      <input id="kTag" value="test" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
      <label class="dim" style="font-size:11px">有效期（小时）</label>
      <input id="kTtl" type="number" value="1" min="1" max="24" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
      <div id="kOut"></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">关闭</button>
        <button class="btn primary" data-act="gen">生成密钥</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.querySelector('[data-act="gen"]').onclick = async () => {
    try {
      const r = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ tag: mask.querySelector("#kTag").value, ttl: Number(mask.querySelector("#kTtl").value) }),
      });
      const origin = location.origin;
      const cmd = `curl -fsSL '${origin}/join.sh?key=${r.key}' | sh -s --`;
      mask.querySelector("#kOut").innerHTML = `
        <div class="dim" style="font-size:11px">在目标机器上执行：</div>
        <div class="code">${esc(cmd)}</div>
        <div class="dim" style="font-size:11px">密钥只显示这一次（${esc(r.tag)}）</div>`;
      mask.querySelector('[data-act="gen"]').textContent = "再生成一个";
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- wg：真实创建设备 ---------------- */
async function openWgCreate() {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>添加设备</h3>
      <div class="sub">生成真实 WireGuard 密钥与地址，产出可直接粘贴的配置（不需要装 Headscale）</div>
      <label class="dim" style="font-size:11px">设备名</label>
      <input id="wgName" placeholder="router-home / db-01 / win-laptop" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
      <div id="wgOut"></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">关闭</button>
        <button class="btn primary" data-act="gen">生成</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.querySelector('[data-act="gen"]').onclick = async () => {
    try {
      const r = await api("/api/devices", { method: "POST", body: JSON.stringify({ name: mask.querySelector("#wgName").value }) });
      mask.querySelector("#wgOut").innerHTML = `
        <div class="dim" style="font-size:11px">1. 客户端配置（WireGuard App / wg-quick）</div>
        <div class="code">${esc(r.clientConfig)}</div>
        <div class="dim" style="font-size:11px">2. 服务端要点（加到 WireGuard 服务端的配置里，然后重启接口）</div>
        <div class="code">${esc(r.serverPeer)}</div>
        <div class="dim" style="font-size:11px">3. OpenWrt 的 UCI 写法（/etc/config/network）</div>
        <div class="code">${esc(r.openwrt)}</div>`;
      mask.querySelector('[data-act="gen"]').textContent = "再添加一台";
      toast("已创建，配置只显示这一次");
      if (S.view === "devices") renderView();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- wg：导入 wg show 状态 ---------------- */
function openWgSync() {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>同步真实状态</h3>
      <div class="sub">在 WireGuard 服务端执行 <span class="mono">wg show</span>，把整段输出粘进来；会按公钥/地址匹配设备并刷新在线与握手时间</div>
      <textarea id="wgText" rows="10" placeholder="peer: xxxxx&#10;  endpoint: 1.2.3.4:51820&#10;  allowed ips: 10.88.0.2/32&#10;  latest handshake: 42 seconds ago&#10;  transfer: 1.2 MiB received, 3.4 MiB sent" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);font-family:var(--mono);font-size:12px"></textarea>
      <div class="modal-actions">
        <button class="btn" data-act="close">关闭</button>
        <button class="btn primary" data-act="go">导入</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.querySelector('[data-act="go"]').onclick = async () => {
    try {
      const r = await api("/api/wg/sync", { method: "POST", body: JSON.stringify({ text: mask.querySelector("#wgText").value }) });
      toast(`识别 ${r.parsed} 个 peer，匹配 ${r.matched} 台设备`);
      close();
      renderView();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  try {
    const b = await api("/api/bootstrap");
    S.authed = !!b.authed;
    S.version = b.version || "0.1.0";
    S.backend = b.backend || "mock";
  } catch {
    S.authed = false;
  }
  render();
})();
