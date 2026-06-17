#!/usr/bin/env bash
# L3+B3 退货上门取件 MVP 冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. DB 列 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('return_requests') WHERE name IN ('pickup_requested','pickup_address')")
chk "2 列存在" "2" "$HAS"

# 清理近期残留通知（防止其他测试干扰本测试的计数断言）
sqlite3 "$DB" "DELETE FROM notifications WHERE type='return_request' AND title LIKE '%上门取件%' AND created_at > datetime('now','-10 minutes')"

# 找一个 completed 订单 + 买家 + 商品支持 return_days
BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u JOIN orders o ON o.buyer_id=u.id JOIN products p ON p.id=o.product_id WHERE o.status='completed' AND p.return_days > 0 AND NOT EXISTS (SELECT 1 FROM return_requests rr WHERE rr.order_id=o.id) LIMIT 1")
ORDER_ID=$(sqlite3 "$DB" "SELECT o.id FROM orders o JOIN users u ON u.id=o.buyer_id JOIN products p ON p.id=o.product_id WHERE u.api_key='$BUYER_KEY' AND o.status='completed' AND p.return_days > 0 AND NOT EXISTS (SELECT 1 FROM return_requests rr WHERE rr.order_id=o.id) LIMIT 1")
[[ -z "$ORDER_ID" ]] && { echo "✗ 找不到可退订单"; exit 1; }
echo "Order $ORDER_ID buyer key prefix $(echo $BUYER_KEY | head -c 12)..."

echo ""
echo "=== 2. 上门取件请求 — 缺地址 → 400 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders/$ORDER_ID/return-request" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" -d '{"reason":"quality","refund_amount":1,"pickup_requested":true}')
HAS_ERR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')")
chk "缺地址被拒" "yes" "$HAS_ERR"

echo ""
echo "=== 3. 上门取件 + 地址 → 落库 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders/$ORDER_ID/return-request" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" -d '{"reason":"quality","refund_amount":1,"pickup_requested":true,"pickup_address":"北京朝阳区某街道 1 号"}')
RET_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id') or '')")
[[ -z "$RET_ID" ]] && { echo "✗ 提交失败 — $RESP"; exit 1; }
PR=$(sqlite3 "$DB" "SELECT pickup_requested FROM return_requests WHERE id='$RET_ID'")
chk "pickup_requested=1" "1" "$PR"
ADDR=$(sqlite3 "$DB" "SELECT pickup_address FROM return_requests WHERE id='$RET_ID'")
chk "pickup_address 落库" "北京朝阳区某街道 1 号" "$ADDR"

echo ""
echo "=== 4. 卖家通知含上门取件标记 ==="
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM return_requests WHERE id='$RET_ID'")
# 只看最近 1 分钟（避免累积通知干扰）
HAS_MSG=$(sqlite3 "$DB" "SELECT COUNT(*) FROM notifications WHERE user_id='$SELLER_ID' AND type='return_request' AND title LIKE '%上门取件%' AND created_at > datetime('now','-1 minute')")
chk "卖家收到含 '上门取件' 的通知" "1" "$HAS_MSG"

echo ""
echo "=== 5. 不请求上门 → pickup_requested=0 ==="
sqlite3 "$DB" "DELETE FROM return_requests WHERE id='$RET_ID'"
RESP=$(curl -sS -X POST "$BASE/api/orders/$ORDER_ID/return-request" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" -d '{"reason":"quality","refund_amount":1}')
RET_ID2=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id') or '')")
PR=$(sqlite3 "$DB" "SELECT pickup_requested FROM return_requests WHERE id='$RET_ID2'")
chk "不请求上门时 = 0" "0" "$PR"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM return_requests WHERE id IN ('$RET_ID','$RET_ID2')"
sqlite3 "$DB" "DELETE FROM notifications WHERE user_id='$SELLER_ID' AND type='return_request' AND created_at > datetime('now','-2 minutes')"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
