# 变更记录

本项目遵循语义化版本；`0.x` 阶段内部结构可能调整，升级前请备份 `data/`。

## 0.3.4
- 中继「从地图摘除」改为只 `docker stop`，配置保留；「删除」才彻底卸载
- `awa-relay.timer` 每 60 秒询问 `/api/relay/state`，按 `enabled` 停/启，凭据消失即卸载

## 0.3.3
- 面板删除设备时，节点在 60 秒内自清理（接口 / 配置 / 凭据 / 定时器）
- 删除弹层新增「手动卸载命令」（Linux/OpenWrt 与 Windows），节点离线也能清
- 中继接入命令注入凭据 + 自检定时器

## 0.3.2
- 修复反代（Cloudflare / Nginx）场景下部署命令带 `:18443` 导致 `Connection timed out`
- 新增「对外地址」（`public_url`）并可一键测可达
- 吊销/删除后 `/api/join/state` 返回 401，节点据此自清理
- 新增 `POST /api/devices/:id/delete`（连记录与事件一起清）

## 0.3.1
- WireGuard 服务端分「自动（部署端当服务端）」/「自定义（中继 / OpenWrt / 端口映射）」两种模式
- 新增 `GET /api/wg/check` 连通性自检（公网地址、Endpoint 是否指向本机、托管状态）
- 启动时 UDP bind 探测，WireGuard 端口被占用自动避让
- Cloudflare / Tailscale 卡片内置「怎么获取」教程与直达链接

## 0.3.0
- 角色可叠加：节点 / 中继 / 网关 / 出口 / 服务端；控制台改，节点 60 秒内跟随
- 新增 `GET /api/join/state` 下发期望状态（对端 allowed-ips + forward 开关）
- Windows 一键接入：`/dp/<token>/windows`
- 设备「发布」：`mesh_ip:port` 经 Cloudflare 隧道映射成域名
- Tailscale 兜底：WireGuard 20 秒未握手则自动接入 443
- 安全基线：CSP / CSRF 同源校验 / 登录限速 / API 限流 / 来源白名单 / 改口令后会话全部失效

## 0.2.2
- 节点上报公网地址时识别 CGNAT（`100.64/10`），自动退回 IPv6
- 控制台每 20 秒从内核学习对端真实 endpoint（NAT 常改写源端口）
- 区分「节点自报地址」与「内核学到的映射」，路径列不再恒显示直连

## 0.2.1
- 设备「一键部署」：`curl | sh` 一条命令，凭据内嵌，脚本自取配置
- 启动日志新增 NET_ADMIN 实测（`CapEff` bit 12），直指 `cap_add` 是否生效
- 修复启动顺序：先生成服务端密钥再接管接口

## 0.2.0
- 控制台自己作为 WireGuard 服务端（`awa0`），容器重建后从库恢复全部对端
- `wg show` 状态导入、吊销时同步移除 peer
- 中继真实探测（TCP）、中继镜像 `awamesh-relay`
- Cloudflare Token 面板配置（AES-GCM 加密落库）

## 0.1.0
- 首个可用版本：设备 / 中继 / 隧道 / 事件 / 设置，SQLite，单容器
