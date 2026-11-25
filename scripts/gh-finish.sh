#!/bin/sh
# 等设备授权 → 建仓 → 推送 → 清 token
# 用法：sh scripts/gh-finish.sh [最多轮询秒数]
set -e

TRIES="${1:-50}"
DEV=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".gh-device.json","utf8")).device_code)')
CLIENT="178c6fc778ccc68e1d6a"

echo "等待授权（最多 $((TRIES * 5)) 秒）…"
i=0
while [ "$i" -lt "$TRIES" ]; do
  OUT=$(curl -sS --http1.1 --max-time 12 -X POST https://github.com/login/oauth/access_token \
    -H "Accept: application/json" -H "User-Agent: awamesh-cli" \
    -d "client_id=${CLIENT}&device_code=${DEV}&grant_type=urn:ietf:params:oauth:grant-type:device_code" 2>/dev/null || true)
  STATE=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.access_token?"OK":(j.error||"unknown"))}catch(e){process.stdout.write("parse")}})')
  case "$STATE" in
    OK)
      printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);require("fs").writeFileSync(".gh-token",j.access_token)})'
      chmod 600 .gh-token 2>/dev/null || true
      echo "已授权"
      break ;;
    authorization_pending) printf '.' ;;
    slow_down) printf 's' ;;
    expired_token|access_denied)
      echo; echo "授权失败：$STATE"; exit 2 ;;
    *) echo; echo "状态：$STATE"; exit 3 ;;
  esac
  i=$((i + 1))
  sleep 5
done

[ -f .gh-token ] || { echo; echo "超时，未拿到 token"; exit 4; }

TOKEN=$(cat .gh-token)
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

LOGIN=$(api https://api.github.com/user | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.login||"")})')
[ -n "$LOGIN" ] || { echo "token 无效"; exit 5; }
echo "账号：$LOGIN"

CODE=$(curl -s -o .gh-repo.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/user/repos \
  -d '{"name":"awamesh","description":"自托管组网控制台：WireGuard 组网 + 多中继 + Cloudflare 隧道","private":false,"has_issues":true,"has_wiki":false}')

if [ "$CODE" = "201" ]; then
  echo "仓库已创建"
elif grep -q "already exists" .gh-repo.json 2>/dev/null; then
  echo "仓库已存在，直接推送"
else
  echo "创建仓库失败（HTTP $CODE）："; head -c 300 .gh-repo.json; echo; exit 6
fi

git remote remove origin 2>/dev/null || true
git remote add origin "https://${LOGIN}:${TOKEN}@github.com/${LOGIN}/awamesh.git"
git push -u origin HEAD:main 2>&1 | tail -5

git remote set-url origin "https://github.com/${LOGIN}/awamesh.git"
rm -f .gh-repo.json .gh-token
echo
echo "完成：https://github.com/${LOGIN}/awamesh"
git remote -v
