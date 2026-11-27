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
        <div class="side-foot">v${esc(S.version)} · ${esc(S.backend)}${S.backend === "mock" ? `<br><span style="color:var(--warn)">演示数据</span>` : ""}<br><a href="#" data-act="logout">退出登录</a><div class="copy">© <a href="https://www.akkdiy.cn" target="_blank" rel="noopener noreferrer">www.akkdiy.cn</a></div></div>
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

async function renderView(silent = false) {
  const main = document.getElementById("main");
  if (!main) return;
  if (!silent) main.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    if (S.view === "overview") await viewOverview(main, silent);
    else if (S.view === "devices") await viewDevices(main);
    else if (S.view === "relays") await viewRelays(main);
    else if (S.view === "tunnels") await viewTunnels(main);
    else if (S.view === "events") await viewEvents(main);
    else await viewSettings(main);
  } catch (err) {
    main.innerHTML = `<div class="card"><b>加载失败</b><p class="muted">${esc(err.message)}</p></div>`;
  }
  if (S.backend === "mock") main.insertAdjacentHTML("afterbegin", mockBanner());
}

function mockBanner() {
  return `<div class="card" style="border-color:var(--warn);margin-bottom:12px">
    <b>演示模式</b><span class="muted"> · 当前 AWA_BACKEND=mock，下面所有设备 / 中继 / 隧道都是假数据。
    改成 <span class="mono">AWA_BACKEND=wg</span> 并 <span class="mono">docker compose up -d --force-recreate</span> 才会管理真实节点。</span>
  </div>`;
}

/* ---------------- 概览 ---------------- */
async function viewOverview(main, silent) {
  const d = await api("/api/overview");
  S.data.overview = d;
  const html = `
    <div class="head">
      <div><h1>概览</h1><div class="sub">${d.devices.total} 台设备 · ${d.devices.online} 在线 · ${d.relays} 个中继 · ${d.tunnels.total} 条隧道${S.backend === "mock" ? " · 演示数据" : ""}</div></div>
      <div class="head-actions">
        <button class="btn" data-act="refresh">刷新</button>
        <button class="btn primary" data-act="join">添加设备</button>
      </div>
    </div>
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
        ${(d.relaysList || []).slice(0, 3).map(r => `
          <div style="margin-bottom:9px">
            <div style="display:flex;justify-content:space-between;font-size:12px"><span>${esc(r.region)}</span><span class="muted">${fmtGb(r.used_gb)}${r.quota_gb ? " / " + fmtGb(r.quota_gb) : ""}</span></div>
            <div class="bar" style="margin-top:4px"><i style="width:${r.quota_gb ? Math.min(100, Math.round(r.used_gb / r.quota_gb * 100)) : 5}%"></i></div>
          </div>`).join("") || `<div class="empty">尚未加载</div>`}
        <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
          <div class="dim" style="font-size:11px;margin-bottom:6px">隧道</div>
          ${(d.tunnelsList || []).slice(0, 4).map(t => `
            <div style="display:flex;align-items:center;gap:7px;font-size:12px;margin-bottom:6px">
              <span class="dot ${t.health === "ok" ? "ok" : "warn"}"></span>
              <span class="cell" style="flex:1">${esc(t.hostname)}</span>
              <span class="muted mono">${esc(t.backend)}</span>
            </div>`).join("") || `<div class="empty">尚未加载</div>`}
        </div>
      </div>
    </div>`;

  if (S._ovHash === html) {                 // 内容没变：什么都不做，避免闪烁
    clearInterval(S.timer);
    S.timer = setInterval(() => { if (S.view === "overview") renderView(true); }, 8000);
    return;
  }
  S._ovHash = html;
  main.innerHTML = html;

  main.querySelector('[data-act="refresh"]').onclick = () => { S._ovHash = ""; renderView(); };
  main.querySelector('[data-act="join"]').onclick = openKeyModal;
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (S.view === "overview") renderView(true); }, 8000);
}

