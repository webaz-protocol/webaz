#!/usr/bin/env bash
# 2026-05-22 全面审计冒烟测试
# 覆盖：MASTER_SEED 强制 / health / 错误上报 / KYC enforcement / OpenAPI
set -u
BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:-key_mpf40g7oiwxv}"
PASS=0; FAIL=0; FAIL_LOG=""

chk() {
  local label="$1" exp="$2" act="$3"
  if [[ "$act" == "$exp" ]]; then
    PASS=$((PASS+1)); printf "✓ %s\n" "$label"
  else
    FAIL=$((FAIL+1))
    printf "✗ %s  [got '%s', expected '%s']\n" "$label" "$act" "$exp"
    FAIL_LOG="${FAIL_LOG}\n  ${label}: got ${act} expected ${exp}"
  fi
}

chk_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    PASS=$((PASS+1)); printf "✓ %s (含 '%s')\n" "$label" "$needle"
  else
    FAIL=$((FAIL+1))
    printf "✗ %s (未含 '%s' in '%s')\n" "$label" "$needle" "$haystack"
  fi
}

echo "=== P0 #826: GET /api/health ==="
HEALTH=$(curl -sS "$BASE/api/health")
chk_contains "status=ok" '"status":"ok"' "$HEALTH"
chk_contains "db.ok=true" '"ok":true' "$HEALTH"
chk_contains "返回 uptime_sec" 'uptime_sec' "$HEALTH"
chk_contains "返回 seed_strength" 'seed_strength' "$HEALTH"
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/health")
chk "HTTP 200" "200" "$HTTP"

echo ""
echo "=== P1 #827: 错误上报 ==="
RESP=$(curl -sS -X POST -H "Content-Type: application/json" "$BASE/api/error-report" -d '{"message":"AuditSmokeTest"}')
chk "上报返回 ok" '{"ok":true}' "$RESP"
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: application/json" "$BASE/api/error-report" -d '{}')
chk "缺 message 返 400" "400" "$HTTP"

echo ""
echo "=== P1 #829: KYC 大额提现拦截 ==="
RESP=$(curl -sS -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" "$BASE/api/wallet/withdraw" -d '{"to_address":"0x0000000000000000000000000000000000000001","amount":5000}')
chk_contains "5000 WAZ 拦截 KYC" 'KYC_REQUIRED_FOR_WITHDRAW' "$RESP"
RESP_LOW=$(curl -sS -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" "$BASE/api/wallet/withdraw" -d '{"to_address":"0x0000000000000000000000000000000000000001","amount":500}')
# 500 WAZ < 阈值，应进入白名单检查（不是 KYC 错误）
chk "500 WAZ 不触发 KYC 错误" "" "$(echo "$RESP_LOW" | grep -o 'KYC_REQUIRED_FOR_WITHDRAW')"

echo ""
echo "=== P2 #830: OpenAPI 文档 ==="
OPENAPI=$(curl -sS "$BASE/openapi.json")
chk_contains "OpenAPI 3.0" '"openapi": "3.0.0"' "$OPENAPI"
chk_contains "标题 WebAZ Protocol API" 'WebAZ Protocol API' "$OPENAPI"
chk_contains "含 /api/health" '/api/health' "$OPENAPI"
chk_contains "含 /api/wallet/withdraw" '/api/wallet/withdraw' "$OPENAPI"

ENDPOINT_COUNT=$(echo "$OPENAPI" | python3 -c "import sys,json; d=json.load(sys.stdin); total=sum(len(m) for m in d['paths'].values()); print(total)" 2>/dev/null)
if [[ "$ENDPOINT_COUNT" -ge 500 ]]; then
  PASS=$((PASS+1)); printf "✓ Endpoint count ≥ 500 (= %s)\n" "$ENDPOINT_COUNT"
else
  FAIL=$((FAIL+1)); printf "✗ Endpoint count < 500 (= %s)\n" "$ENDPOINT_COUNT"
fi

echo ""
echo "=== 历史 smoke 整合（确保新改动没破坏之前的）==="
SHARES_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/shares/dashboard" -H "Authorization: Bearer $KEY")
chk "shares/dashboard HTTP 200" "200" "$SHARES_HTTP"
PRODUCTS_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/products?limit=1")
chk "products HTTP 200" "200" "$PRODUCTS_HTTP"

echo ""
echo "=================================="
if [[ $FAIL -eq 0 ]]; then
  printf "✅ %d passed / 0 failed\n" "$PASS"
  exit 0
else
  printf "❌ %d passed / %d failed%s\n" "$PASS" "$FAIL" "$(printf "$FAIL_LOG")"
  exit 1
fi
