# awamesh

自托管的组网控制台：把 OpenWrt、Linux 机队和 Windows 收进一张网，顺手管住中继和 Cloudflare 隧道。

`v0.1.0` · 单容器 · 零外部依赖 · MIT · 镜像 `ghcr.io/awahello/awamesh:latest`（amd64 / arm64）

> **它不接管你现有的东西**：你 OpenWrt 上的 WireGuard、机器上的 cloudflared 全部保留，awamesh 只做「发密钥、分地址、出配置、看状态」。

---

## 现在能做什么 / 不能做什么

| 能做（真实生效） | 还不能（Roadmap 里） |
|---|---|
| 生成真实 WireGuard 密钥、按网段分配地址，输出客户端 / 服务端 / OpenWrt 三份配置 | 自动把配置推到 OpenWrt（现在要你粘贴一次） |
| 导入 `wg show` 输出，刷新真实在线、最近握手、直连标记 | 实时轮询 `wg show`（需要 agent 或 SSH） |
| 中继登记、生成 derper 部署脚本、导出 headscale 风格地图 | 自动在远端执行部署脚本 |
| 隧道登记（域名 → 内网地址）、Cloudflare 只读同步（配 Token 后） | 自动改 Cloudflare ingress / 一键回滚（v0.2） |
| 设备改名 / 吊销、事件流、健康检查、备份 | P2P 打洞与自动中继回退（要接 Headscale） |

---

## 快速开始

### 方式一：一条命令（VPS / 有 Docker 的机器）

```bash
curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/install.sh | sh
```

脚本会：检查 Docker → 检测 18443 是否被占用（占了自动后移）→ 生成随机 `AWA_SECRET` → 写 `docker-compose.yml` → 拉镜像 → 等健康检查 → 打印面板地址与首次口令。

### 方式二：compose（推荐，1Panel 也照这个贴）

```bash
mkdir -p /opt/awamesh && cd /opt/awamesh
```

```yaml
services:
  awamesh:
    image: ghcr.io/awahello/awamesh:latest
    container_name: awamesh
    cap_add: [NET_ADMIN]        # 托管 WireGuard 接口需要
    sysctls: { net.ipv4.ip_forward: "1" }
    ports:
      - "18443:18443"
      - "51820:51820/udp"
    environment:
      - AWA_SECRET=换成一串32位随机字符
      - AWA_PORT=18443
      - AWA_DATA_DIR=/data
      - AWA_BACKEND=wg          # wg=管理自己的 WireGuard（默认）| mock=演示 | headscale=待接
      - TZ=Asia/Shanghai
    volumes: ["./data:/data"]
    mem_limit: 192m
    restart: unless-stopped
```

```bash
docker compose up -d
cat data/initial-admin.txt          # 首次口令（也打印在日志里）
```

> **1Panel**：容器 → 编排 → 创建编排，名字 `awamesh`，把上面 YAML 贴进编辑器（别在终端手打 heredoc，容易丢换行），保存即可。防火墙里放行 18443。

### 方式三：源码跑（改代码时用）

```bash
git clone https://github.com/awahello/awamesh && cd awamesh
npm start            # Node >= 22.5，默认 http://127.0.0.1:18443
```

---

## 三个后端，先认清自己用的是哪个

| `AWA_BACKEND` | 数据来源 | 用途 |
|---|---|---|
| `wg`（默认） | 本地 SQLite + 你自己的 WireGuard 服务端 | 日常使用：真实设备、真实配置 |
| `mock` | 空库（加 `AWA_DEMO=1` 才灌演示数据） | 只看界面；**别当真实状态** |
| `headscale` | `headscale` CLI | 想用 Tailscale 客户端做 P2P 时（适配层已写，待联调） |

切换后重建容器：

```bash
docker compose up -d --force-recreate
```

从 `mock` 切到 `wg` 时，启动会**自动清掉**演示的设备/中继/隧道（按种子 ID 匹配，旧库也认）。mock 默认**不再**自动灌数据，想要演示数据得显式加 `AWA_DEMO=1`。

---

## 教程一：接入设备（只跑一条命令）

awamesh 自己就是 WireGuard 服务端：密钥、地址、对端全部由控制台分配，节点只负责"跑一条命令"。

**1）设置 → WireGuard 服务端**，只填一项必需：

| 字段 | 例子 | 说明 |
|---|---|---|
| Endpoint | `1.2.3.4:51820` | 你这台机器的公网地址 + wg 端口（UDP 51820 要在防火墙/安全组放行） |
| Mesh 网段 | `10.88.0.0/24` | 默认即可 |
| MTU | `1420` | 跨境丢包时改 `1280` |
| 额外下发路由 | `192.168.1.0/24` | 想通过这台访问某个内网段时填 |
| DNS | 可空 | 想用节点名互访时填 `10.88.0.1` |

> 「服务端公钥」显示的是 awamesh 自己生成的那把，不用改 —— 它就是这个 mesh 的服务端。

### 两种模式：部署端自己当服务端 / 连你自己的服务端

「设置 → WireGuard 服务端」顶部有两个按钮，点一下就知道该走哪条：

| 模式 | 什么时候用 | 你只需要做 |
|---|---|---|
| **自动 · 部署端当服务端**（默认） | 部署端有公网 IP | 什么都不用填，Endpoint 留空会自动推导成「当前访问地址:51820」 |
| **自定义 · 中继 / OpenWrt / 端口映射** | 部署端没公网；或要把公钥换成你在 OpenWrt 上的；或外部端口不是 51820 | 填 Endpoint（`公网IP:映射端口` 或 `你域名:端口`），公钥留空=用控制台的，填了=用那台机器的 |

旁边还有个 **「检测连通性」** 按钮，会告诉你四件事：

