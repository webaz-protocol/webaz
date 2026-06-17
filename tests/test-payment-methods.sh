#!/usr/bin/env bash
# 支付选项管理 — schema + admin CRUD + 公开 API + 审计日志 + watcher 适配层
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. 三张表 schema 就位 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('payment_methods','region_payment_methods','payment_methods_log')")
chk "3 张表存在" "3" "$HAS"

echo ""
echo "=== 2. Seed: usdc_base active + usdt_tron preview ==="
USDC=$(sqlite3 "$DB" "SELECT status FROM payment_methods WHERE id='usdc_base'")
chk "usdc_base 状态 = active" "active" "$USDC"
TRON=$(sqlite3 "$DB" "SELECT status FROM payment_methods WHERE id='usdt_tron'")
chk "usdt_tron 状态 = preview" "preview" "$TRON"
USDC_WATCHER=$(sqlite3 "$DB" "SELECT watcher_status FROM payment_methods WHERE id='usdc_base'")
chk "usdc_base watcher_status = active" "active" "$USDC_WATCHER"
TRON_WATCHER=$(sqlite3 "$DB" "SELECT watcher_status FROM payment_methods WHERE id='usdt_tron'")
chk "usdt_tron watcher_status = unconfigured" "unconfigured" "$TRON_WATCHER"

echo ""
echo "=== 3. 默认 global × usdc_base 映射存在 ==="
HAS_MAP=$(sqlite3 "$DB" "SELECT COUNT(*) FROM region_payment_methods WHERE region='global' AND method_id='usdc_base' AND direction='both' AND status='active'")
chk "默认映射就位" "1" "$HAS_MAP"

echo ""
echo "=== 4. 公开 API: /api/payment-methods 列出方法 ==="
RESP=$(curl -sS "$BASE/api/payment-methods")
HAS_BASE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); ids=[x['id'] for x in d['items']]; print('1' if 'usdc_base' in ids else '0')")
chk "公开 API 含 usdc_base" "1" "$HAS_BASE"
HAS_TRON=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); ids=[x['id'] for x in d['items']]; print('1' if 'usdt_tron' in ids else '0')")
chk "公开 API 含 usdt_tron (preview)" "1" "$HAS_TRON"

echo ""
echo "=== 5. 公开 API: /api/payment-methods/for-region (fallback to global) ==="
RESP=$(curl -sS "$BASE/api/payment-methods/for-region?region=jp")
FALLBACK=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('fallback_from') or 'no')")
chk "未配置地区 jp 回落 global" "jp" "$FALLBACK"
FINAL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('region'))")
chk "最终生效 region = global" "global" "$FINAL"

echo ""
echo "=== 6. Admin 必须 admin 角色 ==="
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' LIMIT 1")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/payment-methods" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" -d '{}')
chk "非 admin POST → 403" "403" "$HTTP"

echo ""
echo "=== 7. Admin 创建 + 编辑 + 删除（root admin only）==="
# 必须用 root admin（admin_type='root'）；regional admin 应被 403 拒绝（下一节验证）
ADMIN_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='admin' AND (admin_type IS NULL OR admin_type='root') LIMIT 1")
RESP=$(curl -sS -X POST "$BASE/api/admin/payment-methods" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "id":"test_method_x","display_name":"测试方法","kind":"crypto_onchain","asset":"TEST","chain":"testchain","decimals":6,"icon":"🧪","status":"inactive","reason":"e2e test"
}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "admin POST create" "True" "$OK"

