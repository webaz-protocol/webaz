#!/usr/bin/env bash
# S5 极致性价比认证 — 算法 + 持久化 + leaderboard + 治理参数
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
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('products') WHERE name IN ('value_badge','value_badge_at','value_badge_rank','value_badge_pct')")
chk "4 列存在" "4" "$HAS"

echo ""
echo "=== 2. 治理参数已注册 ==="
PCT_PARAM=$(sqlite3 "$DB" "SELECT value FROM protocol_params WHERE key='value_badge_top_pct'")
chk "value_badge_top_pct = 0.20" "0.20" "$PCT_PARAM"
SAMPLE_PARAM=$(sqlite3 "$DB" "SELECT value FROM protocol_params WHERE key='value_badge_min_sample'")
chk "value_badge_min_sample = 5" "5" "$SAMPLE_PARAM"

echo ""
echo "=== 3. 启动时 daily batch 已跑 ==="
BADGED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM products WHERE value_badge = 1 AND status = 'active'")
echo "认证商品数: $BADGED"
HAS_BADGED=$([[ $BADGED -gt 0 ]] && echo ok || echo zero)
chk "至少有 1 个认证商品" "ok" "$HAS_BADGED"

# 验证算法正确性 — 取一个类目，看认证的是不是最便宜的
echo ""
echo "=== 4. 算法正确性 — 认证商品按价格升序 ==="
CAT=$(sqlite3 "$DB" "SELECT category FROM products WHERE value_badge = 1 AND status='active' LIMIT 1")
[[ -z "$CAT" ]] && { echo "✗ 没有认证商品可验证"; exit 1; }
echo "选中类目: $CAT"
RANK1_PRICE=$(sqlite3 "$DB" "SELECT price FROM products WHERE category='$CAT' AND status='active' AND value_badge=1 ORDER BY value_badge_rank ASC LIMIT 1")
CAT_MIN_PRICE=$(sqlite3 "$DB" "SELECT MIN(price) FROM products WHERE category='$CAT' AND status='active' AND stock > 0")
chk "类目 rank=1 = 类目最低价" "$CAT_MIN_PRICE" "$RANK1_PRICE"

echo ""
echo "=== 5. value_badge_pct 计算正确 ==="
ROW=$(sqlite3 "$DB" "SELECT id, price, value_badge_pct FROM products WHERE value_badge = 1 AND value_badge_pct IS NOT NULL LIMIT 1")
PCT=$(echo "$ROW" | cut -d'|' -f3)
HAS_PCT=$([[ "$PCT" =~ ^-?[0-9.]+$ ]] && echo "ok" || echo "bad:$PCT")
chk "pct 是数字" "ok" "$HAS_PCT"

echo ""
echo "=== 6. leaderboard kind=value_products ==="
RESP=$(curl -sS "$BASE/api/leaderboard?kind=value_products&limit=20")
HAS_ITEMS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('items'), list) else 'no')")
chk "items 是数组" "yes" "$HAS_ITEMS"
COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['items']))")
echo "榜单条数: $COUNT"
HAS_ANY=$([[ $COUNT -gt 0 ]] && echo "ok" || echo "empty")
chk "榜单至少 1 条" "ok" "$HAS_ANY"

FIRST_RANK=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['items'][0]['value_badge_rank']) if d['items'] else print('empty')")
chk "首条 value_badge_rank = 1" "1" "$FIRST_RANK"

echo ""
echo "=== 7. GET /api/products/:id 含 value_badge 字段 ==="
BADGED_PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE value_badge=1 LIMIT 1")
RESP=$(curl -sS "$BASE/api/products/$BADGED_PID")
VB=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('value_badge'))")
chk "product 详情含 value_badge=1" "1" "$VB"

echo ""
echo "=== 8. admin 手动触发重算 ==="
ADMIN_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='admin' LIMIT 1")
RESP=$(curl -sS -X POST "$BASE/api/admin/_dev/recompute-value-badges" -H "Authorization: Bearer $ADMIN_KEY")
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "admin 重算成功" "True" "$OK"

echo ""
echo "=== 9. 非 admin 不能触发 → 403 ==="
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' LIMIT 1")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/_dev/recompute-value-badges" -H "Authorization: Bearer $BUYER_KEY")
chk "buyer 触发被拒" "403" "$HTTP"

echo ""
echo "=== 10. 小样本类目跳过 ==="
# 找一个少于 5 个商品的类目
SMALL_CAT=$(sqlite3 "$DB" "SELECT category FROM products WHERE status='active' GROUP BY category HAVING COUNT(*) < 5 LIMIT 1")
if [[ -n "$SMALL_CAT" ]]; then
  SMALL_BADGED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM products WHERE category='$SMALL_CAT' AND value_badge=1")
  chk "小样本类目 '$SMALL_CAT' 无认证（保护新类目）" "0" "$SMALL_BADGED"
else
  echo "(skip — no small-sample categories present)"
fi

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