```
部署端公网地址：132.145.94.230
当前 Endpoint：132.145.94.230:51820   [指向本机]
接口托管：已接管 awa0
· Endpoint 就是本机公网地址，部署端可以自己当服务端 ✓
```

不满足条件时它会直接给可执行的下一步，例如：

- `Endpoint 是内网地址，外部节点连不上` → 填映射后的公网地址，别填 `192.168.x`
- `部署端没托管 awa0` → compose 补 `cap_add: [NET_ADMIN, SYS_MODULE]` 后 `--force-recreate`
- `还没填 Endpoint` → 会列出三条路：自动推导 / 用有公网的中继机 / 开 Tailscale 兜底

**没公网也能跑**：节点主动出站连控制台，映射照样建立；跨节点流量经控制台转发（内置中转）。UDP 走不通就落到 Tailscale（443）。

### 走 Cloudflare / Nginx 反代时：一定要填「对外地址」

界面上访问用的是 `https://awamesh.example.com`（443，无反代端口），但控制台内部监听的是 18443。生成部署命令时如果拼上 `:18443`，节点那边必然 `Connection timed out` —— **Cloudflare 只代理 80/8080/443/2053/2083/2087/8443 这些端口，18443 不在其中**。

v0.3.2 起会自动识别 `X-Forwarded-Proto` / `X-Forwarded-Host` / `CF-Ray`，反代后面生成的命令就是：

```sh
curl -fsSL --connect-timeout 10 'https://awamesh.example.com/dp/dp_xxx' | sh -s -- --iface awa0
```

不确定就手动钉死：**设置 → 对外地址** 填 `https://awamesh.akkdiy.cn`，点「测一下」它会从浏览器真实请求一次 `/api/health`。之后所有下发的命令（Linux / Windows / 兜底配置）都用这个地址。

> 反代要放行这些路径：`/dp/*`、`/join.sh`、`/api/health`、`/api/deploy/*`、`/api/join/*`。整站转发即可，它们都在同一个端口上。

### 升级部署端会不会影响受控端

**不会掉线，节点侧不需要重装。** 但要知道三个边界：

| 项目 | 升级时发生什么 |
|---|---|
| 节点接口 `awa0` | **不动**。节点上只有 `awa-peers` 每 60 秒拉一次状态，控制台重启期间最多丢一轮（60 秒），下一轮自动恢复 |
| 控制台 `awa0` | 容器重建会重建接口，启动时从库里恢复全部对端：日志 `[wg] 已恢复 N/N 个历史对端`。服务端私钥在 `data/` 里，不会变 |
| 节点凭据 | 不变。只有你在面板点「删除/吊销」或重新生成接入命令才失效 |

**唯一需要重装节点的情况**：你改了「Mesh 网段」（例如 `10.88.0.0/24` → `10.99.0.0/24`）。地址变了，节点必须重跑一次部署命令。

#### 防误删：连续 3 次 401 才自清理

早期实现里，节点只要收到一次 401 就会卸载自己 —— 万一控制台重启期间反代返回了 401，节点就被误清了。0.4.3 起：

```
每 60 秒问一次 → 200 清空计数
              → 401 计数 +1，打印「第 n/3 次，先不动本机」
              → 连续 3 次 401（≥3 分钟）才认定被删除，开始卸载
              → 其它（000/502/404）一律不动，等下一轮
```

中继的 `awa-relay.timer` 同样改成 3 次。

### 删除设备时，受控端会自己清干净

| 操作 | 控制台 | 节点（≤60 秒内） |
|---|---|---|
| 吊销 | 移除对端、作废凭据、标记 revoked | 拉状态收到 401 → 关接口、删 `/etc/wireguard/awa0.conf`、删 token、停并删 timer/cron、删 `/usr/local/bin/awa-peers` |
| 删除 | 连记录、密钥、事件一起清掉 | 同上（凭据立即失效） |
| 中继「从地图摘除」（停用） | `enabled=0`，不进 DERP 地图 | `awa-relay.timer` 收到 `enabled:false` → `docker stop awamesh-derp`，配置保留，重新启用会自动 `start` |
| 中继「删除」 | 记录与凭据一起删 | 收到 401 → `docker rm -f awamesh-derp`、删镜像、删 systemd 单元、删凭据与定时器 |

**节点离线怎么办**：点「删除」弹层里有「手动卸载命令」，Linux / OpenWrt 与 Windows 各一份，粘上去就清干净，不依赖控制台可达。

中继也是同一套：用「接入命令」装的中继会自动带一个 `awa-relay.timer`（每 60 秒问 `/api/relay/state`），凭据失效就自己 `docker rm -f` + 删 systemd 单元 + 删凭据。**在此之前装的旧中继**没有这个自检，需要手动 `docker rm -f awamesh-derp` 一次。

清理是全自动的，因为节点每 60 秒会拉一次期望状态，凭据失效的那一刻就是它执行"自毁"的时刻。日志会写：

```
awamesh: 凭据已失效（设备在控制台被删除或吊销），正在清理本机配置
awamesh: 已清理（接口、配置、定时器、凭据都已移除）
```

不想留任何痕迹就点「删除」；只想临时踢下线、还要保留历史就点「吊销」。

### 端口不会顶掉你已有的服务

| 端口 | 默认 | 冲突时 |
|---|---|---|
| 面板 | 18443 | `install.sh` 检测占用后自动往后找 |
| WireGuard | 51820/udp | **启动时自动探测**，被占用就换一个空闲端口并在日志写明 `[wg] UDP 51820 已被占用，改用 51837` |
| 中继 DERP | 18444 | 每台可在面板里单独改 |

WireGuard 端口用 UDP 探测（`bind` 试一下），所以它不会抢你已有的 `wg0`、也不会顶掉别的服务；实际用的端口会写进 Endpoint 和所有节点配置，你不需要记住它。



