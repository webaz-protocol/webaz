#!/usr/bin/env bash
# #claims 待验证广场 — 后端 endpoint 冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. /api/claims/public 无需 auth ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/claims/public")
chk "无 auth 返回 200" "200" "$HTTP"

echo ""
echo "=== 2. 响应包含 items + votes_needed ==="
RESP=$(curl -sS "$BASE/api/claims/public")
HAS_ITEMS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('items'), list) else 'no')")
chk "items 是数组" "yes" "$HAS_ITEMS"
HAS_NEEDED=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('votes_needed'), int) else 'no')")
chk "votes_needed 是整数" "yes" "$HAS_NEEDED"

echo ""
echo "=== 3. 注入测试任务（open + sealed + resolved 各 1）→ status 过滤 ==="
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE role='buyer' LIMIT 1")
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")

# 准备 3 个测试订单
for s in open sealed resolved; do
  ORD="ord_test_claim_${s}_$(date +%s)_$RANDOM"
  sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$ORD', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'completed', datetime('now'), datetime('now'))"
  TASK_ID="cvt_test_${s}_$(date +%s)_$RANDOM"
  TASK_STATUS=$s
  [[ "$s" == "resolved" ]] && TASK_STATUS="resolved_pass"
  RESOLVED_AT="NULL"
  [[ "$s" == "resolved" ]] && RESOLVED_AT="datetime('now')"
  sqlite3 "$DB" "INSERT INTO claim_verification_tasks (id, order_id, buyer_id, seller_id, product_id, claim_target, claim_text, stake_buyer, deadline_at, status, resolved_at) VALUES ('$TASK_ID', '$ORD', '$BUYER_ID', '$SELLER_ID', '$PID', 'price', '测试声明 $s', 10, datetime('now','+2 days'), '$TASK_STATUS', $RESOLVED_AT)"
  eval "TASK_$s=$TASK_ID"
  eval "ORD_$s=$ORD"
done

# open 过滤
RESP=$(curl -sS "$BASE/api/claims/public?status=open")
FOUND_OPEN=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$TASK_open' for i in d.get('items',[])) else 'no')")
chk "open 过滤含 open 任务" "yes" "$FOUND_OPEN"
FOUND_SEALED=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$TASK_sealed' for i in d.get('items',[])) else 'no')")
chk "open 过滤不含 sealed 任务" "no" "$FOUND_SEALED"

# sealed 过滤
RESP=$(curl -sS "$BASE/api/claims/public?status=sealed")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$TASK_sealed' for i in d.get('items',[])) else 'no')")
chk "sealed 过滤含 sealed 任务" "yes" "$FOUND"

# resolved 过滤
RESP=$(curl -sS "$BASE/api/claims/public?status=resolved")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$TASK_resolved' for i in d.get('items',[])) else 'no')")
chk "resolved 过滤含 resolved_pass 任务" "yes" "$FOUND"

echo ""
echo "=== 4. 响应不泄露 buyer_id / seller_id ==="
RESP=$(curl -sS "$BASE/api/claims/public?status=open")
LEAK=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
keys = set()
for i in d.get('items', []): keys.update(i.keys())
print('leak' if ('buyer_id' in keys or 'seller_id' in keys) else 'ok')
")
chk "无 buyer_id / seller_id 泄露" "ok" "$LEAK"

echo ""
echo "=== 5. 必含字段 product_id / claim_target / votes_count / claim_excerpt ==="
RESP=$(curl -sS "$BASE/api/claims/public?status=open")
FIELDS=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
item = next((i for i in d.get('items',[]) if i.get('id')=='$TASK_open'), None)
if not item: print('missing'); exit()
needed = {'product_id','claim_target','votes_count','votes_needed','claim_excerpt','deadline_at','status'}
print('ok' if needed.issubset(item.keys()) else f'missing:{needed - item.keys()}')
")
chk "必含字段齐全" "ok" "$FIELDS"

echo ""
echo "=== 清理 ==="
for s in open sealed resolved; do
  eval "TASK=\$TASK_$s"
  eval "ORD=\$ORD_$s"
  sqlite3 "$DB" "DELETE FROM claim_verification_tasks WHERE id='$TASK'"
  sqlite3 "$DB" "DELETE FROM orders WHERE id='$ORD'"
done
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
