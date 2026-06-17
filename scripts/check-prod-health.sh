#!/usr/bin/env bash
# Tier 1 — 生产环境基础健康检查
#
# 用法：
#   bash scripts/check-prod-health.sh https://your-domain.com
#   bash scripts/check-prod-health.sh https://webaz-production-xxxx.up.railway.app
#
# 检查项（按 V1.2-ROADMAP M2 Tier 1 顺序）：
#   #1 SEED         seed_strength == 'strong'
#   #2 RPC          /api/health 报告的 db.ok + uptime
#   #4 VAPID        /api/push/vapid-public-key 返 200（不是 503）
#   #5 error log    /api/admin/errors 端点可达（需 ADMIN_KEY 跳过；仅看 4xx/5xx 反应）

set -u
URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "用法: $0 <prod-url>"
  echo "例: $0 https://webaz-production-xxxx.up.railway.app"
  exit 1
fi
URL="${URL%/}"   # strip trailing slash

PASS=0; WARN=0; FAIL=0
chk() { local l="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then PASS=$((PASS+1)); printf "✓ %-30s %s\n" "$l" "$got"
  else FAIL=$((FAIL+1)); printf "✗ %-30s got '%s' want '%s'\n" "$l" "$got" "$want"
  fi
}
warn() { local l="$1" got="$2" hint="$3"
  WARN=$((WARN+1)); printf "⚠ %-30s %s — %s\n" "$l" "$got" "$hint"
}

echo "─── 探测 $URL ───"

# #1 SEED
HEALTH=$(curl -s -m 10 "$URL/api/health")
if [[ -z "$HEALTH" ]]; then
  echo "✗ /api/health 无响应（域名 / TLS / DNS / 服务挂了）"
  exit 2
fi
SEED=$(echo "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("seed_strength",""))' 2>/dev/null || echo "")
chk "#1 seed_strength" "$SEED" "strong"

# #1+: env
ENV=$(echo "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("env",""))' 2>/dev/null || echo "")
chk "#1 NODE_ENV" "$ENV" "production"

# #1+: db
DBOK=$(echo "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("db",{}).get("ok",""))' 2>/dev/null || echo "")
chk "DB connectivity" "$DBOK" "True"

# #4 VAPID public key endpoint — 必须验 content-type 是 JSON，不是 SPA fallback HTML
VAPID_BODY=$(curl -s -m 10 "$URL/api/push/vapid-public-key")
VAPID_KEY=$(echo "$VAPID_BODY" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(d.get("key","")[:10]+"…" if d.get("key") else "")
except: print("")' 2>/dev/null)
VAPID_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$URL/api/push/vapid-public-key")
if [[ -n "$VAPID_KEY" ]]; then
  PASS=$((PASS+1))
  printf "✓ %-30s %s (configured)\n" "#4 vapid-public-key" "$VAPID_KEY"
elif [[ "$VAPID_STATUS" == "503" ]]; then
  warn "#4 vapid-public-key" "503" "VAPID env 未设 → 推送禁用"
elif echo "$VAPID_BODY" | head -c 50 | grep -qE "<!DOCTYPE|<html"; then
  warn "#4 vapid-public-key" "SPA fallback" "端点不存在 — 旧版本/路由未注册"
else
  chk "#4 vapid-public-key" "$VAPID_STATUS" "200|503"
fi

# 公开 endpoints sanity
ME=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$URL/api/me")
chk "/api/me 401 (未鉴权)" "$ME" "401"

# manifest（公开协议规范 dump）
MANIFEST_OK=$(curl -s -m 10 "$URL/api/manifest" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("protocol",{}).get("name")=="WebAZ" else "fail")' 2>/dev/null || echo "fail")
chk "/api/manifest" "$MANIFEST_OK" "ok"

echo "─────────────────────────────────"
echo "PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then
  echo "❌ 生产健康检查失败 — 上线前需修复"
  exit 1
fi
echo "✅ 基础健康检查通过${WARN:+（注意 $WARN 个 warn）}"