**2）设备 → 添加设备** → 填设备名，然后在那一行点 **「一键部署」**，得到一条命令：

```sh
curl -fsSL 'http://你的控制台:18443/dp/dp_xxxxx' | sh -s -- --iface awa0
```

这条命令是**自包含**的：凭据里绑定了这台设备，脚本自己去控制台取完整配置（含私钥、地址、服务端公钥、Endpoint），不需要你再复制粘贴任何东西。

**3）在 OpenWrt / Linux 上以 root 执行它**，脚本会：

```
① 装 wireguard-tools（apk / apt / dnf / yum / opkg 自动判断）
② 从控制台取配置写 /etc/wireguard/awa0.conf（权限 600）
③ wg-quick up（没有 wg-quick 就退回 ip link + wg setconf）
④ 上报公网地址，让别的节点能和它直连
⑤ 装 awa-peers + systemd timer / cron，每 60 秒同步一次对端表
```

**4）回到面板刷新**，那台设备变为在线。在线状态由控制台每 20 秒读一次 `wg show` 自动刷新，**不需要你手动同步**。

> 凭据长期有效、每台独立；点「吊销」或重新生成会立刻让旧命令失效。
> 也可以走更严格的方式（私钥不出节点）：设备页「添加设备 → 生成命令」用的是 `/join.sh?key=`，节点本地 `wg genkey`，只把公钥交回来。

**Windows** 也是一条命令（管理员终端，先装 WireGuard 官方客户端）：

```
irm 'http://你的控制台:18443/dp/同一串凭据/windows' | iex
```

它会把配置写到 `C:\Program Files\WireGuard\Data\Configurations\awa0.conf` 并注册成隧道服务，装完即连。

### 节点之间是直连还是走控制台？

接入时脚本会探测本机公网地址并上报，控制台把「全网 peer 列表」下发到每台节点（每 60 秒刷新一次），所以：

| 节点 | 行为 |
|---|---|
| 有公网 IP 的 VPS | 彼此 **直连**，流量不经过控制台（省带宽、延迟最低） |
| 家宽 NAT 后、能开 UPnP 或做了端口映射 | 上报映射后的公网 endpoint，也直连 |
| 完全无法入站的（对称 NAT / CGNAT） | 名单里它的 endpoint 是 `-`，流量走控制台转发兜底 |

控制台自己也是 peer（`10.88.0.1`），所以「兜底」永远存在，不会因为谁打不通就整网断。

查看某台节点当前走哪条：设备列表「路径」列显示 `直连` 或 `中继`，「出口地址」列能看到它上报的公网 endpoint（显示「经控制台」表示这台只能走兜底）。想强制排查，在节点上：

```bash
wg show awa0 endpoints          # 看对端 endpoint 是否已变成公网地址
/usr/local/bin/awa-peers        # 手动触发一次 peer 表刷新
```

### OpenWrt 上已经有 WireGuard 服务端，会冲突吗

**不冲突，但有三处要避开。** awamesh 在节点上建的是一个**独立的新接口** `awa0`（客户端），和你现有的 `wg0`（服务端）互不干扰：

| 要避开 | 为什么会撞 | 怎么处理 |
|---|---|---|
| **网段** | 你现有的 `wg0` 如果也用 `10.88.0.0/24`，两个接口抢同一条路由 → 表现是「时通时不通」 | 控制台「设置 → WireGuard 服务端 → Mesh 网段」改成 `10.99.0.0/24`，重新点一键部署。脚本现在会**先检测**，撞了直接中止并提示（本机配置不改） |
| **UDP 端口** | 现有 `wg0` 常监听 51820 | 不影响：`awa0` 是客户端，监听端口由内核随机分配，不占 51820 |
| **防火墙 zone** | OpenWrt 新建的接口默认不属于任何 zone，`input/forward` 全被拒 → 外面连不上你 | 脚本会自动建 `awamesh` zone（input/output/forward ACCEPT、masq、mtu_fix）并加两条 forwarding 与 `lan` 互通；卸载时一并删掉 |

用 UCI 装好之后，`/etc/config/network` 里会是这样，和你原有 `wg0` 两段并存：

```
config interface 'awa0'          # awamesh 建的
    option proto 'wireguard'
    ...
config wireguard_awa0
    option public_key '...'
    list allowed_ips '10.88.0.0/24'

config interface 'wg0'           # 你原有的，脚本一个字都不动
    ...
```

另外注意：**别把同一个 `192.168.1.0/24` 既发布到旧 `wg` 又勾成 awamesh 的网关角色** —— 回程路由会不对称。要发布就只在 awamesh 这边发布一次。

### 家里 OpenWrt 没有公网 IP 还能用吗

**能，而且这是常规情况。** 只有**控制台那一台**需要公网地址；OpenWrt 是客户端，只负责"向控制台拨出去"。

NAT 只挡入站、不挡出站：OpenWrt 主动发出握手，路由器就记住了这条映射，回包沿原路回来。`PersistentKeepalive = 25` 每 25 秒续一次，映射不会过期。

| 你家的网络 | 能接入 | 和其他节点直连 | 说明 |
|---|---|---|---|
| 有公网 IPv4（多数国内家宽拨号） | ✅ | ✅ | 脚本上报 `公网IP:端口` |
| 没有公网 IPv4，但有 IPv6（现在很常见） | ✅ | ✅ | 走 `[IPv6]:端口`，v6 没有 NAT，直连最稳 |
| 纯 CGNAT（运营商大内网，`100.64/10`） | ✅ | ❌ | 脚本会自动退回 IPv6；没有 v6 就经控制台转发 |
| UDP 全被封（公司/酒店/校园网） | ⚠️ | ❌ | 需要额外 DERP 中继走 443，见「教程二」 |

