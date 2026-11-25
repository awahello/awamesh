#!/bin/sh
# 用已保存的 .gh-token 建仓并推送（token 用完即清）
set -e
TOKEN=$(cat .gh-token)
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

LOGIN=$(api https://api.github.com/user | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).login||"")}catch{process.stdout.write("")}})')
[ -n "$LOGIN" ] || { echo "token 无效"; exit 5; }
echo "账号：$LOGIN"

CODE=$(curl -s -o .gh-repo.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/user/repos \
  -d '{"name":"awamesh","description":"自托管组网控制台：WireGuard 组网 + 多中继 + Cloudflare 隧道","private":false,"has_issues":true,"has_wiki":false}')

case "$CODE" in
  201) echo "仓库已创建：https://github.com/$LOGIN/awamesh" ;;
  422) echo "仓库已存在，直接推送" ;;
  *) echo "创建失败 HTTP $CODE"; head -c 300 .gh-repo.json; echo; exit 6 ;;
esac

git remote remove origin 2>/dev/null || true
git remote add origin "https://${LOGIN}:${TOKEN}@github.com/${LOGIN}/awamesh.git"
git push -u origin HEAD:main 2>&1 | tail -6

git remote set-url origin "https://github.com/${LOGIN}/awamesh.git"
rm -f .gh-repo.json .gh-token
echo
echo "DONE https://github.com/${LOGIN}/awamesh"
