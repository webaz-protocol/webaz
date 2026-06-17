#!/usr/bin/env bash
# B1 跨境税费提示 — endpoint 冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. region_config 新字段已加 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('region_config') WHERE name IN ('est_import_duty_pct','est_import_threshold_waz')")
chk "2 列存在" "2" "$HAS"

# 找一个 buyer 在 china 区，找一个 seller 在 us 区的商品（跨境）
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' AND region='china' LIMIT 1")
[[ -z "$BUYER_KEY" ]] && BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' LIMIT 1")
BUYER_REG=$(sqlite3 "$DB" "SELECT region FROM users WHERE api_key='$BUYER_KEY'")
# 找一个 seller 在不同 region 的商品
PID=$(sqlite3 "$DB" "SELECT p.id FROM products p JOIN users u ON u.id = p.seller_id WHERE p.status='active' AND u.region != '$BUYER_REG' LIMIT 1")
[[ -z "$PID" ]] && { echo "✗ 找不到跨境商品"; exit 1; }
SELLER_REG=$(sqlite3 "$DB" "SELECT u.region FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id='$PID'")
echo "buyer region=$BUYER_REG seller region=$SELLER_REG product=$PID"

echo ""
echo "=== 2. 跨境订单返回 is_cross_border=true ==="
RESP=$(curl -sS "$BASE/api/checkout/tax-preview?product_id=$PID&quantity=1" -H "Authorization: Bearer $BUYER_KEY")
CB=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('is_cross_border'))")
chk "is_cross_border=true" "True" "$CB"

DUTY_PCT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duty_pct'))")
chk "duty_pct 是数字 (非 NaN)" "ok" "$([[ "$DUTY_PCT" =~ ^[0-9.]+$ ]] && echo ok || echo "bad:$DUTY_PCT")"

DISCLAIMER=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('disclaimer'))")
chk "返回 disclaimer 文案" "ok" "$([[ -n "$DISCLAIMER" ]] && echo ok || echo missing)"

echo ""
echo "=== 3. 同地区 → is_cross_border=false ==="
# 找同 region 的商品
PID_SAME=$(sqlite3 "$DB" "SELECT p.id FROM products p JOIN users u ON u.id = p.seller_id WHERE p.status='active' AND u.region = '$BUYER_REG' LIMIT 1")
if [[ -n "$PID_SAME" ]]; then
  RESP=$(curl -sS "$BASE/api/checkout/tax-preview?product_id=$PID_SAME&quantity=1" -H "Authorization: Bearer $BUYER_KEY")
  CB=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('is_cross_border'))")
  chk "同地区 is_cross_border=false" "False" "$CB"
  DUTY=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('estimated_duty_waz'))")
  chk "同地区 duty=0" "0" "$DUTY"
else
  echo "  (skip: 找不到同地区商品)"
fi

echo ""
echo "=== 4. 高金额订单超过 threshold → 计算关税 ==="
# 临时把 buyer region 的阈值改 0，确保会算出关税
ORIG_THRES=$(sqlite3 "$DB" "SELECT est_import_threshold_waz FROM region_config WHERE region='$BUYER_REG'")
sqlite3 "$DB" "UPDATE region_config SET est_import_threshold_waz = 0 WHERE region='$BUYER_REG'"
RESP=$(curl -sS "$BASE/api/checkout/tax-preview?product_id=$PID&quantity=10" -H "Authorization: Bearer $BUYER_KEY")
DUTY=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('positive' if d.get('estimated_duty_waz',0) > 0 else 'zero')")
chk "高金额关税 > 0" "positive" "$DUTY"
HAS_TOTAL=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('total_with_duty', 0) > d.get('order_total_waz', 0) else 'bad')")
chk "total_with_duty > order_total_waz" "ok" "$HAS_TOTAL"
# 还原阈值
sqlite3 "$DB" "UPDATE region_config SET est_import_threshold_waz = $ORIG_THRES WHERE region='$BUYER_REG'"

echo ""
echo "=== 5. 未登录 → 401 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/checkout/tax-preview?product_id=$PID")
chk "无 auth 401" "401" "$HTTP"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