怎么判断自己在哪一档 —— 在 OpenWrt / 节点上：

```sh
curl -s https://api.ipify.org; echo            # 拿到的公网 IP
ip -6 addr show scope global | grep inet6      # 有没有全局 IPv6
```

- 公网 IP 不是 `100.64.x ~ 100.127.x`，也不是内网段 → 第一档
- 上面那条没显示 v6、公网 IP 又是 `100.64/10` → 纯 CGNAT，P2P 放弃，走控制台
- 有 v6 → 即使 v4 是 CGNAT 也能直连（脚本已自动优先 v6）

> 控制台每 20 秒读一次 `wg show`，**从内核看到对端真实的 `IP:端口`**（NAT 常会改写源端口，节点自己上报的往往不准）。所以就算上报值有偏差，控制台这一跳也一定是通的；台面上「出口地址」列显示的是节点自己上报的值，用来判断它有没有直连条件。

**CGNAT 下的实际体验**：能正常用、能访问家里所有设备（`192.168.1.0/24` 走子网路由），只是跨网流量要经控制台绕一圈 —— 家庭上行带宽就是上限。要提升的话两条路：给家里开 IPv6（最优，免费），或者接受经控制台转发。

### 没有 NET_ADMIN 怎么办（最常见的一步卡点）

`[wg] 接管失败，回退到手动模式：... Operation not permitted` 说明容器没拿到建接口的权限。v0.2.1 起启动日志会直接告诉你卡在哪：

```
[wg]   ✗ 容器实际没有 NET_ADMIN —— compose 的 cap_add 没生效
[wg]     改完 compose 必须重建容器：docker compose up -d --force-recreate（restart 不会应用新权限）
```

按这个顺序试，**每步都要 `up -d --force-recreate`**：

```yaml
# 1) 最小权限（推荐）
    cap_add: [NET_ADMIN, SYS_MODULE]
    sysctls: { net.ipv4.ip_forward: "1" }
```

```yaml
# 2) 还不行：一次验证用 privileged（通了再收回来）
    privileged: true
```

```bash
# 3) 宿主机内核确认有 wireguard 模块
modprobe wireguard && lsmod | grep wireguard
docker info | grep -i rootless     # 应为 false，rootless 下 NET_ADMIN 无效
```

`privileged: true` 还起不来，基本就是内核没有 wireguard 模块（LXC/OpenVZ 小鸡常见），这种情况换一台 KVM 的机器，或者继续用手动模式。

### 如果没有 NET_ADMIN（纯面板模式）

控制台检测不到 wg 命令或建不了接口时，会退回"手动模式"：添加设备直接给你三份内容（客户端配置 / 服务端 `[Peer]` / OpenWrt UCI），你粘到自己的 WireGuard 服务端。此时靠「同步状态」粘 `wg show` 刷新。

## 角色：一台机器可以同时干几件事

设备列表里每台都有「角色」按钮，勾选即生效 —— 控制台会在 60 秒内把变更下发到节点（`awa-peers` 每 60 秒拉一次期望状态）。

| 角色 | 做的事 | 对节点的影响 |
|---|---|---|
| **节点** | 拿 `10.88.0.x`，和其他设备互通 | 必选，无法取消 |
| **中继** | 打洞失败时给别的节点转发 | 面板生成 DERP 部署命令（Docker 一条） |
| **网关** | 把它所在的局域网发布进 mesh | 勾上并填网段后，节点的 `ip_forward` 自动打开，其他节点路由里出现该网段 |
| **出口** | 可作为全流量出口 | 仅标记 + 展示，客户端侧自选 |
| **服务端** | 承载对外服务，配合 CF 隧道 | 仅标记，便于筛选 |

关键点：**角色是控制台的属性，不是节点的配置文件**。你在面板改，节点下次拉状态时自动跟随，不需要登录那台机器。
网段（`192.168.1.0/24`）填在「角色」弹窗里，会同时写进控制台和所有节点的对端 `AllowedIPs` —— 所以「谁能访问哪个网段」完全由控制台决定。

控制台自己（部署端）同样是这五种角色的组合：它默认是**服务端 + 内置中转**，你也可以给它加「网关」把机房内网发布出来。

## 把服务发布到公网（Cloudflare 隧道）

任意一台设备（OpenWrt / Linux / 控制台）都能把自己的端口映射成域名，**不需要公网 IP、不开入站**：

设备行 →「发布」→ 填域名 + 端口，会得到两份东西：

```yaml
# 1. 隧道 ingress（config.yml 或 Dashboard → Public Hostname）
ingress:
  - hostname: nas.example.com
    service: http://10.88.0.5:8080
  - service: http_status:404
```

```bash
# 2. 在 mesh 内任意一台机器上起 cloudflared（必须 host 网络才能看到 10.88.0.0/24）
docker run -d --name cf-nas --restart unless-stopped \
  --network host \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <CF_TUNNEL_TOKEN>
```

一条隧道可以为整张网发布任意多个服务 —— 加服务只改 ingress，不用再给目标机器装 cloudflared。

## 兜底：UDP 被封时用 Tailscale

WireGuard 走 UDP。公司网络、酒店、校园网经常只放行 443/TCP，这时隧道建不起来。三层兜底：

| 层 | 用什么 | 前提 |
|---|---|---|
| L1 | WireGuard 直连 | 出站 UDP 51820 放行（多数网络） |
| L2 | 自建 DERP 中继（443/18444） | 一台有公网的 VPS |
| L3 | **Tailscale / Headscale** | 一个 authkey |

L3 的配置在「设置 → 兜底通道 · Tailscale」：填 authkey（`tskey-auth-…`，生成时勾 reusable），自建 Headscale 再填 Login Server。

填了之后，节点部署脚本会这样跑：