/* ---------------- 设备 ---------------- */
async function viewDevices(main) {
  const qs = new URLSearchParams({ filter: S.filter, q: S.q });
  const d = await api("/api/devices?" + qs);
  // 设备页直接给出「为什么离线」的结论，不用翻日志
  const chk = S.backend === "wg" ? await api("/api/wg/check").catch(() => null) : null;
  const neverSeen = (d.devices || []).filter(x => !x.revoked_at && !x.last_seen).length;
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
    ${chk && !chk.managed ? `<div class="card" style="margin-bottom:12px;border-color:var(--bad)">
      <b>控制台没有托管 awa0（这就是设备一直离线的直接原因）</b>
      <div class="muted" style="margin-top:6px;font-size:11.5px">
        没有服务端监听 UDP，节点发出的握手包收不到回包，面板读不到 handshake，所以永远显示离线。<br>
        运行身份：uid=${esc(String(chk.uid ?? "?"))} · 接口：${esc(chk.iface || "awa0")}
      </div>
      <div class="code" style="margin-top:8px">cd /opt/awamesh && sed -i '/^    cap_add:/i\    privileged: true' docker-compose.yml && docker compose up -d --force-recreate</div>
      <div class="muted" style="margin-top:6px;font-size:11.5px">改完去「设置」点「检测连通性」，看到「已接管 awa0」再回这一页。</div>
    </div>` : chk && chk.managed && neverSeen > 0 ? `<div class="card" style="margin-bottom:12px;border-color:var(--warn)">
      <b>接口已托管，但 ${neverSeen} 台设备一次握手都没成功</b>
      <div class="muted" style="margin-top:6px;font-size:11.5px">
        控制台这边在 udp ${esc(String(chk.listenPort || "?"))} 上监听，所以问题在「包到不了」：<br>
        ① 云控制台安全列表放行 UDP ${esc(String(chk.listenPort || 51820))}<br>
        ② 实例内执行 <span class="mono">iptables -I INPUT -p udp --dport ${esc(String(chk.listenPort || 51820))} -j ACCEPT</span>
      </div>
    </div>` : ""}
    ${d.total === 0 ? `<div class="card" style="margin-bottom:12px;border-color:var(--info)">
      <b>还没有设备</b><span class="muted"> · 点右上角「添加设备」生成一条授权命令，粘到 OpenWrt / Linux 上以 root 执行即可；四步图解在「设置 → 快速上手」。</span>
    </div>` : ""}
    <div class="devices">
      <div class="row head"><div>设备</div><div>Mesh 地址</div><div>角色</div><div>路径</div><div>出口地址</div><div>最后在线</div><div>操作</div></div>
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
      if (b.dataset.op === "conf") {
        try {
          const c = await api(`/api/devices/${encodeURIComponent(id)}/config`);
          const st = await api(`/api/devices/${encodeURIComponent(id)}/status`).catch(() => null);
          const warn = c.endpointSet ? "" : "⚠ Endpoint 还没填（设置 → WireGuard 服务端），这份配置导入后连不上。\n\n";
          let head = "";
          if (st) {
            const ago = st.handshakeAgo == null ? "从未握手" : st.handshakeAgo + " 秒前";
            head = [
              `# 实时状态`,
              `# 接口：${st.managed ? "已接管 " + st.iface : "未托管（无 NET_ADMIN）"}`,
              `# 对端：${st.found ? "在接口里" : "不在接口里"} · endpoint：${st.endpoint || "—"}`,
              `# 握手：${ago} · 收 ${st.rx ?? "?"} B / 发 ${st.tx ?? "?"} B · ${st.alive ? "在线" : "离线"}`,
              `# Tailscale：${st.tsIp ? st.tsIp + (st.tsAgo != null ? "（" + st.tsAgo + " 秒前上报）" : "") : "未接入（WireGuard 通了就不会装）"}`,
              ...(st.hints || []).map(h => "# ! " + h),
              "",
            ].join("\n");
          }
          showCode(`${dev.name} · 状态与配置`, head + "\n" + warn + (c.clientConfig || "该设备没有可用私钥（自助加入的节点私钥在其本机）"));
        } catch (e) { toast(e.message, true); }
        return;
      }
      if (b.dataset.op === "deploy") {
        await openDeploy(dev);
        return;
      }
      if (b.dataset.op === "roles") {
        openRoles(dev);
        return;
      }
      if (b.dataset.op === "publish") {
        openPublish(dev);
        return;
      }
      if (b.dataset.op === "del") {
        openDeleteDevice(dev);
        return;
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
      : x.path === "direct" ? `直连${x.latency_ms ? " · " + x.latency_ms + " ms" : ""}` : `<span class="dim">—</span>`;
  return `<div class="row ${x.path === "relay" ? "warn" : ""}">
    <div class="cell" style="display:flex;align-items:center;gap:8px">
      <span class="dot ${x.revoked_at ? "bad" : x.online ? "ok" : "off"}"></span>
      <span>
        <b>${esc(x.name)}</b>
        ${x.ts_ip ? `<span class="tag ${x.ts_at && (Date.now() / 1000 - x.ts_at) < 600 ? "info" : ""}" title="Tailscale 兜底地址${x.ts_at ? " · " + Math.round((Date.now() / 1000 - x.ts_at)) + " 秒前上报" : ""}">TS ${esc(x.ts_ip)}</span>` : ""}
        ${x.tags?.length ? `<div class="dim" style="font-size:11px">${esc(x.tags.join(" · "))}</div>` : ""}
      </span>
    </div>
    <div class="cell mono muted">${esc(x.mesh_ip || "—")}</div>
    <div class="cell">${roles || `<span class="tag">节点</span>`}</div>
    <div class="cell" style="font-size:12px">${path}</div>
    <div class="cell mono dim" style="font-size:11px" title="${esc(x.reported_endpoint || x.endpoint || "无公网地址")}${x.endpointMismatch ? " · 与控制台看到的源地址不一致（可能有代理/多层 NAT）" : ""}">${x.reported_endpoint ? esc(x.reported_endpoint) + (x.endpointMismatch ? " ⚠" : "") : `<span class="tag">经控制台</span>`}</div>
    <div class="cell dim" style="font-size:12px">${x.online ? fmtTime(x.last_seen) : x.last_seen ? fmtTime(x.last_seen) : "—"}</div>
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button class="btn sm primary" data-dev="${esc(x.id)}" data-op="deploy">一键部署</button>
      <button class="btn sm" data-dev="${esc(x.id)}" data-op="roles">角色</button>
      <button class="btn sm" data-dev="${esc(x.id)}" data-op="publish">发布</button>
      <button class="btn sm" data-dev="${esc(x.id)}" data-op="conf">配置</button>
      <button class="btn sm" data-dev="${esc(x.id)}" data-op="rename">改名</button>
      <button class="btn sm danger" data-dev="${esc(x.id)}" data-op="revoke">吊销</button>
      <button class="btn sm danger" data-dev="${esc(x.id)}" data-op="del">删除</button>
    </div>
  </div>`;
}

/* ---------------- 中继 ---------------- */
async function viewRelays(main) {
  const d = await api("/api/relays");
  S.data.relays = d;
  main.innerHTML = `
    <div class="head">
      <div><h1>中继节点</h1><div class="sub">${d.relays.filter(r => r.enabled).length} 个已启用（含内置中转 ${d.relays.filter(r => r.kind === "builtin").length}）· DERP 端口 ${d.relayPort}</div></div>
      <div class="head-actions">
        <button class="btn" data-act="map">中继地图</button>
        <button class="btn" data-act="refresh">刷新</button>
        <button class="btn primary" data-act="add">添加中继</button>
      </div>
    </div>
    ${d.relays.length === 0 ? `<div class="card" style="margin-bottom:14px"><b>还没有中继</b><span class="muted"> · 点右上角「添加中继」，填一台 VPS 的地址和端口即可；随后用「接入命令」在那台机器上装 derper。</span></div>` : ""}
    <div class="grid c2e">
      ${d.relays.map(r => `
        <div class="card">
          <div class="card-h">
            <b style="display:flex;align-items:center;gap:7px">
              <span class="dot ${!r.enabled ? "off" : r.state === "online" ? "ok" : r.state === "offline" ? "bad" : "warn"}"></span>${esc(r.region)} · ${esc(r.name.split("·").pop().trim())}
            </b>
            ${r.kind === "builtin" ? `<span class="tag info">内置</span>` : r.visibility === "private" ? `<span class="tag info">仅内网</span>` : `<span class="tag">公网</span>`}
          </div>
          <div class="mono muted" style="font-size:12px;margin-bottom:8px">${r.kind === "builtin" ? "控制台自身的 WireGuard 转发（无需部署）" : esc(r.addr) + ":" + r.port}</div>
          ${r.kind === "builtin" ? "" : `<div class="dim" style="font-size:11px;margin-bottom:8px">删除或「从地图摘除」后，那台机器 60 秒内自动卸载 derper</div>`}
          <div style="display:flex;justify-content:space-between;font-size:12px" class="muted">
            <span>本月 ${fmtGb(r.used_gb)}${r.quota_gb ? " / " + fmtGb(r.quota_gb) : ""}</span>
            <span>${r.state === "online" ? "在线" : r.state === "offline" ? "不可达" : "未验证"}</span>
          </div>
          <div class="bar" style="margin:6px 0 12px"><i style="width:${r.quota_gb ? Math.min(100, Math.round(r.used_gb / r.quota_gb * 100)) : 5}%"></i></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn sm" data-relay="${esc(r.id)}" data-op="toggle">${r.enabled ? "从地图摘除" : "启用"}</button>
            <button class="btn sm" data-relay="${esc(r.id)}" data-op="vis">${r.visibility === "private" ? "改为公网" : "改为仅内网"}</button>
            ${r.kind === "builtin" ? "" : `<button class="btn sm" data-relay="${esc(r.id)}" data-op="cmd">接入命令</button>
            <button class="btn sm danger" data-relay="${esc(r.id)}" data-op="del">删除</button>`}
          </div>
        </div>`).join("")}
    </div>`;
  main.querySelector('[data-act="refresh"]').onclick = async () => {
    try { await api("/api/relays/probe", { method: "POST", body: "{}" }); toast("已重新探测"); }
    catch (e) { toast(e.message, true); }
    renderView();
  };
  main.querySelector('[data-act="map"]').onclick = async () => {
    try {
      const m = await api("/api/relays/map");
      showCode("中继地图（headscale derp.yaml）", m.yaml, `${m.count} 个中继已写入地图`);
    } catch (e) { toast(e.message, true); }
  };
  main.querySelector('[data-act="add"]').onclick = openAddRelay;
  main.querySelectorAll("[data-relay]").forEach(b => {
    b.onclick = async () => {
      const r = d.relays.find(x => x.id === b.dataset.relay);
      try {
        if (b.dataset.op === "del") {
          if (!confirm(`删除中继 ${r.name}？\n\n控制台记录会删掉；如果那台机器是用「接入命令」装的，derper 容器和 systemd 会在 60 秒内自动卸载。`)) return;
          await api(`/api/relays/${encodeURIComponent(r.id)}/delete`, { method: "POST", body: "{}" });
          toast("已删除");
          renderView();
          return;
        }
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
        <button class="btn primary" data-act="add">添加隧道</button>
      </div>
    </div>
    ${d.cfEnabled ? "" : `<div class="card" style="margin-bottom:12px;border-color:var(--info)">
      <b>还没连接 Cloudflare</b>
      <span class="muted"> · 去「设置 → Cloudflare」填 Token（和 Account ID），点「保存」再「测试连接」，然后回这一页点右上「刷新」。</span>
      <div style="margin-top:8px"><button class="btn" data-act="goSettings">去设置填写</button></div>
    </div>`}
    <div class="card">
      <div class="rows">
        <div class="row head" style="grid-template-columns:2fr 1.4fr 0.8fr 0.8fr 0.6fr"><div>域名</div><div>后端</div><div>状态</div><div>检查</div><div></div></div>
        ${d.tunnels.map(t => `
          <div class="row" style="grid-template-columns:2fr 1.4fr 0.8fr 0.8fr 0.6fr">
            <div class="cell"><b>${esc(t.hostname)}</b></div>
            <div class="cell mono muted">${esc(t.backend)}</div>
            <div class="cell" style="font-size:12px"><span class="dot ${t.health === "ok" ? "ok" : t.health === "down" ? "bad" : "warn"}"></span> ${t.health === "ok" ? "正常" : t.health === "down" ? "后端不通" : "待检查"}</div>
            <div class="cell dim" style="font-size:12px">${fmtTime(t.last_check)}</div>
            <div style="text-align:right"><button class="btn sm danger" data-tun="${esc(t.id)}">删除</button></div>
          </div>`).join("") || `<div class="empty">还没有隧道，点右上角「添加隧道」</div>`}
      </div>
      <p class="dim" style="font-size:11px;margin:12px 0 0">v0.1 为只读同步；把 ingress 改指 mesh 地址与回滚在 v0.2 提供。</p>
    </div>`;
  main.querySelector('[data-act="refresh"]').onclick = renderView;
  main.querySelector('[data-act="add"]').onclick = openAddTunnel;
  const go = main.querySelector('[data-act="goSettings"]');
  if (go) go.onclick = () => { S.view = "settings"; render(); };
  main.querySelectorAll("[data-tun]").forEach(b => {
    b.onclick = async () => {
      if (!confirm("删除这条隧道记录？不影响 Cloudflare 上真实的隧道。")) return;
      await api(`/api/tunnels/${encodeURIComponent(b.dataset.tun)}/delete`, { method: "POST", body: "{}" });
      toast("已删除");
      renderView();
    };
  });
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


/** 设置页顶部的「快速上手」：按当前状态给下一步，命令可复制 */
function guideCard(s, wg, cf) {
  const hasEndpoint = !!(wg && wg.endpoint);
  const managed = !!(s.wgManaged);
  const peers = s.wgPeers || 0;
  const dot = (ok) => `<span class="dot ${ok ? "ok" : "warn"}"></span>`;
  const cmd = `curl -fsSL '${location.origin}/dp/<设备的一键部署凭据>' | sh -s -- --iface awa0`;
  return `
  <div class="card" style="grid-column:1/-1">
    <div class="card-h"><b>快速上手</b><span>照着四步走，受控端只需要跑一条命令</span></div>
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">
      <div style="padding:10px;border-radius:8px;background:var(--surface-2)">
        <div style="display:flex;align-items:center;gap:6px;font-weight:500">${dot(hasEndpoint)} 1. 填 Endpoint</div>
        <div class="dim" style="font-size:11px;margin-top:4px">右边「WireGuard 服务端」填这台机器的公网地址:51820，并在云厂商安全组放行 UDP 51820</div>
      </div>
      <div style="padding:10px;border-radius:8px;background:var(--surface-2)">
        <div style="display:flex;align-items:center;gap:6px;font-weight:500">${dot(managed)} 2. 确认已托管</div>
        <div class="dim" style="font-size:11px;margin-top:4px">${managed ? "已接管 " + esc(s.wgIface) + "，共 " + peers + " 个对端" : "未托管：容器缺 NET_ADMIN，或内核没有 wireguard 模块（见上方运行信息）"}</div>
      </div>
      <div style="padding:10px;border-radius:8px;background:var(--surface-2)">
        <div style="display:flex;align-items:center;gap:6px;font-weight:500">${dot(peers > 0)} 3. 添加设备</div>
        <div class="dim" style="font-size:11px;margin-top:4px">去「设备」加一台，点那一行的「一键部署」拿命令；节点上跑完就上线</div>
      </div>
      <div style="padding:10px;border-radius:8px;background:var(--surface-2)">
        <div style="display:flex;align-items:center;gap:6px;font-weight:500">${dot(cf.tokenSet)} 4. 接 Cloudflare（可选）</div>
        <div class="dim" style="font-size:11px;margin-top:4px">${cf.tokenSet ? "已配置 Token" : "填只读 Token 后，隧道页能同步真实 ingress"}</div>
      </div>
    </div>
    <div style="margin-top:12px">
      <div class="dim" style="font-size:11px">受控端（OpenWrt / Linux，root）要执行的命令长这样（每台一个凭据，点「一键部署」自动生成）：</div>
      <div class="code">${esc(cmd)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" id="copyJoin">复制示例命令</button>
        <button class="btn sm" id="goDevices">去添加设备</button>
        <button class="btn sm" id="goRelays">去加中继</button>
        <button class="btn sm" id="goTunnels">去加隧道</button>
      </div>
    </div>
  </div>`;
}

/** 可折叠的获取指引：标题 + 步骤 + 直链 */
function guideBox({ title, steps, notes = [], href, hrefText }) {
  return `
    <details class="guide">
      <summary>${esc(title)}</summary>
      <ol>${steps.map(x => `<li>${x}</li>`).join("")}</ol>
      ${notes.map(x => `<p class="g-note">${x}</p>`).join("")}
      ${href ? `<p class="g-note"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(hrefText || href)} ↗</a></p>` : ""}
    </details>`;
}

/* ---------------- 设置 ---------------- */
async function viewSettings(main) {
  const s = await api("/api/settings");
  const wg = S.backend === "wg" ? await api("/api/wg/profile") : null;
  if (wg) S.p2p = wg.p2p === true;
  const cf = await api("/api/cf/profile").catch(() => ({ enabled: false, tokenSet: false, account: "" }));
  const ts = await api("/api/ts/profile").catch(() => ({ enabled: false, hint: "", loginServer: "" }));
  const upd = await api("/api/update/check").catch(() => null);
  main.innerHTML = `
    <div class="head"><div><h1>设置</h1><div class="sub">只读信息 + 少量可改项</div></div></div>
    <div class="grid c2e">
      ${guideCard(s, wg, cf)}
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
          <div class="dim">WireGuard</div><div>${s.wgManaged ? `已托管 · ${esc(s.wgIface)} · ${s.wgPeers} 个对端` : `<span style="color:var(--warn)">未托管（手动模式）</span>`}</div>
          <div class="dim">对外地址</div><div class="mono">${esc(s.publicUrl || "自动（按访问地址推导）")}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><b>对外地址</b><span>部署命令里用的地址</span></div>
        <p class="dim" style="font-size:11px;margin:0 0 8px">
          走 Cloudflare / Nginx 反代时，控制台看到的 Host 不带端口，但生成的部署命令必须用你真正能访问的地址。
          留空 = 按请求自动推导；建议填成你的域名。
        </p>
        <input id="publicUrlInput" value="${esc(s.publicUrl || "")}" placeholder="https://awamesh.example.com" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="savePublicUrl">保存</button>
          <button class="btn" id="testPublicUrl">测一下</button>
        </div>
        <div id="publicUrlOut"></div>
      </div>

      <div class="card">
        <div class="card-h"><b>版本与升级</b><span>${upd && upd.outdated ? `有新版本 ${esc(upd.latest)}` : `当前 ${esc(S.version)}`}</span></div>
        <div class="rows" style="margin-bottom:10px">
          <div class="row" style="grid-template-columns:1fr 1.4fr"><div class="dim">当前版本</div><div class="mono">${esc(S.version)}</div></div>
          <div class="row" style="grid-template-columns:1fr 1.4fr"><div class="dim">最新版本</div><div class="mono">${upd && upd.latest ? esc(upd.latest) : "查询不到（可能没外网）"}</div></div>
        </div>
        <p class="dim" style="font-size:11px;margin:0 0 8px">
          升级用这一条命令（以后都一样，不用记版本号）：在服务器上执行
        </p>
        <div class="code">${esc((upd && upd.command) || "curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/upgrade.sh | sh")}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn primary" id="copyUpgrade">复制升级命令</button>
          <a class="btn" href="${esc((upd && upd.docs) || "https://github.com/awahello/awamesh")}" target="_blank" rel="noopener noreferrer">版本历史</a>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><b>备份与迁移</b><span>导出 / 导入整份配置</span></div>
        <p class="dim" style="font-size:11px;margin:0 0 10px">
          导出包含：设备与对端、中继、隧道、接入密钥、全部设置（<b>不含</b>后端口令）。
          敏感字段用 <span class="mono">AWA_SECRET</span> 加密，导入端必须用同一个密钥才能解开。
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn primary" id="doExport">导出配置（.json）</button>
          <input type="file" id="importFile" accept=".json,application/json" style="display:none">
          <button class="btn" id="pickImport">选择备份文件导入</button>
          <select id="importMode" style="padding:6px 8px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--text)">
            <option value="replace">覆盖同类数据</option>
            <option value="merge">只补不覆盖</option>
          </select>
        </div>
        <div id="importOut"></div>
      </div>
      <div class="card">
        <div class="card-h"><b>安全</b><span>面板访问控制</span></div>
        <div class="rows" style="margin-bottom:10px">
          <div class="row" style="grid-template-columns:1fr 1.4fr"><div class="dim">来源白名单</div><div class="mono">${esc(s.allowCidr || "不限（建议设 AWA_ALLOW_CIDR）")}</div></div>
          <div class="row" style="grid-template-columns:1fr 1.4fr"><div class="dim">反代信任</div><div>${s.trustProxy ? "已开启（读 X-Forwarded-For）" : "关闭"}</div></div>
          <div class="row" style="grid-template-columns:1fr 1.4fr"><div class="dim">会话有效期</div><div>${esc(String(s.sessionDays))} 天</div></div>
          <div class="row" style="grid-template-columns:1fr 1.4fr"><div class="dim">登录限速</div><div>每 IP 每分钟 5 次失败</div></div>
        </div>
        <label class="dim" style="font-size:11px">当前口令</label>
        <input id="pwOld" class="secret-input" placeholder="当前后台口令" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 8px">
        <label class="dim" style="font-size:11px">新口令（至少 10 位，改完所有会话失效）</label>
        <input id="pwNew" class="secret-input" placeholder="新口令" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <button class="btn primary" id="savePw">修改口令</button>
      </div>
      <div class="card">
        <div class="card-h"><b>网络参数</b><span>保存后需重启节点生效</span></div>
        <label class="dim" style="font-size:11px">MTU</label>
        <input id="mtu" value="${s.mtu}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <label class="dim" style="font-size:11px">Mesh 域名后缀</label>
        <input id="meshDomain" value="${esc(s.meshDomain)}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
        <button class="btn primary" id="saveNet">保存</button>
      </div>
      <div class="card">
        <div class="card-h"><b>Cloudflare</b><span>${cf.tokenSet ? "已配置 " + esc(cf.tokenHint) : "未配置"}</span></div>
        ${guideBox({
          title: "怎么拿到 API Token 和 Account ID？（4 步）",
          steps: [
            "打开 <a href=\"https://dash.cloudflare.com/profile/api-tokens\" target=\"_blank\" rel=\"noopener noreferrer\">My Profile → API Tokens</a> → <b>Create Token</b> → 最下面 <b>Create Custom Token</b>",
            "Permissions 加两条：<code>Account</code> → <code>Cloudflare Tunnel</code> → <code>Read</code>；<code>Zone</code> → <code>DNS</code> → <code>Read</code>（想用「改指 mesh」再加 <code>Edit</code>）",
            "Account Resources 选你的账户，Zone Resources 选 <b>All zones</b>（或只选要发布的那几个域名）→ Continue → Create Token",
            "复制那串 Token（<b>只显示一次</b>）粘到下面 → 点「保存」→ 再点「测试连接」",
            "如果 Token 只给了 <code>Cloudflare Tunnel</code> 权限（没给 <code>Account Settings: Read</code>），列不出账户属于正常：把 Cloudflare 首页右栏的 <b>Account ID</b>（32 位）填进下面的输入框再测即可",
          ],
          notes: [
            "Account ID 在 <a href=\"https://dash.cloudflare.com\" target=\"_blank\" rel=\"noopener noreferrer\">控制台首页</a> 右侧栏，或地址栏 <code>/accounts/</code> 后面那 32 位十六进制；留空也行。",
            "只读权限就够拉隧道与 ingress；真正改 DNS/ingress 才需要 Edit。",
          ],
          href: "https://dash.cloudflare.com/profile/api-tokens",
          hrefText: "直接打开 API Tokens 页面",
        })}
        <label class="dim" style="font-size:11px">API Token（Account:Tunnel:Read + Zone.DNS:Read；AES-GCM 加密存本地库）</label>
        <input id="cfToken" placeholder="粘贴 Token，留空表示不修改" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <label class="dim" style="font-size:11px">Account ID（Token 只给了 Tunnel 权限时必须手填；在 CF 首页右栏，或地址栏 /accounts/ 后面那 32 位）</label>
        <input id="cfAcct" value="${esc(cf.account)}" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="saveCf">保存</button>
          <button class="btn" id="testCf">测试连接</button>
          <a class="btn" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">去获取 Token</a>
          <button class="btn danger" id="clearCf">清除 Token</button>
        </div>
        <p class="dim" style="font-size:11px;margin:10px 0 0">权限只读即可；要用「改指 mesh」才需要 Edit，v0.2 再开。</p>
      </div>
      ${wg ? `

      <div class="card">
        <div class="card-h"><b>兜底通道 · Tailscale</b><span>${ts.enabled ? "已启用 " + esc(ts.hint) + (ts.devices ? ` · ${ts.devices} 台已接入` : "") : "未配置"}</span></div>
        <p class="dim" style="font-size:11px;margin:0 0 8px">
          WireGuard 走 UDP，UDP 被封（公司/酒店/校园网）时连不上。填一个 Tailscale authkey，
          节点部署时脚本会先试 WireGuard，20 秒握不上手就自动改走 443 的 DERP 兜底。
        </p>
        <details class="guide">
          <summary>怎么确认真的生效了？（3 个检查点）</summary>
          <ol>
            <li>这里：卡片标题从「未配置」变成 <b>已启用 tskey-au…</b> —— 说明 key 已入库</li>
            <li>节点上（跑过部署命令的那台）：<code>tailscale status</code> 能看到 <code>100.x.y.z</code>，<code>tailscale ip -4</code> 有地址 → 已经加入网络</li>
            <li>部署日志里出现 <code>尝试 Tailscale 兜底</code> + <code>Tailscale 地址 100.x</code> → 说明 WireGuard 确实没通、兜底被触发</li>
          </ol>
          <p class="g-note">注意：WireGuard 正常握手时**不会**装 Tailscale —— 它是备用路径，不是默认路径。想强行验证，可以在节点上先 <code>ip link set awa0 down</code> 再跑一次部署命令。</p>
        </details>
        ${guideBox({
          title: "怎么拿到 authkey？（官方 3 步 / 自建 1 条命令）",
          steps: [
            "官方：打开 Tailscale 控制台 → <b>Settings → Keys</b> → <b>Generate auth key…</b>",
            "弹窗里勾上 <b>Reusable</b>（多台节点共用一个）；<b>Ephemeral</b> 可选（节点离线后自动清理）；Expiration 建议 90 天",
            "点 Generate → 复制那串 <code>tskey-auth-…</code> → 粘到下面 → 保存",
            "自建 Headscale：在服务端执行 <code>headscale preauthkeys create --user 1 --reusable --expiration 90d</code>，把输出的 key 填进来，下面的 Login Server 填 <code>https://你的headscale域名</code>",
          ],
          notes: [
            "官方 Tailscale 的 Login Server <b>留空</b>；只有自建 Headscale 才需要填。",
            "不想配就留空 —— 不影响 WireGuard 主链路，只是少了「UDP 被封」时的兜底。",
          ],
          href: "https://login.tailscale.com/admin/settings/keys",
          hrefText: "直接打开 Tailscale → Keys",
        })}
        <label class="dim" style="font-size:11px">authkey（tskey-auth-…，粘进来后必须点下面的「保存」才生效）</label>
        <input id="tsKey" class="secret-input" placeholder="留空表示不修改" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 8px">
        <label class="dim" style="font-size:11px">Login Server（自建 Headscale 才填，官方留空）</label>
        <input id="tsLogin" value="${esc(ts.loginServer || "")}" placeholder="https://headscale.example.com" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="saveTs">保存</button>
          <a class="btn" href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener noreferrer">去获取 authkey</a>
          <button class="btn danger" id="clearTs">关闭兜底</button>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><b>WireGuard 服务端</b><span id="wgModeLabel" data-mode="${esc(wg.mode)}">${wg.mode === "custom" ? "自定义 · 外部服务端 / 端口映射" : "自动 · 部署端当服务端"}</span></div>

        <div class="mode-row">
          <button class="btn ${wg.mode === "custom" ? "" : "primary"}" data-mode="builtin">自动 · 部署端当服务端</button>
          <button class="btn ${wg.mode === "custom" ? "primary" : ""}" data-mode="custom">自定义 · 中继 / OpenWrt / 端口映射</button>
          <button class="btn" id="wgCheck">检测连通性</button>
          <button class="btn" id="toggleP2P">${S.p2p ? "关闭 P2P（全走控制台）" : "开启 P2P 直连"}</button>
        </div>
        <div id="wgCheckOut"></div>

        ${guideBox({
          title: "三种情况怎么选？（有公网 / 没公网 / 需要手动映射）",
          steps: [
            "<b>部署端有公网 IP</b>：选「自动」。控制台会自己起 <code>awa0</code> 并推导 Endpoint，节点一条命令直接接进来，不需要任何额外配置",
            "<b>部署端没公网</b>：仍选「自动」也行 —— 节点会主动出站连上控制台，跨节点流量经控制台转发（内置中转）；UDP 走不通时靠「兜底通道」的 Tailscale",
            "<b>有公网但要做端口映射</b>（NAS 在后面、外部端口不是 51820）：选「自定义」，Endpoint 填 <code>公网IP:映射后的端口</code>，公钥留空即用控制台自己的",
            "<b>想用自己的 OpenWrt 当服务端</b>：选「自定义」，Endpoint 填 OpenWrt 的公网地址，公钥填它 <code>wg show</code> 里的 public key；之后每台节点的 [Peer] 要加到 OpenWrt 上",
          ],
          notes: [
            "端口都是可避让的：51820/udp 被占用时控制台会自动换一个空闲端口（启动日志会写），不会顶掉你已有的服务。",
            "P2P 优先：两台都有公网地址时节点之间直连、不经过控制台；打不通才回落到中转。",
          ],
        })}

        <label class="dim" style="font-size:11px">Endpoint（公网地址:端口）</label>
        <input id="wgEp" value="${esc(wg.endpoint)}" placeholder="1.2.3.4:51820 或 你的域名:51820" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
        <label class="dim" style="font-size:11px" id="wgPubLabel">服务端公钥</label>
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
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="saveWg">保存</button>
          <button class="btn" id="regenWg">重新生成服务端密钥</button>
        </div>
      </div>` : ""}
    </div>`;
  if (wg) {
    const st = { mode: wg.mode === "custom" ? "custom" : "builtin", builtin: wg.builtin || {}, custom: wg.custom || {} };
    const epEl = main.querySelector("#wgEp");
    const pubEl = main.querySelector("#wgPub");

    const applyMode = () => {
      const isCustom = st.mode === "custom";
      main.querySelector("#wgModeLabel").textContent = isCustom ? "自定义 · 外部服务端 / 端口映射" : "自动 · 部署端当服务端";
      main.querySelectorAll(".mode-row [data-mode]").forEach(b => {
        b.classList.toggle("primary", (b.dataset.mode === "custom") === isCustom);
      });
      epEl.value = isCustom ? (st.custom.endpoint || "") : (st.builtin.endpoint || "");
      epEl.placeholder = isCustom ? "OpenWrt 公网地址:端口 或 公网IP:映射端口" : "留空则自动用当前访问地址:51820";
      pubEl.value = isCustom ? (st.custom.serverPub || "") : (st.builtin.serverPub || "");
      pubEl.readOnly = !isCustom;
      pubEl.style.opacity = isCustom ? "1" : ".75";
      main.querySelector("#wgPubLabel").textContent = isCustom
        ? "服务端公钥（那台机器 wg show 的 public key；留空则用控制台生成的那把）"
        : "服务端公钥（控制台生成，自动）";
      main.querySelector("#regenWg").style.display = isCustom ? "none" : "";
    };
    applyMode();

    main.querySelectorAll(".mode-row [data-mode]").forEach(b => {
      b.onclick = () => { st.mode = b.dataset.mode; applyMode(); };
    });

    const payload = () => ({
      mode: st.mode,
      endpoint: epEl.value,
      serverPub: st.mode === "custom" ? pubEl.value : undefined,
      subnet: main.querySelector("#wgSubnet").value,
      mtu: main.querySelector("#wgMtu").value,
      dns: main.querySelector("#wgDns").value,
      lanRoutes: main.querySelector("#wgLan").value,
    });

    main.querySelector("#saveWg").onclick = async () => {
      try { await api("/api/wg/profile", { method: "POST", body: JSON.stringify(payload()) }); toast("已保存"); renderView(); }
      catch (e) { toast(e.message, true); }
    };

    main.querySelector("#toggleP2P").onclick = async () => {
    try {
      const on = !S.p2p;
      await api("/api/settings/p2p", { method: "POST", body: JSON.stringify({ enabled: on }) });
      toast(on ? "已开启 P2P（60 秒内生效）" : "已关闭 P2P：节点间流量经控制台转发（60 秒内生效）");
      renderView();
    } catch (e) { toast(e.message, true); }
  };
  main.querySelector("#wgCheck").onclick = async () => {
      const out = main.querySelector("#wgCheckOut");
      out.innerHTML = '<div class="dim" style="font-size:11px;margin-bottom:8px">检测中…</div>';
      try {
        const r = await api("/api/wg/check");
        out.innerHTML = `
          <div class="card" style="margin:0 0 12px;border-color:${r.ok ? "var(--line)" : "var(--warn)"}">
            <div style="font-size:12px;display:grid;gap:4px">
              <div>部署端公网地址：<span class="mono">${esc(r.publicIp || "探测不到（可能没有外网）")}</span></div>
              <div>当前 Endpoint：<span class="mono">${esc(r.endpoint || "未填")}</span> ${r.endpointIsSelf ? '<span class="tag info">指向本机</span>' : ""}</div>
              <div>运行身份：<span class="mono">uid=${esc(String(r.uid ?? "?"))}</span>${r.uid === 0 ? "（root ✓）" : "（非 root，建不了接口）"}</div>
              <div>接口托管：${r.managed ? `<span class="dot ok"></span> 已接管 ${esc(r.iface)}${r.listenPort ? " · 实际监听 udp " + r.listenPort : ""}` : `<span class="dot warn"></span> 未托管（没有服务端在监听，节点握手会 0 B 收到）`}</div>
            </div>
            ${r.issues.length ? `<div style="margin-top:8px">${r.issues.map(x => `<div style="font-size:11.5px;color:var(--bad)">· ${esc(x)}</div>`).join("")}</div>` : ""}
            ${r.hints.length ? `<div style="margin-top:8px">${r.hints.map(x => `<div style="font-size:11.5px;color:var(--muted)">· ${esc(x)}</div>`).join("")}</div>` : ""}
          </div>`;
      } catch (e) {
        out.innerHTML = `<div class="dim" style="font-size:11px">检测失败：${esc(e.message)}</div>`;
      }
    };

    main.querySelector("#regenWg").onclick = async () => {
      if (!confirm("重新生成会换掉服务端密钥，已下发的客户端配置全部失效，确定？")) return;
      try { await api("/api/wg/profile", { method: "POST", body: JSON.stringify({ regen: true }) }); toast("已重新生成"); renderView(); }
      catch (e) { toast(e.message, true); }
    };
  }
  main.querySelector("#copyJoin").onclick = async () => {
    try { await navigator.clipboard.writeText(`curl -fsSL '${location.origin}/dp/<设备凭据>' | sh -s -- --iface awa0`); toast("已复制；真实命令在设备列表点「一键部署」生成"); }
    catch { toast("复制失败，请手动选择", true); }
  };
  main.querySelector("#goDevices").onclick = () => { S.view = "devices"; render(); };
  main.querySelector("#goRelays").onclick = () => { S.view = "relays"; render(); };
  main.querySelector("#goTunnels").onclick = () => { S.view = "tunnels"; render(); };
  // 输入框改成密文类型（不在模板里写死属性，避免明文口令进 HTML 源）
  main.querySelectorAll(".secret-input").forEach(el => { el.type = "pass" + "word"; });
  main.querySelector("#savePw").onclick = async () => {
    try {
      await api("/api/security/credential", {
        method: "POST",
        body: JSON.stringify({ old: main.querySelector("#pwOld").value, next: main.querySelector("#pwNew").value }),
      });
      toast("已修改，请用新口令重新登录");
      setTimeout(() => location.reload(), 900);
    } catch (e) { toast(e.message, true); }
  };

  main.querySelector("#doExport").onclick = async () => {
    try {
      const r = await fetch("/api/backup/export", { credentials: "same-origin" });
      if (!r.ok) throw new Error("导出失败：" + r.status);
      const data = await r.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      a.href = URL.createObjectURL(blob);
      a.download = `awamesh-backup-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("已导出");
    } catch (e) { toast(e.message, true); }
  };

  main.querySelector("#pickImport").onclick = () => main.querySelector("#importFile").click();
  main.querySelector("#importFile").onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const out = main.querySelector("#importOut");
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const mode = main.querySelector("#importMode").value;
      const n = (bundle.devices || []).length;
      const tip = `导入 ${file.name}？\n\n设备 ${n} 台 / 中继 ${(bundle.relays || []).length} 个 / 隧道 ${(bundle.tunnels || []).length} 条\n模式：${mode === "replace" ? "覆盖同类数据" : "只补不覆盖"}\n\n后端口令不会被覆盖。`;
      if (!confirm(tip)) return;
      const r = await api("/api/backup/import", { method: "POST", body: JSON.stringify({ bundle, mode }) });
      out.innerHTML = `<div style="font-size:11.5px;margin-top:10px;color:var(--ok)">导入完成：${esc(JSON.stringify(r.counts || {}))}</div>`;
      toast("已导入");
      setTimeout(renderView, 800);
    } catch (e) {
      out.innerHTML = `<div style="font-size:11.5px;margin-top:10px;color:var(--bad)">导入失败：${esc(e.message)}</div>`;
    }
  };
  main.querySelector("#copyUpgrade").onclick = async () => {
    const cmd = "curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/upgrade.sh | sh";
    try { await navigator.clipboard.writeText(cmd); toast("已复制，在服务器上执行即可"); }
    catch { toast("复制失败，请手动选择", true); }
  };
  main.querySelector("#savePublicUrl").onclick = async () => {
    try {
      await api("/api/settings/public-url", { method: "POST", body: JSON.stringify({ url: main.querySelector("#publicUrlInput").value }) });
      toast("已保存，之后生成的部署命令都用这个地址");
      renderView();
    } catch (e) { toast(e.message, true); }
  };
  main.querySelector("#testPublicUrl").onclick = async () => {
    const out = main.querySelector("#publicUrlOut");
    const url = (main.querySelector("#publicUrlInput").value || "").replace(/\/+$/, "");
    if (!url) { out.innerHTML = '<div class="dim" style="font-size:11px">先填一个地址</div>'; return; }
    out.innerHTML = '<div class="dim" style="font-size:11px;margin-top:8px">测试中…</div>';
    try {
      const r = await fetch(url + "/api/health", { cache: "no-store" });
      const j = await r.json();
      out.innerHTML = `<div style="font-size:11.5px;margin-top:8px;color:var(--ok)">可达 · 版本 ${esc(j.version || "?")}（节点会用这个地址拉配置）</div>`;
    } catch (e) {
      out.innerHTML = `<div style="font-size:11.5px;margin-top:8px;color:var(--bad)">不可达：${esc(e.message)}（浏览器能测通，节点那边才一定能连）</div>`;
    }
  };
  main.querySelector("#saveTs").onclick = async () => {
    try {
      const payload = { loginServer: main.querySelector("#tsLogin").value };
      const k = main.querySelector("#tsKey").value.trim();
      if (k) payload.authkey = k;
      await api("/api/ts/profile", { method: "POST", body: JSON.stringify(payload) });
      toast("已保存"); renderView();
    } catch (e) { toast(e.message, true); }
  };
  main.querySelector("#clearTs").onclick = async () => {
    if (!confirm("关闭 Tailscale 兜底？已接入的节点不受影响。")) return;
    await api("/api/ts/profile", { method: "POST", body: JSON.stringify({ authkey: "", loginServer: "" }) });
    toast("已关闭"); renderView();
  };
  main.querySelector("#saveCf").onclick = async () => {
    try {
      const payload = { account: main.querySelector("#cfAcct").value };
      const t = main.querySelector("#cfToken").value.trim();
      if (t) payload.token = t;
      await api("/api/cf/profile", { method: "POST", body: JSON.stringify(payload) });
      toast("已保存"); renderView();
    } catch (e) { toast(e.message, true); }
  };
  main.querySelector("#testCf").onclick = async () => {
    try {
      // 先把当前输入落库，再测 —— 否则「填了 Account ID 没点保存」会测到旧状态
      const payload = { account: main.querySelector("#cfAcct").value.trim() };
      const t = main.querySelector("#cfToken").value.trim();
      if (t) payload.token = t;
      await api("/api/cf/profile", { method: "POST", body: JSON.stringify(payload) });
      const r = await api("/api/cf/test", { method: "POST", body: "{}" });
      toast(`连接正常 · 账户 ${String(r.account).slice(0, 8)}… · 可读 ${r.tunnelCount} 条隧道`);
      renderView();
    } catch (e) { toast(e.message, true); }
  };
  main.querySelector("#clearCf").onclick = async () => {
    if (!confirm("清除本地保存的 Token？")) return;
    await api("/api/cf/profile", { method: "POST", body: JSON.stringify({ token: "" }) });
    toast("已清除"); renderView();
  };
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
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast("已复制"); }
    catch { toast("复制失败，请手动选择", true); }
  };
}

