# awamesh Windows 一键接入（需要「管理员」终端 + 已安装 WireGuard）
# 用法：irm '@@SERVER@@/dp/@@TOKEN@@/windows' | iex
$ErrorActionPreference = "Stop"
$server = "@@SERVER@@"
$token  = "@@TOKEN@@"

$wg = Join-Path $env:ProgramFiles "WireGuard\wireguard.exe"
if (-not (Test-Path $wg)) {
  Write-Host "没找到 WireGuard：先装 https://www.wireguard.com/install/ 再重跑这条命令" -ForegroundColor Yellow
  return
}

$dir = Join-Path $env:ProgramFiles "WireGuard\Data\Configurations"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$conf = Join-Path $dir "awa0.conf"

Write-Host "==> 1/2 拉取配置"
Invoke-WebRequest -Uri "$server/api/deploy/config?token=$token" -OutFile $conf -UseBasicParsing

if (-not (Select-String -Path $conf -Pattern "^Endpoint = \S" -Quiet)) {
  Remove-Item $conf -Force
  throw "配置里的 Endpoint 是空的：先去控制台「设置 → WireGuard 服务端」填公网地址:51820"
}

Write-Host "==> 2/2 安装隧道服务 awa0"
& $wg /uninstalltunnelservice awa0 2>$null | Out-Null
& $wg /installtunnelservice $conf

Write-Host ""
Write-Host "OK 已安装隧道 awa0，回控制台刷新即可看到这台在线" -ForegroundColor Green
& $wg /tunnelservices