```
先起 WireGuard → 等 20 秒握手
  ├ 握上了：正常，不做任何多余动作
  └ 没握上：自动装 tailscale、用控制台给的 authkey 加入网络，走 443 的 DERP
```

authkey 只在节点接入那一刻下发，不写进节点上的任何配置文件；想停就在面板点「关闭兜底」。

## 安全

自用也要设防，这几项是内建的，不需要额外配置：

| 项 | 做法 |
|---|---|
| 会话 | HMAC 签名 + `HttpOnly` + `SameSite=Strict`，反代 HTTPS 时自动加 `Secure` |
| 改口令 | 设置 → 安全；改完 **session_epoch +1，所有已登录会话立即失效** |
| 登录爆破 | 每 IP 每分钟 5 次，超过返回 429 并记事件 |
| CSRF | 所有写操作校验 Origin/Referer 与 Host 同源，跨站直接 403 |
| 响应头 | CSP（禁内联脚本）、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer` |
| 接口限流 | 面板 API 每 IP 每分钟 600 次；`/api/join` 每 IP 每分钟 20 次 |
| 节点凭据 | 一次性接入密钥（哈希存库、用完即废）；部署凭据可重生成、可吊销 |
| 敏感配置 | Cloudflare Token / Tailscale authkey 用 AES-256-GCM 加密落库，密钥来自 `AWA_SECRET` |
| 私钥 | 控制台不存节点私钥（自助加入的节点私钥只在本机）；服务端私钥落在 `data/wg-server.key`（600） |
| 审计 | 登录成败、改口令、加删设备/中继/隧道、发布、角色变更全部进事件表 |

想再加一层，用环境变量：

```yaml
      - AWA_ALLOW_CIDR=1.2.3.0/24,10.0.0.0/8   # 只允许这些网段访问面板
      - AWA_TRUST_PROXY=1                       # 反代后置 1，才读 X-Forwarded-For
      - AWA_COOKIE_SECURE=1                     # 强制 Cookie 带 Secure（反代没传 proto 时用）
      - AWA_SESSION_DAYS=3                      # 会话有效期，默认 7 天
```

`AWA_SECRET` 一定要换成 32 位以上随机串，写成示例值时启动会告警：

```bash
sed -i "s/AWA_SECRET=.*/AWA_SECRET=$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')/" docker-compose.yml
```

> 换 `AWA_SECRET` 会让已加密的 Cloudflare Token / Tailscale authkey 解不开，换完重填一次。

## 教程二：中继（默认已有内置中转）

控制台自己就是**默认中转**：两台节点打不通时，流量经控制台转发 —— 这部分**不需要任何部署**，中继页里那条「本机 · 控制台」就是它（标「内置」，不能删）。

只有当 **UDP 也被封**、连控制台都连不上时，才需要额外的 DERP 中继（HTTPS 443 转发）。这时再往下看：



中继（DERP）用于「打洞失败时兜底」，走 HTTPS 端口，穿墙最稳。

**1）面板 → 中继节点 → 添加中继**

| 字段 | 例子 |
|---|---|
| 名称 / 区域 | `香港 · hk-edge` / `香港` |
| 地址 | `hk.edge.example.com`（域名或 IP） |
| 端口 | `18444`（默认；只有确认目标网络**只放行 443** 才改 443，同时把那台机的 nginx/cloudflared 挪走） |
| 可见性 | 公网 / 仅内网（家宽选后者，别让公网节点选它） |

**2）点该卡片的「接入命令」**，脚本贴到那台机器上以 root 执行（装 `derper` + systemd）。等价手工命令：

```bash
go install tailscale.com/cmd/derper@latest
cp "$(go env GOPATH)/bin/derper" /usr/local/bin/derper

cat >/etc/systemd/system/derper.service <<'EOF'
[Unit]
Description=awamesh DERP relay
After=network-online.target
[Service]
ExecStart=/usr/local/bin/derper -a :18444 -stun -hostname=hk.edge.example.com
Restart=always
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable --now derper
curl -fsS http://127.0.0.1:18444/ >/dev/null && echo "中继本地可达"
```

**3）点「中继地图」** 导出 `derp.yaml`（headscale 风格），即客户端可选的中继集合。

---

## 教程三：添加隧道（Cloudflare）

**1）面板 → Cloudflare 隧道 → 添加隧道**：填域名 + 后端（如 `10.88.0.5:5000`）。这一步只是登记，便于和 Cloudflare 上的配置对照。

**2）要和 Cloudflare 真实同步**：设置 → Cloudflare，粘贴只读 Token（加密存本地库，面板里也能清除）

```
权限只需：Account:Tunnel:Read + Zone.DNS:Read
```

保存后点「测试连接」会列出你的账户；再回隧道页点「从 Cloudflare 同步」，会拉隧道、连接器状态与 ingress 规则落库。

**3）把 Cloudflare 的 ingress 指到 mesh**（手工，v0.2 做成按钮）：

```yaml
tunnel: awamesh
ingress:
  - hostname: blog.example.com
    service: http://10.88.0.1:8080      # ← 从 localhost 改成 mesh 地址
  - hostname: nas.example.com
    service: http://10.88.0.5:5000
  - service: http_status:404
```

`cloudflared` 会自动热加载。**注意**：cloudflared 跑在 Docker 里时默认看不到 `10.88.0.0/24` —— 用 `network_mode: host`，或在容器里加一条指向 wg/tailscale 接口的静态路由。

---

## 备份与迁移

控制台里的所有配置（设备、对端、中继、隧道、接入密钥、设置）都能一次性导出，换机器时导入即可：

**设置 → 备份与迁移**：

| 操作 | 说明 |
|---|---|
| 导出配置（.json） | 下载 `awamesh-backup-YYYYMMDD.json`；**不含后端口令**，敏感字段（CF Token / Tailscale authkey / 服务端私钥）用 `AWA_SECRET` 加密 |
| 导入 · 覆盖 | 用备份里同类数据替换当前数据（换机器时选这个） |
| 导入 · 只补不覆盖 | 保留现有、只补缺失（合并多份备份时用） |

命令行等价：

```bash
# 导出（Cookie 换成你登录后的）
curl -s -b "awa_session=..." http://127.0.0.1:18443/api/backup/export -o backup.json

