#!/bin/sh
# 用一次 PAT 创建仓库并推送，然后立刻把 token 从 remote 里摘掉
# 用法：GITHUB_TOKEN=ghp_xxx GITHUB_OWNER=你的用户名 sh scripts/push-github.sh [仓库名]
set -e

TOKEN="${GITHUB_TOKEN:?需要 GITHUB_TOKEN}"
OWNER="${GITHUB_OWNER:?需要 GITHUB_OWNER}"
REPO="${1:-awamesh}"
VISIBILITY="${VISIBILITY:-public}"

api() {
  curl -fsS -H "Authorization: Bearer $TOKEN" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

echo "==> 1/4 校验 token"
WHO=$(api https://api.github.com/user | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$WHO" ] || { echo "token 无效"; exit 1; }
echo "    已认证：$WHO"

echo "==> 2/4 创建仓库 $OWNER/$REPO（$VISIBILITY）"
CODE=$(curl -s -o /tmp/awamesh-repo.json -w '%{http_code}' \
  -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO\",\"description\":\"自托管组网控制台：WireGuard 组网 + 多中继 + Cloudflare 隧道\",\"private\":$([ "$VISIBILITY" = "private" ] && echo true || echo false),\"has_issues\":true,\"has_wiki\":false}")
if [ "$CODE" = "201" ]; then echo "    已创建"; else
  if grep -q "already exists" /tmp/awamesh-repo.json 2>/dev/null; then echo "    仓库已存在，继续推送"; else
    echo "    创建失败（HTTP $CODE）："; head -c 400 /tmp/awamesh-repo.json; echo; exit 1
  fi
fi

echo "==> 3/4 推送"
git remote remove origin 2>/dev/null || true
git remote add origin "https://${OWNER}:${TOKEN}@github.com/${OWNER}/${REPO}.git"
git push -u origin HEAD:main

echo "==> 4/4 清理 token"
git remote set-url origin "https://github.com/${OWNER}/${REPO}.git"
rm -f /tmp/awamesh-repo.json
git remote -v
echo "完成：https://github.com/${OWNER}/${REPO}"