RESP=$(curl -sS -X PUT "$BASE/api/admin/payment-methods/test_method_x" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{"status":"preview","reason":"flip to preview"}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "admin PUT update" "True" "$OK"
NEW_STATUS=$(sqlite3 "$DB" "SELECT status FROM payment_methods WHERE id='test_method_x'")
chk "状态已切到 preview" "preview" "$NEW_STATUS"

RESP=$(curl -sS -X DELETE "$BASE/api/admin/payment-methods/test_method_x" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json")
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "admin DELETE" "True" "$OK"

echo ""
echo "=== 7b. Regional admin（admin_type='regional'）被拒 ==="
REGIONAL_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='admin' AND admin_type='regional' LIMIT 1")
if [[ -n "$REGIONAL_KEY" ]]; then
  HTTP_GET=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/payment-methods" -H "Authorization: Bearer $REGIONAL_KEY")
  chk "regional admin GET → 403" "403" "$HTTP_GET"
  HTTP_POST=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/payment-methods" -H "Authorization: Bearer $REGIONAL_KEY" -H "Content-Type: application/json" -d '{"id":"hack_x","display_name":"x","kind":"crypto_onchain","asset":"X"}')
  chk "regional admin POST → 403" "403" "$HTTP_POST"
else
  echo "(skip — 当前 DB 无 regional admin)"
fi

echo ""
echo "=== 8. 默认 usdc_base 不可删 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/payment-methods/usdc_base" -H "Authorization: Bearer $ADMIN_KEY")
chk "删 usdc_base → 400" "400" "$HTTP"

echo ""
echo "=== 9. 审计日志记录变更 ==="
LOG_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM payment_methods_log WHERE entity_id='test_method_x'")
# 日志累积式记录（重跑测试不清旧）— 至少 3 条（create + update + delete）
GE3=$([[ "$LOG_COUNT" -ge 3 ]] && echo "ok" || echo "only_$LOG_COUNT")
chk "test_method_x 至少 3 条日志（create+update+delete）" "ok" "$GE3"

echo ""
echo "=== 10. 公开审计日志可查 ==="
RESP=$(curl -sS "$BASE/api/payment-methods/log?limit=5")
HAS_ITEMS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if isinstance(d.get('items'), list) else '0')")
chk "审计日志公开可读" "1" "$HAS_ITEMS"

echo ""
echo "=== 11. 区域映射 CRUD ==="
RESP=$(curl -sS -X POST "$BASE/api/admin/region-payment-methods" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "region":"china","method_id":"usdc_base","direction":"deposit","status":"active","min_amount":10,"reason":"china only deposit"
}')
MAP_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id') or '')")
HAS_ID=$([[ -n "$MAP_ID" ]] && echo "1" || echo "0")
chk "创建 china × usdc_base × deposit 映射" "1" "$HAS_ID"

RESP=$(curl -sS -X PUT "$BASE/api/admin/region-payment-methods/$MAP_ID" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{"status":"paused","reason":"test pause"}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "更新 status=paused" "True" "$OK"

curl -sS -o /dev/null -X DELETE "$BASE/api/admin/region-payment-methods/$MAP_ID" -H "Authorization: Bearer $ADMIN_KEY"
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM region_payment_methods WHERE id='$MAP_ID'")
chk "删除后行不存在" "0" "$HAS"

echo ""
echo "=== 12. 默认 global × usdc_base 不可删 ==="
DEFAULT_ID=$(sqlite3 "$DB" "SELECT id FROM region_payment_methods WHERE region='global' AND method_id='usdc_base' AND direction='both' LIMIT 1")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/region-payment-methods/$DEFAULT_ID" -H "Authorization: Bearer $ADMIN_KEY")
chk "删默认映射 → 400" "400" "$HTTP"

echo ""
echo "=== 13. UNIQUE(region, method_id, direction) 约束 ==="
RESP=$(curl -sS -X POST "$BASE/api/admin/region-payment-methods" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "region":"global","method_id":"usdc_base","direction":"both","status":"active"
}')
ERR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('dup' if 'UNIQUE' not in str(d) and d.get('error') else 'no')")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/region-payment-methods" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "region":"global","method_id":"usdc_base","direction":"both","status":"active"
}')
chk "重复 region+method+direction → 409" "409" "$HTTP"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
