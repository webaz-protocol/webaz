#!/usr/bin/env bash
# 完成订单 7d 引导发笔记 — endpoint 冒烟
# 覆盖：响应 schema + 时间过滤 + 已发笔记排除
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 找一个买家（buyer role）
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' AND api_key IS NOT NULL LIMIT 1")
[[ -z "$BUYER_KEY" ]] && { echo "✗ 找不到 buyer"; exit 1; }
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
echo "测试买家: $BUYER_ID"

echo ""
echo "=== 1. endpoint 返回 200 + prompts 字段 ==="
RESP=$(curl -sS "$BASE/api/me/note-prompts" -H "Authorization: Bearer $BUYER_KEY")
HAS_PROMPTS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('prompts'), list) else 'no')")
chk "prompts 是数组" "yes" "$HAS_PROMPTS"

echo ""
echo "=== 2. 注入测试订单（completed 5d 前，无笔记）→ 应出现 ==="
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")
echo "Product: $PID  Seller: $SELLER_ID"
TEST_ORDER_ID="ord_test_note_prompt_$(date +%s)"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$TEST_ORDER_ID', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'completed', datetime('now','-5 days'), datetime('now','-5 days'))"

RESP=$(curl -sS "$BASE/api/me/note-prompts" -H "Authorization: Bearer $BUYER_KEY")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(p.get('order_id')=='$TEST_ORDER_ID' for p in d.get('prompts',[])) else 'no')")
chk "5d 前完成订单出现在 prompts" "yes" "$FOUND"

echo ""
echo "=== 3. 注入笔记（关联此订单）→ 应消失 ==="
NOTE_ID="sh_test_note_$(date +%s)"
sqlite3 "$DB" "INSERT INTO shareables (id, owner_id, type, status, related_order_id, related_product_id, native_text, created_at) VALUES ('$NOTE_ID', '$BUYER_ID', 'note', 'active', '$TEST_ORDER_ID', '$PID', '测试笔记', datetime('now'))"

RESP=$(curl -sS "$BASE/api/me/note-prompts" -H "Authorization: Bearer $BUYER_KEY")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(p.get('order_id')=='$TEST_ORDER_ID' for p in d.get('prompts',[])) else 'no')")
chk "发笔记后从 prompts 移除" "no" "$FOUND"

echo ""
echo "=== 4. 超过 7d 的订单不应出现 ==="
TEST_OLD="ord_test_old_$(date +%s)"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$TEST_OLD', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'completed', datetime('now','-10 days'), datetime('now','-10 days'))"

RESP=$(curl -sS "$BASE/api/me/note-prompts" -H "Authorization: Bearer $BUYER_KEY")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(p.get('order_id')=='$TEST_OLD' for p in d.get('prompts',[])) else 'no')")
chk "10d 前完成订单不出现" "no" "$FOUND"

echo ""
echo "=== 5. 字段完整性（order_id / product_id / product_title / completed_at）==="
# 再注一个干净的订单
TEST_FRESH="ord_test_fresh_$(date +%s)"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$TEST_FRESH', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'completed', datetime('now','-1 days'), datetime('now','-1 days'))"

RESP=$(curl -sS "$BASE/api/me/note-prompts" -H "Authorization: Bearer $BUYER_KEY")
FIELDS=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=next((x for x in d.get('prompts',[]) if x.get('order_id')=='$TEST_FRESH'), None)
if not p: print('missing'); exit()
keys = set(['order_id','product_id','product_title','completed_at','total_amount','product_image'])
print('ok' if keys.issubset(p.keys()) else f'missing:{keys - p.keys()}')
")
chk "字段完整" "ok" "$FIELDS"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM shareables WHERE id='$NOTE_ID'"
sqlite3 "$DB" "DELETE FROM orders WHERE id IN ('$TEST_ORDER_ID','$TEST_OLD','$TEST_FRESH')"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
