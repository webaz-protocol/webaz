#!/usr/bin/env bash
# 笔记真实性徽章 — 后端 enrichment 冒烟
# 覆盖：4 个 endpoint 都返回 badges + verified_buyer 时间窗 + original_photos
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 找一个买家 + 卖家 + 商品
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' AND api_key IS NOT NULL LIMIT 1")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")
echo "买家: $BUYER_ID  商品: $PID"

# 准备一个 completed 订单（5d 前）
ORDER_ID="ord_test_badge_$(date +%s)"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$ORDER_ID', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'completed', datetime('now','-5 days'), datetime('now','-5 days'))"

# 准备一个有图的笔记（关联订单，3d 前发）
NOTE_ID="shr_test_badge_$(date +%s)"
HASH="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
sqlite3 "$DB" "INSERT INTO shareables (id, owner_id, type, status, related_order_id, related_product_id, native_text, title, photo_hashes, created_at) VALUES ('$NOTE_ID', '$BUYER_ID', 'note', 'active', '$ORDER_ID', '$PID', '测试笔记', '测试标题', '[\"$HASH\"]', datetime('now','-3 days'))"

# 准备一个超 30d 的笔记（关联另一个旧订单）
OLD_ORDER="ord_test_old_$(date +%s)"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$OLD_ORDER', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'completed', datetime('now','-60 days'), datetime('now','-60 days'))"
OLD_NOTE="shr_test_old_$(date +%s)"
OLD_HASH="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
sqlite3 "$DB" "INSERT INTO shareables (id, owner_id, type, status, related_order_id, related_product_id, native_text, title, photo_hashes, created_at) VALUES ('$OLD_NOTE', '$BUYER_ID', 'note', 'active', '$OLD_ORDER', '$PID', '老笔记', '老标题', '[\"$OLD_HASH\"]', datetime('now','-1 days'))"
# 笔记 1d 前发，订单 60d 前完成 → 笔记距订单 59d > 30d → verified_buyer = false

# 无 related_order_id + 无图的纯文字笔记（旧版本）
TEXT_NOTE="shr_test_text_$(date +%s)"
sqlite3 "$DB" "INSERT INTO shareables (id, owner_id, type, status, related_product_id, native_text, title, photo_hashes, created_at) VALUES ('$TEXT_NOTE', '$BUYER_ID', 'note', 'active', '$PID', '纯文字', '纯文字', NULL, datetime('now','-1 days'))"

echo ""
echo "=== 1. GET /api/shareables/:id — verified_buyer + original_photos ==="
RESP=$(curl -sS "$BASE/api/shareables/$NOTE_ID")
VB=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('badges',{}).get('verified_buyer'))")
chk "5d 订单+3d 笔记 → verified_buyer=true" "True" "$VB"
OP=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('badges',{}).get('original_photos'))")
chk "有图 → original_photos=true" "True" "$OP"

echo ""
echo "=== 2. 超 30d 笔记 → verified_buyer=false ==="
RESP=$(curl -sS "$BASE/api/shareables/$OLD_NOTE")
VB=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('badges',{}).get('verified_buyer'))")
chk "60d 订单+1d 笔记 → verified_buyer=false" "False" "$VB"

echo ""
echo "=== 3. 无图笔记 → original_photos=false ==="
RESP=$(curl -sS "$BASE/api/shareables/$TEXT_NOTE")
OP=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('badges',{}).get('original_photos'))")
chk "无图 → original_photos=false" "False" "$OP"
VB=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('badges',{}).get('verified_buyer'))")
chk "无 related_order_id → verified_buyer=false" "False" "$VB"

echo ""
echo "=== 4. GET /api/shareables/by-product — 列表每条带 badges ==="
RESP=$(curl -sS "$BASE/api/shareables/by-product/$PID" -H "Authorization: Bearer $BUYER_KEY")
NEW_NOTE_VB=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=next((s for s in d.get('shareables',[]) if s.get('id')=='$NOTE_ID'), None)
print(n.get('badges',{}).get('verified_buyer') if n else 'missing')
")
chk "by-product 列表带 badges" "True" "$NEW_NOTE_VB"

echo ""
echo "=== 5. GET /api/notes — feed 每条带 badges ==="
RESP=$(curl -sS "$BASE/api/notes?sort=newest&limit=30")
FEED_BADGE=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=next((s for s in d.get('items',[]) if s.get('id')=='$NOTE_ID'), None)
print(n.get('badges',{}).get('verified_buyer') if n else 'missing')
")
chk "feed 列表带 badges" "True" "$FEED_BADGE"

echo ""
echo "=== 6. GET /api/users/:id/shareables — 用户笔记带 badges ==="
RESP=$(curl -sS "$BASE/api/users/$BUYER_ID/shareables")
USER_BADGE=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=next((s for s in d.get('shareables',[]) if s.get('id')=='$NOTE_ID'), None)
print(n.get('badges',{}).get('verified_buyer') if n else 'missing')
")
chk "用户笔记列表带 badges" "True" "$USER_BADGE"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM shareables WHERE id IN ('$NOTE_ID','$OLD_NOTE','$TEXT_NOTE')"
sqlite3 "$DB" "DELETE FROM orders WHERE id IN ('$ORDER_ID','$OLD_ORDER')"
sqlite3 "$DB" "DELETE FROM note_photo_index WHERE shareable_id IN ('$NOTE_ID','$OLD_NOTE','$TEXT_NOTE')" 2>/dev/null
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
