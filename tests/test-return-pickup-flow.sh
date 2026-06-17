#!/usr/bin/env bash
# L3 Phase 2 退货上门取件完整状态机
# accepted_pickup_pending → picked_up → refunded
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 找一个 completed 订单 + buyer + 商品支持 return_days；用 SQL 直接注入 return_request 跳过流程
BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u JOIN orders o ON o.buyer_id=u.id JOIN products p ON p.id=o.product_id WHERE o.status='completed' AND p.return_days > 0 AND NOT EXISTS (SELECT 1 FROM return_requests rr WHERE rr.order_id=o.id) LIMIT 1")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
ORDER_ID=$(sqlite3 "$DB" "SELECT o.id FROM orders o WHERE o.buyer_id='$BUYER_ID' AND o.status='completed' AND NOT EXISTS (SELECT 1 FROM return_requests rr WHERE rr.order_id=o.id) LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM orders WHERE id='$ORDER_ID'")
SELLER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE id='$SELLER_ID'")
LOG_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='logistics' LIMIT 1")
[[ -z "$ORDER_ID" || -z "$LOG_KEY" ]] && { echo "✗ 需 1 completed order + 1 logistics user"; exit 1; }
echo "Order: $ORDER_ID  Seller: $SELLER_ID  Logistics key: $(echo $LOG_KEY | head -c 12)..."

# 给 seller 钱包加余额
sqlite3 "$DB" "UPDATE wallets SET balance = balance + 1000 WHERE user_id='$SELLER_ID'"
INIT_BAL_SELLER=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$SELLER_ID'")
INIT_BAL_BUYER=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$BUYER_ID'")

echo ""
echo "=== 1. 买家发起带上门取件的退货 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders/$ORDER_ID/return-request" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" -d '{"reason":"quality","refund_amount":1,"pickup_requested":true,"pickup_address":"上海浦东某街道 99 号"}')
RET_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id') or '')")
[[ -z "$RET_ID" ]] && { echo "✗ 创建失败 — $RESP"; exit 1; }

echo ""
echo "=== 2. 卖家接受 → 状态进 accepted_pickup_pending（不立即退款）==="
RESP=$(curl -sS -X POST "$BASE/api/return-requests/$RET_ID/decide" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" -d '{"decision":"accept","response":"OK"}')
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status'))")
chk "状态 = accepted_pickup_pending" "accepted_pickup_pending" "$STATUS"
BAL_NOW=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$SELLER_ID'")
chk "卖家余额未变化（未退款）" "$INIT_BAL_SELLER" "$BAL_NOW"

echo ""
echo "=== 3. 物流端取件任务列表 ==="
RESP=$(curl -sS "$BASE/api/logistics/return-pickups" -H "Authorization: Bearer $LOG_KEY")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$RET_ID' for i in d.get('items',[])) else 'no')")
chk "取件任务列表含此请求" "yes" "$FOUND"
HAS_ADDR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); i=next((x for x in d['items'] if x['id']=='$RET_ID'), None); print(i.get('pickup_address'))" )
chk "返回 pickup_address" "上海浦东某街道 99 号" "$HAS_ADDR"

echo ""
echo "=== 4. 物流揽收 — 缺 evidence → 400 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/return-requests/$RET_ID/picked-up" -H "Authorization: Bearer $LOG_KEY" \
  -H "Content-Type: application/json" -d '{"evidence":"x"}')
chk "短证据 400" "400" "$HTTP"

echo ""
echo "=== 5. 物流揽收 → 状态 picked_up ==="
RESP=$(curl -sS -X POST "$BASE/api/return-requests/$RET_ID/picked-up" -H "Authorization: Bearer $LOG_KEY" \
  -H "Content-Type: application/json" -d '{"evidence":"顺丰 SF1234567890 已揽收"}')
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status'))")
chk "状态 = picked_up" "picked_up" "$STATUS"
BAL_NOW=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$SELLER_ID'")
chk "卖家余额仍未变化（继续等收到）" "$INIT_BAL_SELLER" "$BAL_NOW"

echo ""
echo "=== 6. 非 logistics 角色不能揽收 → 403 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/return-requests/$RET_ID/picked-up" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" -d '{"evidence":"hack"}')
chk "非物流 403" "403" "$HTTP"

echo ""
echo "=== 7. 卖家确认收到 → 触发退款 ==="
RESP=$(curl -sS -X POST "$BASE/api/return-requests/$RET_ID/received" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" -d '{}')
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status'))")
chk "状态 = refunded" "refunded" "$STATUS"
BAL_SELLER=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$SELLER_ID'")
EXPECTED=$(python3 -c "print($INIT_BAL_SELLER - 1)")
chk "卖家钱包 -1 WAZ" "$EXPECTED" "$BAL_SELLER"
BAL_BUYER=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$BUYER_ID'")
EXPECTED_BUYER=$(python3 -c "print($INIT_BAL_BUYER + 1)")
chk "买家钱包 +1 WAZ" "$EXPECTED_BUYER" "$BAL_BUYER"

echo ""
echo "=== 8. 已 refunded 不能重复 received → 400 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/return-requests/$RET_ID/received" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" -d '{}')
chk "重复 received 400" "400" "$HTTP"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM return_messages WHERE return_id='$RET_ID'"
sqlite3 "$DB" "DELETE FROM return_requests WHERE id='$RET_ID'"
sqlite3 "$DB" "UPDATE wallets SET balance = balance - 1000 + 1 WHERE user_id='$SELLER_ID'"
sqlite3 "$DB" "UPDATE wallets SET balance = balance - 1 WHERE user_id='$BUYER_ID'"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
