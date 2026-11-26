# 变更记录

本项目遵循语义化版本；`0.x` 阶段内部结构可能调整，升级前请备份 `data/`。

## 0.4.4
- 每日自动备份：启动 30 秒后与每 24 小时把整份配置写到 `data/auto-backup/awamesh-YYYY-MM-DD.json`，
  保留最近 7 份（`AWA_AUTO_BACKUP=0` 可关），方便 rsync 到备机
- README 新增「多部署端与高可用」：域名 + 冷备 / 主备共享 data / 真多活 三档对比与接管步骤

## 0.4.3
- 节点 `awa-peers` 与中继 `awa-relay-check` 的自清理改为「连续 3 次 401」才执行；
  200 清零计数，000/502/404 一律不动 —— 控制台升级、反代重启不会误删受控端配置

## 0.4.2
- OpenWrt：自动创建 `awamesh` firewall zone（input/output/forward ACCEPT + masq + mtu_fix）与两条 forwarding，
  避免「接口起来了但外面访问不到」；卸载时一并删除 zone
- 接入前检测网段冲突（已有接口占用同一 /24 时直接中止并给出改法）

## 0.4.1
- `install.sh` 重写：端口避让（TCP/UDP）、生成并复用 `AWA_SECRET`、健康检查打印版本与首次口令、
  `awa0` 未托管时给出 `privileged` 修复命令
- `deploy.sh`：OpenWrt 检测到 `uci` 时改用 UCI 写 `awa0` + `network reload`（不再需要 `ip link`）；`opkg` 装 `kmod-wireguard`
- README 架构图重画：去掉 Headscale，标注内置 WireGuard 服务端与 cloudflared 位置

## 0.4.0
- 新增备份与迁移：`GET /api/backup/export`、`POST /api/backup/import`（覆盖 / 合并），
  导出不含后端口令，敏感字段仍由 `AWA_SECRET` 加密
- 界面重新配色（深海青）：主按钮、导航选中、链接统一走 `--accent`，深浅色各一套
- 侧栏页脚与 README 加上版权 www.akkdiy.cn

## 0.3.9
- **修复**：`docker/entrypoint.sh` 里 `if [ "\${AWA_WG_ENABLE:-1}" = "1" ]` 多了反斜杠，条件恒为假，
  容器一直以 `node`(uid 1000) 运行 → 有效能力被内核清空 → `ip link add ... type wireguard` 报
  `RTNETLINK answers: Operation not permitted`，与 `cap_add` / `privileged` 无关
- 启动日志新增 `[wg] 运行身份：uid=0（root）` / `uid=1000（非 root，能力会被清空）`
- 连通性自检返回 `uid`，界面显示运行身份；非 root 时直接给出原因

## 0.3.8
- `upgrade.sh` 先跑 `docker compose config` 校验；遇到「key already defined」自动去重
  （只保留第一份 `privileged:`，原文件备份为 `docker-compose.yml.broken-*`）

## 0.3.7
- 新增 `upgrade.sh`：一条命令升级（自动找目录、备份、pull、重建、健康检查、版本对比）
- 新增 `GET /api/update/check` 与面板「版本与升级」卡片，显示当前/最新版本与升级命令

## 0.3.6
- 设备「配置」弹层显示实时握手、rx/tx、对端是否在接口里，并给出下一步提示
- 新增 `GET /api/devices/:id/status`

## 0.3.5
- 连通性自检显示容器实际监听端口；与 Endpoint 端口不一致时直接给 compose 改法

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