# 导入
curl -s -b "awa_session=..." -X POST http://127.0.0.1:18443/api/backup/import \
  -H "Content-Type: application/json" \
  -d "{\"bundle\": $(cat backup.json), \"mode\": \"replace\"}"
```

两个必须知道的点：

1. **导入端必须用同一个 `AWA_SECRET`**，否则 `enc_*` 字段解不开（Cloudflare Token、Tailscale authkey、服务端私钥都在里面）。导出文件里已经写了这条说明。
2. **后端口令永远不会被导入覆盖**，也不会出现在导出文件里 —— 这是故意的，避免备份文件泄露后台。

## 更新（升级到新版本）

**以后升级都用这一条，不用记版本号：**

```bash
curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/upgrade.sh | sh
```

它会自己找目录（当前目录 → `/opt/awamesh`）、备份 `data/`、`pull` + `--force-recreate`、等健康检查通过，最后打印「旧版本 → 新版本」和 `[wg]` 状态。加 `--dir /你的/目录` 可指定位置，`--no-backup` 跳过备份。

面板里也有：**设置 → 版本与升级**，会显示当前版本 / 最新版本，并给出「复制升级命令」，有新版本时标题会标出来。

镜像 tag 固定是 `latest`，**`docker compose up -d` 不会自动换镜像**，必须显式 `pull`：

```bash
cd /opt/awamesh
tar czf backup-$(date +%F).tgz data        # 先备份：配置、密钥、首次口令都在 data/
docker compose pull
docker compose up -d --force-recreate
curl -s localhost:18443/api/health         # {"ok":true,"version":"0.3.4"}
docker compose logs --tail 20 awamesh | grep -E "\[wg\]|已启动"
```

三条命令跑完还是旧版（`version` 没变）？按顺序清一遍：

```bash
docker compose down
docker image rm -f ghcr.io/awahello/awamesh:latest
docker compose pull && docker compose up -d
curl -s localhost:18443/api/health
```

页面还是旧界面？静态资源带 `?v=版本号`，正常刷新就行；顽固的话 `Ctrl+Shift+R` 强刷或开无痕。**左下角显示的 `v0.3.4` 是最直接的判据。**

### 从旧版本升级后要做的一次性动作

| 从哪版升上来 | 必须做什么 |
|---|---|
| < 0.3.4 | 中继如果是早前装的，先在那台机器 `docker rm -f awamesh-derp`，再在面板「中继 → 删除 → 添加 → 接入命令」重装（新版才有自动卸载） |
| < 0.3.2 | 面板 → **设置 → 对外地址** 填 `https://你的域名` 并点「测一下」；然后每台设备重新点「一键部署」拿新命令（旧命令里的地址带 `:18443`，过 CF 会超时） |
| < 0.3.0 | 节点上重跑一次接入命令（新版会装每 60 秒的对端同步与自清理） |
| < 0.2.0 | 没有可回滚的必要，直接按上面重装最省事 |

**升级后自检三件事**：

```bash
# 1) 版本对不对
curl -s localhost:18443/api/health

# 2) 接口有没有被接管（应看到 [wg] 已接管接口 awa0）
docker compose logs --tail 30 awamesh | grep "\[wg\]"

# 3) 生成的部署命令是不是 https 且不带端口
#    面板 → 设备 → 一键部署，命令里不应出现 :18443
```

### 版本历史

| 版本 | 主要变化 |
|---|---|
| **0.4.3** | 节点/中继自清理改为「连续 3 次 401」才执行，升级或反代抖动不会误删受控端 |
| **0.4.2** | OpenWrt 上自动建 firewall zone（否则 forward 全被拒）；开始前检测网段冲突并中止；卸载时一并清理 zone |
| 0.4.1 | `install.sh` 重写为一键安装；OpenWrt 改用 UCI 配置 `awa0`；架构图对齐实现 |
| **0.4.0** | 备份与迁移（导出/导入整份配置）；全新「深海青」配色；页脚版权 www.akkdiy.cn |
| 0.3.9 | 修入口脚本条件写错导致容器永远以非 root 运行（即使 `privileged` 也建不了 `awa0`）；启动日志打印运行身份 uid |
| 0.3.8 | `upgrade.sh` 先校验 compose，自动修复重复的 `privileged` 键（原文件留 `.broken` 备份） |
| **0.3.7** | 一键升级脚本 `upgrade.sh`；面板「版本与升级」显示最新版本与升级命令 |
| 0.3.6 | 设备「配置」弹层显示实时握手/收发字节（不用登机器判断通没通） |
| 0.3.5 | 连通性自检显示实际监听端口，端口与 Endpoint 不一致时给出 compose 改法 |
| 0.3.4 | 中继「停用」只停容器、「删除」才卸载；`awa-relay.timer` 自检 |
| 0.3.3 | 面板删除后机器端自动卸载（设备 + 中继），离线可复制手动卸载命令 |
| 0.3.2 | 修反代场景部署命令带错端口（CF 不代理 18443）；新增「对外地址」；吊销/删除后节点收到 401 自动清理 |
| 0.3.1 | WireGuard 卡片分「自动 / 自定义」两种模式；连通性自检；UDP 端口自动避让；Cloudflare/Tailscale 卡片内置获取教程 |
| 0.3.0 | 角色可叠加（节点/中继/网关/出口/服务端）；Windows 一键接入；CF 隧道发布；Tailscale 兜底；安全基线（CSRF/限速/CSP/改口令即失效） |
| 0.2.2 | 无公网也能接入：CGNAT 判定 + IPv6 优先 + 内核学到的真实 endpoint |
| 0.2.1 | 一键部署（受控端一条 `curl \| sh`）；NET_ADMIN 自检 |
| 0.2.0 | 控制台自己当 WireGuard 服务端；`wg show` 状态导入 |

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

