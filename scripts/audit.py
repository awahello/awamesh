import io, re

app = io.open("public/app.js", encoding="utf-8").read()
api_src = io.open("src/api.js", encoding="utf-8").read()
srv = io.open("src/server.js", encoding="utf-8").read()

calls = set()
for m in re.finditer(r'api\(\s*[`\'"]([^`\'"]+)[`\'"]', app):
    p = m.group(1).split("?")[0].split("${")[0]
    if p.startswith("/api") or p.startswith("/dp"):
        calls.add(p.rstrip("/"))

routes = set()
for m in re.finditer(r'(?:url\.pathname|p)\s*===\s*"([^"]+)"', api_src + srv):
    routes.add(m.group(1).rstrip("/"))

seg_routes = set()
for m in re.finditer(r'seg\[0\]\s*===\s*"([^"]+)"[^\n]*?seg\[2\]\s*===\s*"([^"]+)"', api_src):
    seg_routes.add("/api/%s/:id/%s" % (m.group(1), m.group(2)))

def matches(p):
    if p in routes: return True
    parts = [x for x in p.split("/") if x]
    if len(parts) >= 4 and parts[0] == "api":
        if "/api/%s/:id/%s" % (parts[1], parts[3]) in seg_routes: return True
    return any(r.endswith("*") and p.startswith(r[:-1]) for r in routes)

missing = sorted(c for c in calls if not matches(c))
print("前端调用:", len(calls), "后端路由:", len(routes) + len(seg_routes))
print("未匹配路由:")
for m in missing: print("  ", m)

defined = set(re.findall(r'function\s+([A-Za-z_$][\w$]*)\s*\(', app))
used = set(re.findall(r'\b(open[A-Z]\w*)\s*\(', app))
print("未定义 open*:", sorted(used - defined) or "无")

ids = re.findall(r'id="([a-zA-Z][\w-]*)"', app)
dups = sorted({i for i in ids if ids.count(i) > 1})
print("重复 id:", dups or "无")

for bad in ["ifaace", "TODO("]:
    n = app.count(bad) + api_src.count(bad) + srv.count(bad)
    if n: print("疑似手误", bad, n)
