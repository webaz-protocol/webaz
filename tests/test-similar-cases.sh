#!/usr/bin/env bash
# A2 同类判例提示 endpoint 冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

ARB_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='arbitrator' LIMIT 1")
DISPUTE_ID=$(sqlite3 "$DB" "SELECT id FROM disputes LIMIT 1")
[[ -z "$ARB_KEY" || -z "$DISPUTE_ID" ]] && { echo "✗ 需要至少 1 arbitrator + 1 dispute"; exit 1; }

# 找该 dispute 的 product_category
ORDER_ID=$(sqlite3 "$DB" "SELECT order_id FROM disputes WHERE id='$DISPUTE_ID'")
PID=$(sqlite3 "$DB" "SELECT product_id FROM orders WHERE id='$ORDER_ID'")
PCAT=$(sqlite3 "$DB" "SELECT category FROM products WHERE id='$PID'")
echo "Dispute: $DISPUTE_ID  Product cat: $PCAT"

# 注入 3 个测试判例：1 个同类目，1 个关键词命中（取 dispute.reason 第 1 个词），1 个不相关
REASON=$(sqlite3 "$DB" "SELECT reason FROM disputes WHERE id='$DISPUTE_ID'")
KW=$(echo "$REASON" | head -c 6)
echo "Reason keyword sample: $KW"

# 找一个具有该 category 的产品（同类目）
SIM_PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE category='$PCAT' AND id != '$PID' LIMIT 1")
if [[ -z "$SIM_PID" ]]; then
  # 用同一 product 即可（不影响测试）
  SIM_PID="$PID"
fi
OTHER_PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE category != '$PCAT' OR category IS NULL LIMIT 1")

for tag in "case_same_cat" "case_kw" "case_other"; do
  DC="dcase_test_a2_${tag}_$RANDOM"
  if [[ "$tag" == "case_same_cat" ]]; then
    USE_PID="$SIM_PID"; RUL="无关 ruling"
  elif [[ "$tag" == "case_kw" ]]; then
    USE_PID="$OTHER_PID"; RUL="$KW 出现在判决书内"
  else
    USE_PID="$OTHER_PID"; RUL="无关 ruling"
  fi
  SELLER=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$USE_PID'")
  sqlite3 "$DB" "INSERT INTO dispute_cases (id, dispute_id, order_id, product_id, seller_id, buyer_id, category_tag, winner, resolution, amount_bucket, buyer_argument, seller_argument, ruling_text, fairness_yes, fairness_no, comment_count, published_at) VALUES ('$DC','d_$tag','o_$tag','$USE_PID','$SELLER','b','物流','buyer','r','100-500','ba','sa','$RUL',0,0,0,datetime('now'))"
  eval "ID_$tag=$DC"
done

echo ""
echo "=== 1. endpoint 200 + items 数组 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/disputes/$DISPUTE_ID/similar-cases" -H "Authorization: Bearer $ARB_KEY")
chk "HTTP 200" "200" "$HTTP"
RESP=$(curl -sS "$BASE/api/disputes/$DISPUTE_ID/similar-cases" -H "Authorization: Bearer $ARB_KEY")
IS_ARR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('items'), list) else 'no')")
chk "items 是数组" "yes" "$IS_ARR"

echo ""
echo "=== 2. 限制 3 条 ==="
COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['items']))")
LEQ3=$([[ $COUNT -le 3 ]] && echo "ok" || echo "got $COUNT")
chk "items 数 ≤ 3" "ok" "$LEQ3"

echo ""
echo "=== 3. 同类目判例优先 ==="
FIRST=$(echo "$RESP" | python3 -c "import sys,json; items=json.load(sys.stdin)['items']; print(items[0].get('match_reason') if items else 'empty')")
chk "首条 match_reason=same_category（同类目优先）" "same_category" "$FIRST"

echo ""
echo "=== 4. product_category + reason_keywords 返回 ==="
HAS_CAT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('product_category') else 'no')")
chk "返回 product_category 字段" "yes" "$HAS_CAT"
HAS_KW=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('reason_keywords'), list) else 'no')")
chk "返回 reason_keywords 数组" "yes" "$HAS_KW"

echo ""
echo "=== 5. 非当事人 + 非 arbitrator → 403 ==="
BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u WHERE u.role='buyer' AND u.id NOT IN (SELECT initiator_id FROM disputes WHERE id='$DISPUTE_ID') AND u.id NOT IN (SELECT COALESCE(defendant_id,'') FROM disputes WHERE id='$DISPUTE_ID') LIMIT 1")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/disputes/$DISPUTE_ID/similar-cases" -H "Authorization: Bearer $BUYER_KEY")
chk "外人 403" "403" "$HTTP"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM dispute_cases WHERE id LIKE 'dcase_test_a2_%'"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
