#!/usr/bin/env bash
# A1 仲裁判例搜索 + 分类 + 排序
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 注入 3 个测试判例
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")

for i in 1 2 3; do
  DC="dcase_test_a1_${i}_$RANDOM"
  CAT="物流"; WIN="buyer"; RUL="顺丰包裹延误超过 7 天"
  COMM=2
  if [[ $i == 2 ]]; then CAT="质量"; WIN="seller"; RUL="商品质量符合描述，买家主观感受"; COMM=8; fi
  if [[ $i == 3 ]]; then CAT="描述不符"; WIN="dismissed"; RUL="证据不足以裁定"; COMM=15; fi
  sqlite3 "$DB" "INSERT INTO dispute_cases (id, dispute_id, order_id, product_id, seller_id, buyer_id, category_tag, winner, resolution, amount_bucket, buyer_argument, seller_argument, ruling_text, fairness_yes, fairness_no, comment_count, published_at) VALUES ('$DC', 'd_$i', 'o_$i', '$PID', '$SELLER_ID', 'b_$i', '$CAT', '$WIN', '判决 $i', '100-500', '买家陈述 $i', '卖家陈述 $i', '$RUL', $((10+i)), 0, $COMM, datetime('now','-${i} hours'))"
  eval "DC_$i=$DC"
done

echo "=== 1. 基础列表 ==="
RESP=$(curl -sS "$BASE/api/disputes/cases")
HAS_TOTAL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total'))")
chk "返回 total 字段" "$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['items']))")" "$HAS_TOTAL"

echo ""
echo "=== 2. q 全文搜索 — 命中 ruling_text ==="
RESP=$(curl -sS -G "$BASE/api/disputes/cases" --data-urlencode "q=顺丰")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$DC_1' for i in d.get('items',[])) else 'no')")
chk "搜'顺丰'命中判例 1" "yes" "$FOUND"
NOT_FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$DC_2' for i in d.get('items',[])) else 'no')")
chk "判例 2 不在'顺丰'结果" "no" "$NOT_FOUND"
QECHO=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('query'))")
chk "返回 query 字段" "顺丰" "$QECHO"

echo ""
echo "=== 3. q + category 组合 ==="
RESP=$(curl -sS -G "$BASE/api/disputes/cases" --data-urlencode "q=质量" --data-urlencode "category=质量")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$DC_2' for i in d.get('items',[])) else 'no')")
chk "组合过滤命中" "yes" "$FOUND"

echo ""
echo "=== 4. winner=dismissed 过滤 ==="
RESP=$(curl -sS "$BASE/api/disputes/cases?winner=dismissed")
FOUND=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(i.get('id')=='$DC_3' for i in d.get('items',[])) else 'no')")
chk "dismissed 过滤生效" "yes" "$FOUND"

echo ""
echo "=== 5. sort=discussed 排序 ==="
RESP=$(curl -sS "$BASE/api/disputes/cases?sort=discussed&limit=50")
# 判例 3 评论 15 应该在 2 (8) 之前
ORDER=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ids = [i.get('id') for i in d.get('items',[]) if i.get('id') in ['$DC_1','$DC_2','$DC_3']]
print('ok' if ids.index('$DC_3') < ids.index('$DC_2') < ids.index('$DC_1') else 'wrong:' + ','.join(ids))
")
chk "discussed 排序：3 > 2 > 1（评论数 15>8>2）" "ok" "$ORDER"

echo ""
echo "=== 6. 字段 sort=fair 排序 ==="
RESP=$(curl -sS "$BASE/api/disputes/cases?sort=fair&limit=50")
ORDER=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ids = [i.get('id') for i in d.get('items',[]) if i.get('id') in ['$DC_1','$DC_2','$DC_3']]
# fair_yes: 11,12,13 → 3,2,1 顺序
print('ok' if ids.index('$DC_3') < ids.index('$DC_2') < ids.index('$DC_1') else 'wrong:' + ','.join(ids))
")
chk "fair 排序：3 > 2 > 1（fairness_yes 13>12>11）" "ok" "$ORDER"

echo ""
echo "=== 7. category_counts 受 q 影响 ==="
RESP=$(curl -sS -G "$BASE/api/disputes/cases" --data-urlencode "q=顺丰")
COUNTS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('category_counts',[])))")
chk "搜索时 category_counts 只含匹配类目" "1" "$COUNTS"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM dispute_cases WHERE id LIKE 'dcase_test_a1_%'"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