**中继节点单独更新**（那台如果是用 Docker 跑 derper）：

```bash
docker pull ghcr.io/awahello/awamesh-relay:latest
docker rm -f awamesh-derp
docker run -d --name awamesh-derp --restart unless-stopped \
  -p 18444:18444 -p 18444:18444/udp --entrypoint derper \
  ghcr.io/awahello/awamesh-relay:latest -a :18444 -stun -hostname 你的中继域名
```

更新须知：

| 事项 | 说明 |
|---|---|
| 数据安全 | 全部在 `./data`（SQLite + 服务端密钥 + 首次口令），换镜像不影响；备份就是打包这个目录 |
| `AWA_SECRET` | **不要顺手改** —— 改了已加密的 Cloudflare Token / Tailscale authkey 会解不开，需要重填 |
| 端口变更 | 面板默认 18443、中继 18444；WireGuard 的 UDP 端口会自动避让，看日志里的实际值 |
| 权限 | compose 里的 `cap_add: [NET_ADMIN, SYS_MODULE]` 别丢，丢了会退回"手动配置"模式 |
| 回滚 | 备份的 `data/` 解回原处 + 用旧版本 tag 起容器即可 |

## 命令速查

**部署与运维**

```bash
docker compose pull && docker compose up -d --force-recreate   # 升级 / 改配置后重建
docker compose logs --tail 30 awamesh                          # 看日志（含首次口令）
cat data/initial-admin.txt                                     # 首次口令
sudo chown -R 1000:1000 ./data                                 # 数据目录属主修复
tar czf awamesh-backup-$(date +%F).tgz data                    # 备份（配置 + 密钥全在里面）
curl -s localhost:18443/api/health                             # 健康检查
```

**忘记口令（重置）**

```bash
docker compose exec awamesh node --no-warnings -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/awamesh.db');db.prepare('delete from settings where key=?').run('admin_credential');console.log('cleared')"
docker compose restart awamesh && docker compose logs --tail 20 awamesh
```

**接入节点**

```bash
# 在节点上（OpenWrt / Linux，root）
curl -fsSL 'http://控制台:18443/join.sh?key=awa_xxx' | sh -s -- --hostname router-home

# 已接入过的节点重跑（同一 --iface 会覆盖配置）
curl -fsSL 'http://控制台:18443/join.sh?key=awa_yyy' | sh -s -- --iface awa0
```

**WireGuard**

```bash
wg show                              # peer、握手、流量
wg show wg0 latest-handshakes        # 只看握手时间戳
wg show wg0 endpoints                # 对端当前 endpoint（判断直连还是经 NAT）
wg genkey | tee c.key | wg pubkey    # 手工生成一对（awamesh 不需要）
wg-quick down wg0 && wg-quick up wg0 # 改配置后重启接口
```

**OpenWrt**

```sh
ifup wg0                       # 只重启 wg 接口
/etc/init.d/network reload     # 整体网络重载
logread | grep -i wireguard    # 握手与错误
```

**Cloudflare**

```bash
cloudflared tunnel list
cloudflared tunnel info awamesh
cloudflared tunnel ingress validate     # 改完 ingress 先校验
```

---

## 安装排障

**容器一直重启** —— 先看日志，90% 是这三种：

```bash
docker compose logs --tail 50 awamesh
```

| 日志特征 | 原因 | 修复 |
|---|---|---|
| `EACCES` 或「数据目录不可写」 | 宿主机 `./data` 属主 root，容器以 `node`(1000) 运行 | `sudo chown -R 1000:1000 ./data` |
| 「AWA_DATA_DIR 含换行或制表符」 | 终端粘贴 heredoc 丢换行，两行环境变量粘成一行 | 重写 compose，或用 1Panel 编辑器 |
| `EADDRINUSE` | 18443 被占用 | 同时改 `ports` 与 `AWA_PORT` |
| `[wg] 接管失败：Operation not permitted` | ① 容器缺 `NET_ADMIN`；② **进程不是 root**（加了 privileged 也没用，非 root 的有效能力会被内核清空）；③ 内核没有 wireguard 模块 | 先看日志里 `[wg] 运行身份：uid=?` —— 是 `uid=1000` 就升级到 **0.3.9+**（0.3.9 之前入口脚本有 bug，永远降权）；是 `uid=0` 就补 `cap_add` / `modprobe wireguard` |
| 加了 `privileged: true` 还是 `Operation not permitted` | 0.3.8 及更早版本的入口脚本里，判断 `AWA_WG_ENABLE` 的那个变量引用多写了一个反斜杠，条件恒为假 → 永远 `su-exec node`（降权） | 升级到 0.3.9；临时绕过：compose 里加 `entrypoint: ["node","--no-warnings","src/server.js"]` |
| 更新后版本号没变 | tag 是 `latest`，`up -d` 不会自动换镜像 | 见「更新」章节的三条命令 |

**看到的还是演示数据**：检查 compose 里是否还写着 `AWA_BACKEND=mock`，改成 `wg` 后 `up -d --force-recreate`。

**设备列表是空的**：`wg` 模式不预置数据，点「添加设备」创建第一台。

---

## 架构

