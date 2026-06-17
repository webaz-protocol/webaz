#!/usr/bin/env bash
# B2 隐私购物（匿名收货）冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. DB 列已加入 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('orders') WHERE name IN ('anonymous_recipient','recipient_code')")
chk "anonymous_recipient + recipient_code 2 列" "2" "$HAS"

# 找一个有余额的 buyer + active 商品
BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u WHERE u.role='buyer' AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id=u.id AND w.balance >= 1000) LIMIT 1")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' AND stock > 0 AND price <= 200 LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")
SELLER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE id='$SELLER_ID'")
echo "buyer=$BUYER_ID seller=$SELLER_ID prod=$PID"

echo ""
echo "=== 2. 下单 anonymous=true → 返回 order + 自动生成代号 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"丰巢自提柜 #1234 朝阳区某街道\",\"anonymous_recipient\":true,\"quantity\":1}")
ORDER_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('order_id') or '')")
[[ -z "$ORDER_ID" ]] && { echo "✗ 下单失败 — $RESP"; exit 1; }
echo "Order $ORDER_ID"

# 直接查 DB 确认 code 生成
CODE=$(sqlite3 "$DB" "SELECT recipient_code FROM orders WHERE id='$ORDER_ID'")
FLAG=$(sqlite3 "$DB" "SELECT anonymous_recipient FROM orders WHERE id='$ORDER_ID'")
chk "flag = 1" "1" "$FLAG"
CODE_VALID=$([[ "$CODE" =~ ^PR-[A-HJ-NP-Z2-9]{5}$ ]] && echo "ok" || echo "bad:$CODE")
chk "code 格式 PR-XXXXX" "ok" "$CODE_VALID"

echo ""
echo "=== 3. buyer GET /api/orders/:id → 含 recipient_code ==="
RESP=$(curl -sS "$BASE/api/orders/$ORDER_ID" -H "Authorization: Bearer $BUYER_KEY")
RC=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['order'].get('recipient_code') or '')")
chk "buyer 看到代号" "$CODE" "$RC"
ADDR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['order'].get('shipping_address'))")
HAS_PREFIX=$([[ "$ADDR" =~ ^"🔒" ]] && echo "yes" || echo "no")
chk "buyer 看到的地址没有 🔒 前缀（原文）" "no" "$HAS_PREFIX"

echo ""
echo "=== 4. seller GET /api/orders/:id → shipping_address 前缀代号，无 recipient_code ==="
RESP=$(curl -sS "$BASE/api/orders/$ORDER_ID" -H "Authorization: Bearer $SELLER_KEY")
ADDR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['order'].get('shipping_address'))")
HAS_PREFIX=$([[ "$ADDR" =~ "🔒 $CODE" ]] && echo "yes" || echo "no:$ADDR")
chk "seller 看到地址有 🔒 PR-XXXXX 前缀" "yes" "$HAS_PREFIX"
HAS_CODE_FIELD=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'recipient_code' in d['order'] else 'no')")
chk "seller 不下发 recipient_code 字段" "no" "$HAS_CODE_FIELD"

echo ""
echo "=== 5. 列表 GET /api/orders → seller 看到 mask ==="
RESP=$(curl -sS "$BASE/api/orders" -H "Authorization: Bearer $SELLER_KEY")
SELLER_SEES_MASKED=$(echo "$RESP" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
o = next((x for x in arr if x.get('id') == '$ORDER_ID'), None)
if not o: print('missing'); exit()
addr = o.get('shipping_address', '')
buyer = o.get('buyer_name', '')
print('ok' if addr.startswith('🔒') and buyer.startswith('🔒') else f'bad addr={addr[:30]} buyer={buyer}')
")
chk "列表里也 mask 了" "ok" "$SELLER_SEES_MASKED"

echo ""
echo "=== 6. 普通下单 anonymous=false → 行为不变 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"普通地址 测试\",\"quantity\":1}")
ORDER2=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('order_id') or '')")
FLAG=$(sqlite3 "$DB" "SELECT anonymous_recipient FROM orders WHERE id='$ORDER2'")
chk "默认 anonymous_recipient=0" "0" "$FLAG"
CODE=$(sqlite3 "$DB" "SELECT IFNULL(recipient_code,'NULL') FROM orders WHERE id='$ORDER2'")
chk "默认 recipient_code NULL" "NULL" "$CODE"
# Seller 普通订单看到原始 address（无 🔒 前缀）
RESP=$(curl -sS "$BASE/api/orders/$ORDER2" -H "Authorization: Bearer $SELLER_KEY")
ADDR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['order'].get('shipping_address'))")
NO_PREFIX=$([[ "$ADDR" =~ ^"🔒" ]] && echo "yes" || echo "no")
chk "普通订单 seller 看原始地址" "no" "$NO_PREFIX"

echo ""
echo "=== 清理 ==="
# 取消两个测试订单（释放 stake）
for OID in "$ORDER_ID" "$ORDER2"; do
  curl -sS -X POST "$BASE/api/orders/$OID/action" -H "Authorization: Bearer $BUYER_KEY" \
    -H "Content-Type: application/json" -d '{"action":"cancel"}' > /dev/null 2>&1 || true
done
echo "✓ 已取消测试订单"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
