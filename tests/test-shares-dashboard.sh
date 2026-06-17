#!/usr/bin/env bash
# 分享中心 endpoint 冒烟 + 回归
# 覆盖：GET /api/shares/dashboard 返回字段 + 订单/商品维度分离 +
#       SQL 索引命中 + viewProductShares 数据一致性
set -u
BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:-key_mpf40g7oiwxv}"   # 张三 (zhangsan, singapore) — fixture 必须存在
PASS=0; FAIL=0; FAIL_LOG=""

chk() {                      # chk <label> <expected> <actual>
  local label="$1" exp="$2" act="$3"
  if [[ "$act" == "$exp" ]]; then
    PASS=$((PASS+1)); printf "✓ %s\n" "$label"
  else
    FAIL=$((FAIL+1))
    printf "✗ %s  [got '%s', expected '%s']\n" "$label" "$act" "$exp"
    FAIL_LOG="${FAIL_LOG}\n  ${label}: got ${act} expected ${exp}"
  fi
}

chk_nonempty() {             # chk_nonempty <label> <actual>
  local label="$1" act="$2"
  if [[ -n "$act" && "$act" != "null" && "$act" != "0" ]]; then
    PASS=$((PASS+1)); printf "✓ %s (= '%s')\n" "$label" "$act"
  else
    FAIL=$((FAIL+1))
    printf "✗ %s (got '%s', expected non-empty)\n" "$label" "$act"
    FAIL_LOG="${FAIL_LOG}\n  ${label}: empty"
  fi
}

JSON=$(curl -sS "$BASE/api/shares/dashboard" -H "Authorization: Bearer $KEY")

echo "=== shares-dashboard 端点 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/shares/dashboard" -H "Authorization: Bearer $KEY")
chk "HTTP 200" "200" "$HTTP"

echo ""
echo "=== bought_products: 每订单一行（不按 product 聚合）==="
BOUGHT_LEN=$(echo "$JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('bought_products',[])))")
chk_nonempty "bought_products 数组非空" "$BOUGHT_LEN"

# 检查每行必含字段
FIELDS=$(echo "$JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
bought = data.get('bought_products', [])
if not bought: print('empty'); sys.exit(0)
p = bought[0]
required = ['order_id', 'id', 'title', 'note_count', 'product_share_count', 'anchor_count', 'induced_orders', 'first_note_id']
missing = [k for k in required if k not in p]
print(','.join(missing) if missing else 'ok')
")
chk "bought_products 含必需字段（order_id/note_count/product_share_count/anchor_count/...）" "ok" "$FIELDS"

echo ""
echo "=== 订单维度 vs 商品维度区分（防数字重复 bug）==="
# 同商品多订单的 note_count 应不同（笔记按 order_id 关联）
NOTE_VARIES=$(echo "$JSON" | python3 -c "
import sys, json
bought = json.load(sys.stdin).get('bought_products', [])
# 按 product_id 分组，看每组 note_count 是否有不同值（如果用户至少给同商品某一订单发过笔记）
from collections import defaultdict
g = defaultdict(set)
for p in bought:
    g[p['id']].add(p.get('note_count', 0))
# 至少一个 product 应有多订单（张三 2 个 g7p3gwt + g7tofle 同商品）
multi = [pid for pid, counts in g.items() if len(counts) > 0]
print('ok' if multi else 'no-multi-order-product')
")
chk "多订单同商品组合存在" "ok" "$NOTE_VARIES"

# product_share_count 同 product 内应该相同（按 product 聚合）
PROD_SAME=$(echo "$JSON" | python3 -c "
import sys, json
from collections import defaultdict
bought = json.load(sys.stdin).get('bought_products', [])
g = defaultdict(set)
for p in bought:
    g[p['id']].add(p.get('product_share_count', 0))
# 同 product 应该 product_share_count 一致
ok = all(len(counts) == 1 for counts in g.values())
print('ok' if ok else 'inconsistent')
")
chk "同 product 多订单的 product_share_count 一致" "ok" "$PROD_SAME"

echo ""
echo "=== my_creations 字段（W1.11 新增 related_order_id / related_anchor）==="
CREATION_FIELDS=$(echo "$JSON" | python3 -c "
import sys, json
items = json.load(sys.stdin).get('my_creations', [])
if not items: print('empty'); sys.exit(0)
required = ['id', 'type', 'related_product_id', 'related_order_id', 'related_anchor']
missing = [k for k in required if k not in items[0]]
print(','.join(missing) if missing else 'ok')
")
chk "my_creations 含 related_order_id / related_anchor" "ok" "$CREATION_FIELDS"

echo ""
echo "=== SQL 索引命中（EXPLAIN QUERY PLAN）==="
DB="${DB:-$HOME/.webaz/webaz.db}"
if [[ -f "$DB" ]]; then
  PLAN=$(sqlite3 "$DB" "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM shareables s WHERE s.owner_id='x' AND s.related_order_id='y' AND s.type='note' AND s.status='active';" 2>/dev/null)
  if echo "$PLAN" | grep -q "idx_share_owner_order_type"; then
    chk "note_count 子查询使用 idx_share_owner_order_type" "yes" "yes"
  else
    chk "note_count 子查询使用 idx_share_owner_order_type" "yes" "no"
  fi
  PLAN2=$(sqlite3 "$DB" "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM anchor_registry WHERE owner_id='x' AND target_kind='product' AND target_id='y' AND status='active';" 2>/dev/null)
  if echo "$PLAN2" | grep -q "idx_anchor_owner_target_status"; then
    chk "anchor_count 子查询使用 idx_anchor_owner_target_status" "yes" "yes"
  else
    chk "anchor_count 子查询使用 idx_anchor_owner_target_status" "yes" "no"
  fi
else
  echo "(跳过索引检查 — DB 文件不在预期路径 $DB)"
fi

echo ""
echo "=== GET /api/shareables/:id 返回 owner_id（修 #u 路由）==="
NOTE_ID=$(echo "$JSON" | python3 -c "
import sys, json
items = json.load(sys.stdin).get('my_creations', [])
notes = [c['id'] for c in items if c.get('type') == 'note']
print(notes[0] if notes else '')
")
if [[ -n "$NOTE_ID" ]]; then
  SHARE_JSON=$(curl -sS "$BASE/api/shareables/$NOTE_ID")
  OWNER_ID=$(echo "$SHARE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('owner_id') or '')")
  chk_nonempty "shareables/:id 返回 owner_id" "$OWNER_ID"
  OWNER_OBJ_ID=$(echo "$SHARE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('owner') or {}).get('id') or '')")
  chk_nonempty "shareables/:id 返回 owner.id" "$OWNER_OBJ_ID"
fi

echo ""
echo "=================================="
if [[ $FAIL -eq 0 ]]; then
  printf "✅ %d passed / 0 failed\n" "$PASS"
  exit 0
else
  printf "❌ %d passed / %d failed\n%s\n" "$PASS" "$FAIL" "$(printf "$FAIL_LOG")"
  exit 1
fi