```mermaid
flowchart TB
  B["浏览器（面板）<br/>https://你的域名 或 内网 IP:18443"]

  subgraph CTL["控制台（1 台：VPS 或 NAS）"]
    A["awamesh<br/>Node 22 + SQLite<br/>面板 / 编排 / 观测 / 备份"]
    S["内置 WireGuard 服务端<br/>awa0 · 10.88.0.1/24 · udp 51820<br/>（容器内自己起，不依赖 Headscale）"]
    A --- S
  end

  subgraph LNX["Linux 机队（N 台 VPS）"]
    S1["seoul-vps<br/>节点 + 中继"]
    S2["hk-edge<br/>节点 + 中继"]
    S3["db-01<br/>节点 / 网关"]
  end

  subgraph HOME["家里（大陆）"]
    R["router-home · OpenWrt<br/>节点 + 子网网关<br/>192.168.1.0/24"]
  end

  W["win-laptop · Windows<br/>节点"]

  subgraph CF["Cloudflare 边缘"]
    E["DNS · TLS 终止 · CDN 缓存"]
    T["隧道（cloudflared 主动出站）"]
  end

  V["公网访客"]

  B ==>|HTTPS 443| A
  A -.->|"只读同步：隧道 / ingress 对账"| CF

  S <==>|"WG 直连（P2P）"| S1
  S <==>|"WG 直连"| S2
  S <==>|"WG 直连"| S3
  S <==>|"WG 直连"| R
  S <==>|"WG 直连"| W

  R -->|"cloudflared（也可放在任意一台 mesh 机器上）"| T
  T --> E
  E --> V
  V -.->|"访问 blog.example.com"| E```

**四种角色，一台机器可叠加**

| 角色 | 谁承担 | 作用 |
|---|---|---|
| 节点 | 所有设备 | 拿到 `10.88.0.x`，彼此互通 |
| 中继 | seoul-vps、hk-edge、家宽 | 打洞失败时转发（DERP，默认 18444） |
| 网段网关 | router-home、任意 Linux | `allowed_ips` 带 LAN 段，把家里/机房网段发布进 Mesh |
| 出口 | 任意一台 | 作为全流量出口（客户端侧选择） |

**Cloudflare 的三重身份**：公网发布入口（cloudflared 出站，不开入站）· DNS/TLS/CDN · 观测对象（只读 Token 对账）。

数据面与控制面分离：**流量走 WireGuard，只有编排和观测经过控制台**，awamesh 自己不转发用户流量。

---

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AWA_PORT` | 18443 | 面板端口（改时 compose 的 `ports` 要一起改） |
| `AWA_HOST` | 0.0.0.0 | 监听地址 |
| `AWA_DATA_DIR` | `/data` | 数据目录（SQLite + 密钥 + 首次口令） |
| `AWA_SECRET` | 自动生成落盘 | 会话签名、凭证存储 |
| `AWA_BACKEND` | wg | `wg` / `mock` / `headscale` |
| `AWA_RELAY_PORT` | 18444 | 中继默认端口（每台可在面板覆盖） |
| `AWA_MESH_CIDR` | 10.88.0.0/24 | Mesh 网段 |
| `AWA_MESH_DOMAIN` | mesh | MagicDNS 后缀 |
| `AWA_MTU` | 1420 | WireGuard MTU |
| `AWA_EVENT_KEEP_DAYS` | 30 | 事件保留天数 |
| `AWA_CF_TOKEN` | 空 | Cloudflare 只读 Token（同步隧道） |
| `AWA_MODE` | full | `tiny` 降低内存占用 |

---

## 自测

```bash
npm test          # 三套全跑，共 68 项
npm run selftest     # 21 项：鉴权、设备、密钥、接入脚本、中继开关、隧道同步、404
npm run test:deploy  # 29 项：一键部署凭据、反代命令不带端口、对外地址、吊销/删除 401、卸载命令、中继自检
npm run test:security # 18 项：CSP/X-Frame、CSRF、登录限速、改口令即失效、角色与网段、发布、兜底配置校验
```

三套都是**拉起临时实例 + 随机端口 + 临时数据目录**，跑完自动清理，不会碰你的 `data/`。

---

## Roadmap

| 版本 | 内容 |
|---|---|
| v0.1（当前） | wg 后端（真实设备 / 配置 / 状态导入）、中继与隧道 CRUD、安装与排障文档 |
| v0.2 | 隧道 ingress 改指与回滚、`wg show` 定时轮询（agent 或 SSH）、备份恢复界面 |
| v0.3 | 接 Headscale 做 P2P 打洞、中继自动下发、Postgres 选项 |
| 之后 | 直连率分组统计、出口节点管理、Telegram 通知 |

---

## FAQ

**Q：必须装 Headscale 吗？**
不用。默认 `wg` 后端直接管你现有的 WireGuard 服务端，真实可用；Headscale 只是为了拿到 Tailscale 那套打洞能力。

**Q：和 headscale-admin / headplane 的区别？**
它们只做 Headscale 的 UI；awamesh 把「设备 / 中继 / Cloudflare 隧道 / 现有 WG 共存」放在一个面板，且不依赖 Tailscale 客户端就能用。

**Q：端口冲突怎么办？**
面板默认 18443、中继默认 18444。改端口时 `ports` 与 `AWA_PORT` 必须一致；`install.sh` 会自动检测占用并往后找。

**Q：OpenWrt 没有公网 IP 能用吗？**
能。NAT 只挡入站：OpenWrt 主动向服务端/中继建连后，双向就通了。有 IPv6 直连率最高；对称 NAT 或 UDP 被封时走中继。

**Q：会消耗多少内存？**
控制台空载约 50–60MB；中继几乎不吃 CPU 只吃带宽。

---

## 版权

界面与代码 © [www.akkdiy.cn](https://www.akkdiy.cn) · MIT License（见下方）

## License

MIT
