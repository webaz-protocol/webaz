#!/usr/bin/env bash
# S1 卖家销售分析强化 — 后端冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

SELLER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='seller' AND EXISTS (SELECT 1 FROM orders WHERE seller_id=users.id AND status='completed') LIMIT 1")
[[ -z "$SELLER_KEY" ]] && { echo "✗ 找不到有完成订单的 seller"; exit 1; }

echo "=== 1. endpoint 200 + 旧字段保留 ==="
RESP=$(curl -sS "$BASE/api/sellers/me/analytics?window=30" -H "Authorization: Bearer $SELLER_KEY")
KEEPS_OLD=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if all(k in d for k in ['orders','top_products','buyers','funnel','daily_trend','ratings','refunds']) else 'missing')")
chk "旧字段全部保留" "ok" "$KEEPS_OLD"

echo ""
echo "=== 2. fulfillment.avg_handling_hours + sample_n ==="
HAS_FULFILLMENT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); f=d.get('fulfillment',{}); print('ok' if 'avg_handling_hours' in f and 'sample_n' in f else 'missing')")
chk "fulfillment 字段齐全" "ok" "$HAS_FULFILLMENT"

echo ""
echo "=== 3. quality.return_rate + refunds + completed ==="
HAS_QUALITY=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); q=d.get('quality',{}); print('ok' if all(k in q for k in ['return_rate','refunds','completed']) else 'missing')")
chk "quality 字段齐全" "ok" "$HAS_QUALITY"

echo ""
echo "=== 4. prev_window 对比字段 ==="
HAS_PREV=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('prev_window',{}); print('ok' if all(k in p for k in ['total_orders','completed_orders','gmv']) else 'missing')")
chk "prev_window 字段齐全" "ok" "$HAS_PREV"

echo ""
echo "=== 5. return_rate 范围 [0,1] ==="
RATE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['quality']['return_rate']; print('ok' if 0<=r<=1 else f'out:{r}')")
chk "return_rate ∈ [0,1]" "ok" "$RATE"

echo ""
echo "=== 6. 非 seller 角色 403 ==="
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' LIMIT 1")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/sellers/me/analytics?window=30" -H "Authorization: Bearer $BUYER_KEY")
chk "buyer 403" "403" "$HTTP"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