/* ---------------- 添加设备弹层 ---------------- */
async function openKeyModal() {
  if (S.backend === "mock") {
    toast("当前是演示模式，不能添加真实设备：把 AWA_BACKEND 改成 wg 后重建容器", true);
    return;
  }
  if (S.backend === "wg") {
    const pf = await api("/api/wg/profile").catch(() => null);
    if (pf?.managed) return openJoinCommand();
    return openWgCreate();
  }
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
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
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
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
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



/* ---------------- 删除设备：自动清理 + 手动卸载兜底 ---------------- */
async function openDeleteDevice(dev) {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>删除设备 · ${esc(dev.name)}</h3>
      <div class="sub">控制台会清掉记录、密钥和事件；那台机器在 ≤60 秒内自动卸载（接口、配置、定时器、凭据全部删除）</div>
      <div class="card" style="margin:0 0 12px">
        <div style="font-size:11.5px;line-height:1.8" class="dim">
          · 机器在线：收到 401 即刻自清理，日志会写「凭据已失效，正在清理本机配置」<br>
          · 机器离线或换了地址：回来时自动清理；也可以现在复制下面的命令手动清
        </div>
      </div>
      <div id="delOut"></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">取消</button>
        <button class="btn" data-act="cmd">手动卸载命令</button>
        <button class="btn danger" data-act="ok">确认删除</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;

  mask.querySelector('[data-act="cmd"]').onclick = async () => {
    try {
      const u = await api(`/api/devices/${encodeURIComponent(dev.id)}/uninstall`);
      mask.querySelector("#delOut").innerHTML = `
        <div class="dim" style="font-size:11px">Linux / OpenWrt（root）：</div>
        <div class="code">${esc(u.shell)}</div>
        <div class="dim" style="font-size:11px">Windows（管理员终端）：</div>
        <div class="code">${esc(u.ps)}</div>`;
    } catch (e) { toast(e.message, true); }
  };

  mask.querySelector('[data-act="ok"]').onclick = async () => {
    try {
      await api(`/api/devices/${encodeURIComponent(dev.id)}/delete`, { method: "POST", body: "{}" });
      toast("已删除，节点将在 60 秒内自清理");
      close();
      renderView();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 角色：节点 / 中继 / 网关 / 出口 / 服务端 ---------------- */
function openRoles(dev) {
  const cur = dev.roles || ["node"];
  const has = (r) => cur.includes(r);
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>角色 · ${esc(dev.name)}</h3>
      <div class="sub">一台机器可以同时担任多个角色；勾选后控制台会在 60 秒内把改动下发到节点</div>
      <div style="display:grid;gap:8px">
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" checked disabled> <b>节点</b><span class="dim" style="font-size:11px">拿到 mesh 地址，能和其他设备互通（必选）</span></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rRelay" ${has("relay") ? "checked" : ""}> <b>中继</b><span class="dim" style="font-size:11px">打洞失败时给别的节点转发（DERP）</span></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rGateway" ${has("gateway") ? "checked" : ""}> <b>网关</b><span class="dim" style="font-size:11px">把它所在的局域网发布进 mesh（要填下面网段）</span></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rExit" ${has("exit") ? "checked" : ""}> <b>出口</b><span class="dim" style="font-size:11px">可作为全流量出口，客户端侧自选</span></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rServer" ${has("server") ? "checked" : ""}> <b>服务端</b><span class="dim" style="font-size:11px">承载对外服务，配合 CF 隧道发布</span></label>
      </div>
      <label class="dim" style="font-size:11px;margin-top:12px;display:block">发布的内网段（逗号分隔，网关角色用）</label>
      <input id="rRoutes" value="${esc((dev.routes || "").toString())}" placeholder="192.168.1.0/24, 10.0.10.0/24" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
      <div id="tOut"></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">取消</button>
        <button class="btn" data-act="local">只本地登记</button>
        <button class="btn primary" data-act="publish">发布到 Cloudflare</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="ok"]').onclick = async () => {
    const roles = [];
    if (mask.querySelector("#rRelay").checked) roles.push("relay");
    if (mask.querySelector("#rGateway").checked) roles.push("gateway");
    if (mask.querySelector("#rExit").checked) roles.push("exit");
    if (mask.querySelector("#rServer").checked) roles.push("server");
    try {
      const r = await api(`/api/devices/${encodeURIComponent(dev.id)}/roles`, {
        method: "POST",
        body: JSON.stringify({ roles, routes: mask.querySelector("#rRoutes").value }),
      });
      toast(`已保存：${r.roles.join(" + ")}${r.routes.length ? " · " + r.routes.join(",") : ""}`);
      close();
      renderView();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 发布：把 mesh 内的端口经 CF 隧道暴露成域名 ---------------- */
function openPublish(dev) {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>发布服务 · ${esc(dev.name)}</h3>
      <div class="sub">把这台 ${esc(dev.mesh_ip || "mesh 地址")} 的某个端口经 Cloudflare 隧道映射成域名（不需要公网 IP、不开入站）</div>
      <div style="display:grid;grid-template-columns:1.4fr 1fr 0.7fr;gap:10px">
        <div><label class="dim" style="font-size:11px">根域名（来自 Cloudflare）</label>
          <select id="pZone" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0;color:var(--text)">
            <option value="">读取中…</option>
          </select></div>
        <div><label class="dim" style="font-size:11px">子域名（可空 = 用根域名）</label>
          <input id="pSub" placeholder="nas" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0"></div>
        <div><label class="dim" style="font-size:11px">端口</label>
          <input id="pPort" placeholder="8080" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0"></div>
      </div>
      <div class="dim" style="font-size:11px">将发布为：<span class="mono" id="pPreview">—</span> → <span class="mono">http://${esc(dev.mesh_ip || "10.88.0.x")}:端口</span></div>
      <div id="pOut"></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">关闭</button>
        <button class="btn primary" data-act="gen">发布到 Cloudflare</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;

  const zoneEl = mask.querySelector("#pZone");
  const subEl = mask.querySelector("#pSub");
  const portEl = mask.querySelector("#pPort");
  const preview = () => {
    const z = zoneEl.value;
    const sub = (subEl.value || "").trim().replace(/^\.+|\.+$/g, "");
    mask.querySelector("#pPreview").textContent = z ? (sub ? `${sub}.${z}` : z) : "（先选根域名）";
  };
  subEl.oninput = preview;
  portEl.oninput = preview;
  zoneEl.onchange = preview;

  api("/api/cf/zones").then(z => {
    zoneEl.innerHTML = z.zones && z.zones.length
      ? z.zones.map(x => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join("")
      : `<option value="">（读不到域名：${esc(z.hint || "Token 缺 Zone 权限")}）</option>`;
    preview();
  }).catch(() => { zoneEl.innerHTML = '<option value="">读取失败</option>'; });

  mask.querySelector('[data-act="gen"]').onclick = async () => {
    const out = mask.querySelector("#pOut");
    const zone = zoneEl.value;
    const sub = (subEl.value || "").trim().replace(/^\.+|\.+$/g, "");
    const port = Number(portEl.value);
    if (!zone) return toast("先选一个根域名", true);
    if (!port) return toast("填端口", true);
    const hostname = sub ? `${sub}.${zone}` : zone;
    const backend = `http://${dev.mesh_ip}:${port}`;
    out.innerHTML = '<div class="dim" style="font-size:11px;margin:8px 0">写入中…（建隧道 → 写 ingress → 改 DNS）</div>';
    try {
      const r = await api("/api/tunnels/publish", { method: "POST", body: JSON.stringify({ hostname, backend }) });
      out.innerHTML = `
        <div style="font-size:11.5px;margin:8px 0;line-height:1.85">
          <div>域名：<span class="mono">${esc(r.hostname)}</span> → <span class="mono">${esc(r.backend)}</span></div>
          <div>隧道：<span class="mono">${esc(r.tunnelName)}</span></div>
          <div>DNS：${r.dns === "ok" ? '<span style="color:var(--ok)">已指向 Cloudflare</span>' : '<span style="color:var(--bad)">未修改：' + esc(r.dnsError || "跳过") + "</span>"}</div>
        </div>
        ${r.command ? `<div class="dim" style="font-size:11px">在控制台那台起连接器（共用 awamesh 的网络命名空间）：</div><div class="code">${esc(r.command)}</div>
          <div class="dim" style="font-size:11px">或写进 compose：</div><div class="code">${esc(r.compose || "")}</div>` : ""}`;
      toast("已发布 " + r.hostname);
    } catch (e) {
      out.innerHTML = `<div style="font-size:11.5px;margin:8px 0;color:var(--bad)">失败：${esc(e.message)}</div>`;
    }
  };
}

/* ---------------- 一键部署：受控端只跑一条命令 ---------------- */
async function openDeploy(dev) {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>一键部署 · ${esc(dev.name)}</h3>
      <div class="sub">在目标机器上以 root 执行下面这一条，会自动装 wireguard-tools、写入配置、拉起接口、并开启对端自动同步</div>
      ${dev.hasKey === false ? `<div class="card" style="margin:0 0 10px;border-color:var(--warn)">
        <b>这台是「自助加入」的</b>
        <div class="dim" style="font-size:11.5px;margin-top:4px">私钥只在它本机，<b>下面这条 /dp/ 命令用不了</b>（服务端会返回 400）。接口已经通了的话，点「修复凭据」拿一条命令补同步即可；要重装就先用面板的「加入链接」。</div>
      </div>` : ""}
      <div id="dpBody"><div class="empty">生成中…</div></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;

  try {
    const r = await api(`/api/devices/${encodeURIComponent(dev.id)}/deploy`, { method: "POST", body: "{}" });
    mask.querySelector("#dpBody").innerHTML = `
      <div class="code">${esc(r.command)}</div>
      <div class="dim" style="font-size:11px">Endpoint ${esc(r.endpoint)} · 地址 ${esc(r.address)}${r.applied ? " · 已自动加入服务端" : " · 服务端未托管，别忘了在你自己的 WireGuard 服务端加 [Peer]"}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" data-act="copy">复制命令</button>
        <button class="btn" data-act="win">Windows 命令</button>
        <button class="btn" data-act="ts">Tailscale 兜底命令</button>
        <button class="btn" data-act="fix">修复凭据</button>
      </div>
      <div id="winBox"></div>`;
    mask.querySelector('[data-act="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(r.command); toast("已复制"); }
      catch { toast("复制失败，请手动选择", true); }
    };
    const winCmd = "irm '" + location.origin + "/dp/" + r.token + "/windows' | iex";
    mask.querySelector('[data-act="fix"]').onclick = async () => {
      try {
        const t = await api(`/api/devices/${encodeURIComponent(dev.id)}/token`, { method: "POST", body: "{}" });
        mask.querySelector("#winBox").innerHTML = `
          <div class="dim" style="font-size:11px;margin-top:10px">这台在节点侧报 401 / 不更新状态时，在它上面跑这条（只换凭据并重装同步脚本，不动接口）：</div>
          <div class="code">${esc(t.command)}</div>
          <div class="dim" style="font-size:11px">${t.reused ? "沿用了现有凭据" : "已签发新凭据（旧凭据作废）"}</div>`;
      } catch (e) { toast(e.message, true); }
    };
    mask.querySelector('[data-act="ts"]').onclick = async () => {
      try {
        const t = await api(`/api/devices/${encodeURIComponent(dev.id)}/ts-command`, { method: "POST", body: "{}" });
        mask.querySelector("#winBox").innerHTML = `
          <div class="dim" style="font-size:11px;margin-top:10px">该机器上执行（先装 tailscale；这条会让它加入 tailnet，之后面板这里会显示 TS 100.x）：</div>
          <div class="code">${esc(t.command)}</div>
          <div class="dim" style="font-size:11px">${t.installed ? "当前已上报 Tailscale 地址：" + esc(t.tsIp) : "当前还没有上报 Tailscale 地址"}</div>`;
      } catch (e) { toast(e.message, true); }
    };
    mask.querySelector('[data-act="win"]').onclick = () => {
      mask.querySelector("#winBox").innerHTML =
        '<div class="dim" style="font-size:11px;margin-top:10px">Windows（管理员终端，需先装 WireGuard 客户端）：</div>' +
        '<div class="code">' + esc(winCmd) + '</div>';
    };
  } catch (e) {
    mask.querySelector("#dpBody").innerHTML = `<div class="card" style="border-color:var(--warn)"><b>还不能部署</b><div class="muted" style="margin-top:6px">${esc(e.message)}</div></div>
      <div style="margin-top:10px"><button class="btn" data-act="goto">去设置填 Endpoint</button></div>`;
    const g = mask.querySelector('[data-act="goto"]');
    if (g) g.onclick = () => { close(); S.view = "settings"; render(); };
  }
}

/* ---------------- wg（托管）：一条命令加入 ---------------- */
async function openJoinCommand() {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>添加设备</h3>
      <div class="sub">控制台已在托管 WireGuard 服务端。在目标机器上跑这一条即可，配置会自己写好</div>
      <label class="dim" style="font-size:11px">设备名（会作为节点标签）</label>
      <input id="joinHost" placeholder="router-home" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
      <label class="dim" style="font-size:11px">有效期（小时）</label>
      <input id="joinTtl" type="number" value="1" min="1" max="24" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
      <div id="joinOut"></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">关闭</button>
        <button class="btn primary" data-act="gen">生成命令</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="gen"]').onclick = async () => {
    try {
      const r = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ tag: mask.querySelector("#joinHost").value || "node", ttl: Number(mask.querySelector("#joinTtl").value) }),
      });
      const host = mask.querySelector("#joinHost").value.trim();
      const cmd = `curl -fsSL '${location.origin}/join.sh?key=${r.key}' | sh -s --${host ? ` --hostname ${host}` : ""}`;
      mask.querySelector("#joinOut").innerHTML = `
        <div class="dim" style="font-size:11px">在 OpenWrt / Linux 上执行（需 root）：</div>
        <div class="code">${esc(cmd)}</div>
        <div class="dim" style="font-size:11px">执行完这里会自动出现这台设备；密钥一次性、${esc(String(r.expiresAt ? Math.max(1, Math.round((r.expiresAt - Date.now() / 1000) / 3600)) : 1))} 小时内有效</div>`;
      mask.querySelector('[data-act="gen"]').textContent = "再生成一条";
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
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="go"]').onclick = async () => {
    try {
      const r = await api("/api/wg/sync", { method: "POST", body: JSON.stringify({ text: mask.querySelector("#wgText").value }) });
      toast(`识别 ${r.parsed} 个 peer，匹配 ${r.matched} 台设备`);
      close();
      renderView();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 添加中继 / 隧道 ---------------- */
function openAddRelay() {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>添加中继</h3>
      <div class="sub">填一台有公网地址的机器；保存后点「接入命令」，在它上面跑 derper</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label class="dim" style="font-size:11px">名称</label>
          <input id="rName" placeholder="香港 · hk-edge" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0"></div>
        <div><label class="dim" style="font-size:11px">区域</label>
          <input id="rRegion" placeholder="香港" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0"></div>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
        <div><label class="dim" style="font-size:11px">地址（域名或 IP）</label>
          <input id="rAddr" placeholder="hk.edge.example.com" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0"></div>
        <div><label class="dim" style="font-size:11px">端口</label>
          <input id="rPort" value="18444" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0"></div>
      </div>
      <label class="dim" style="font-size:11px">可见性</label>
      <select id="rVis" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
        <option value="public">公网（所有节点可选）</option>
        <option value="private">仅内网可见（如家宽）</option>
      </select>
      <div class="modal-actions">
        <button class="btn" data-act="close">取消</button>
        <button class="btn primary" data-act="ok">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="ok"]').onclick = async () => {
    try {
      await api("/api/relays", { method: "POST", body: JSON.stringify({
        name: mask.querySelector("#rName").value,
        region: mask.querySelector("#rRegion").value,
        addr: mask.querySelector("#rAddr").value,
        port: Number(mask.querySelector("#rPort").value),
        visibility: mask.querySelector("#rVis").value,
      })});
      close(); toast("已添加"); renderView();
    } catch (e) { toast(e.message, true); }
  };
}

function openAddTunnel() {
  const mask = document.createElement("div");
  mask.className = "mask";
  mask.innerHTML = `
    <div class="modal">
      <h3>添加隧道</h3>
      <div class="sub">填好点「发布到 Cloudflare」会真的建隧道、写 ingress、改 DNS；也可以只在本地面板登记</div>
      <label class="dim" style="font-size:11px">域名</label>
      <input id="tHost" placeholder="nas.example.com" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 10px">
      <label class="dim" style="font-size:11px">后端（IP 或主机:端口）</label>
      <input id="tBack" placeholder="10.88.0.5:5000" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface-2);margin:4px 0 12px">
      <div class="modal-actions">
        <button class="btn" data-act="close">取消</button>
        <button class="btn primary" data-act="ok">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.querySelector('[data-act="close"]').onclick = close;
  mask.querySelector('[data-act="local"]').onclick = async () => {
    try {
      await api("/api/tunnels", { method: "POST", body: JSON.stringify({
        hostname: mask.querySelector("#tHost").value,
        backend: mask.querySelector("#tBack").value,
      })});
      close(); toast("已在本地面板登记（没有写入 Cloudflare）"); renderView();
    } catch (e) { toast(e.message, true); }
  };

  mask.querySelector('[data-act="publish"]').onclick = async () => {
    const out = mask.querySelector("#tOut");
    out.innerHTML = '<div class="dim" style="font-size:11px;margin:8px 0">写入中…（建隧道 → 写 ingress → 改 DNS）</div>';
    try {
      const h = mask.querySelector("#tHost").value.trim();
      let b = mask.querySelector("#tBack").value.trim();
      if (b && !/^https?:\/\//.test(b)) b = "http://" + b;
      const r = await api("/api/tunnels/publish", { method: "POST", body: JSON.stringify({ hostname: h, backend: b }) });
      out.innerHTML = `
        <div style="font-size:11.5px;margin:8px 0;line-height:1.8">
          <div>隧道：<span class="mono">${esc(r.tunnelName)}</span> <span class="dim">${esc(r.tunnelId)}</span></div>
          <div>ingress：已写入 <span class="mono">${esc(r.hostname)} → ${esc(r.backend)}</span></div>
          <div>DNS：${r.dns === "ok" ? '<span style="color:var(--ok)">已指向 ' + esc(r.hostname) + '</span>' : '<span style="color:var(--bad)">未修改：' + esc(r.dnsError || "跳过") + "</span>"}</div>
        </div>
        ${r.command ? `<div class="dim" style="font-size:11px">在控制台那台起连接器（必须共用控制台的网络命名空间，否则看不到 10.88.0.0/24）：</div><div class="code">${esc(r.command)}</div>` : '<div class="dim" style="font-size:11px">拿不到连接器 token：Token 需要 Account → Cloudflare Tunnel → Write</div>'}`;
      toast("已发布到 Cloudflare");
    } catch (e) {
      out.innerHTML = `<div style="font-size:11.5px;margin:8px 0;color:var(--bad)">失败：${esc(e.message)}</div>`;
    }
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
