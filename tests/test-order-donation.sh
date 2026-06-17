#!/usr/bin/env bash
# B5 公益捐赠自选比例 — 后端冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. donation_amount 列已加 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('orders') WHERE name='donation_amount'")
chk "列存在" "1" "$HAS"

BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u WHERE u.role='buyer' AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id=u.id AND w.balance >= 2000) LIMIT 1")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' AND stock > 0 AND price <= 100 LIMIT 1")
echo "buyer=$BUYER_ID prod=$PID"

# 记录初始 charity_fund balance
INIT_FUND=$(sqlite3 "$DB" "SELECT balance FROM charity_fund WHERE id='main'")
INIT_BAL=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$BUYER_ID'")
PRICE=$(sqlite3 "$DB" "SELECT price FROM products WHERE id='$PID'")
echo "init fund=$INIT_FUND init bal=$INIT_BAL price=$PRICE"

echo ""
echo "=== 2. 下单 donation_pct=0.01 (1%) → donation_amount = price * 1% ==="
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"测试地址\",\"donation_pct\":0.01,\"quantity\":1}")
ORDER_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('order_id') or '')")
[[ -z "$ORDER_ID" ]] && { echo "✗ 下单失败 — $RESP"; exit 1; }

DON=$(sqlite3 "$DB" "SELECT donation_amount FROM orders WHERE id='$ORDER_ID'")
EXPECTED=$(python3 -c "print(round($PRICE * 0.01, 2))")
chk "donation_amount = $EXPECTED" "$EXPECTED" "$DON"

echo ""
echo "=== 3. charity_fund.balance 已增加捐赠额 ==="
NEW_FUND=$(sqlite3 "$DB" "SELECT balance FROM charity_fund WHERE id='main'")
EXPECTED_FUND=$(python3 -c "print(round($INIT_FUND + $DON, 2))")
chk "fund balance += donation" "$EXPECTED_FUND" "$NEW_FUND"

echo ""
echo "=== 4. charity_fund_txns 有 1 条 donation 记录 ==="
TXN=$(sqlite3 "$DB" "SELECT COUNT(*) FROM charity_fund_txns WHERE kind='donation' AND from_user_id='$BUYER_ID' AND related_order_id='$ORDER_ID'")
chk "1 条 donation txn" "1" "$TXN"

echo ""
echo "=== 5. 买家钱包扣 order_total + donation_amount ==="
NEW_BAL=$(sqlite3 "$DB" "SELECT balance FROM wallets WHERE user_id='$BUYER_ID'")
EXPECTED_BAL=$(python3 -c "print(round($INIT_BAL - $PRICE - $DON, 2))")
chk "balance = init - order - donation" "$EXPECTED_BAL" "$NEW_BAL"

echo ""
echo "=== 6. 非法 pct (0.03) → 400 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"x\",\"donation_pct\":0.03}")
HAS_ERR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error_code'))")
chk "返回 DONATION_PCT_INVALID" "DONATION_PCT_INVALID" "$HAS_ERR"

echo ""
echo "=== 7. donation_pct=0 → 行为不变 ==="
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"x\",\"donation_pct\":0}")
ORD2=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('order_id') or '')")
DON2=$(sqlite3 "$DB" "SELECT donation_amount FROM orders WHERE id='$ORD2'")
chk "donation_amount=0" "0.0" "$DON2"

echo ""
echo "=== 清理 ==="
# 取消订单（释放 escrow）+ 退捐款（手工 — 简单测试不实际退）
for OID in "$ORDER_ID" "$ORD2"; do
  curl -sS -X POST "$BASE/api/orders/$OID/action" -H "Authorization: Bearer $BUYER_KEY" \
    -H "Content-Type: application/json" -d '{"action":"cancel"}' > /dev/null 2>&1 || true
done
# 还原 fund + 买家钱包（捐款不退是 by design，但测试用回滚干净）
sqlite3 "$DB" "UPDATE charity_fund SET balance = $INIT_FUND, total_donated = total_donated - $DON WHERE id='main'"
sqlite3 "$DB" "UPDATE wallets SET balance = balance + $DON WHERE user_id='$BUYER_ID'"
sqlite3 "$DB" "DELETE FROM charity_fund_txns WHERE related_order_id IN ('$ORDER_ID','$ORD2')"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
