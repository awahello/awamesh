#!/bin/sh
# awamesh 通用升级脚本（以后升级都用这一条，不用记版本）
#   curl -fsSL https://raw.githubusercontent.com/awahello/awamesh/main/upgrade.sh | sh
# 可选参数：--dir /opt/awamesh  --no-backup
set -u

DIR=""
NO_BACKUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --no-backup) NO_BACKUP=1; shift ;;
    *) shift ;;
  esac
done

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 1) 找目录：显式 --dir > 当前目录 > /opt/awamesh
if [ -z "$DIR" ]; then
  if [ -f ./docker-compose.yml ] || [ -f ./compose.yml ]; then
    DIR="$(pwd)"
  elif [ -f /opt/awamesh/docker-compose.yml ]; then
    DIR=/opt/awamesh
  else
    die "找不到 docker-compose.yml：用 --dir 指定目录，例如 sh upgrade.sh --dir /opt/awamesh"
  fi
fi
cd "$DIR" || die "进不去 $DIR"

command -v docker >/dev/null 2>&1 || die "没有 docker"
DC="docker compose"
docker compose version >/dev/null 2>&1 || {
  command -v docker-compose >/dev/null 2>&1 && DC="docker-compose" || die "没有 docker compose"
}

say "目录：$DIR"

# 2) 备份 data/
if [ "$NO_BACKUP" = "0" ] && [ -d ./data ]; then
  B="backup-$(date +%F-%H%M).tgz"
  tar czf "$B" data 2>/dev/null && ok "已备份 data/ → $B" || warn "备份失败（继续）"
fi

# 3) 记录旧版本
old_ver="$($DC exec -T awamesh node -e 'fetch("http://127.0.0.1:18443/api/health").then(r=>r.json()).then(j=>console.log(j.version)).catch(()=>{})' 2>/dev/null | tr -d '\r\n')"
[ -n "${old_ver:-}" ] && say "当前版本：$old_ver" || say "当前版本：未知（容器可能没在跑）"

# 4) 拉镜像 + 重建
say "拉取镜像"
$DC pull || die "拉取失败：检查网络或 GHCR 可达性"

say "重建容器（--force-recreate，restart 不会换镜像）"
$DC up -d --force-recreate || die "启动失败：看 $DC logs --tail 30 awamesh"

# 5) 等健康检查
say "等待健康检查"
i=0
new_ver=""
while [ "$i" -lt 30 ]; do
  sleep 2
  i=$((i + 1))
  new_ver="$($DC exec -T awamesh node -e 'fetch("http://127.0.0.1:'"${AWA_PORT:-18443}"'/api/health").then(r=>r.json()).then(j=>console.log(j.version)).catch(()=>{})' 2>/dev/null | tr -d '\r\n')"
  [ -n "${new_ver:-}" ] && break
done

echo
if [ -n "${new_ver:-}" ]; then
  if [ "${old_ver:-}" = "$new_ver" ]; then
    warn "版本没变（$new_ver）—— 可能本地缓存了旧镜像，执行清一遍："
    echo "    $DC down && docker image rm -f ghcr.io/awahello/awamesh:latest && $DC pull && $DC up -d"
  else
    ok "已升级：${old_ver:-?} → $new_ver"
  fi
else
  warn "健康检查没通过，看日志：$DC logs --tail 40 awamesh"
fi

echo
say "接口状态"
$DC logs --tail 20 awamesh 2>/dev/null | grep -F "[wg]" || warn "日志里没有 [wg] 行，可能未托管（见设置页「检测连通性」）"

echo
echo "面板：http://$(hostname -I 2>/dev/null | awk '{print $1}'):${AWA_PORT:-18443}"
echo "页面看着没变就 Ctrl+Shift+R 强刷"
