#!/usr/bin/env bash
# 库存预警 + 自动下架 冒烟测试
# 覆盖：DB 字段加入 + edit endpoint 接受新字段 + checkStockAndMaybeDelist 触发
set -u
BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:-key_mpaegv8rs38f}"   # 李四店铺 (seller)
PASS=0; FAIL=0; FAIL_LOG=""

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 清理近期通知残留（多次跑测试 + 1 分钟时窗会累计）
sqlite3 ~/.webaz/webaz.db "DELETE FROM notifications WHERE (title LIKE '%库存%' OR title LIKE '%自动下架%') AND created_at > datetime('now','-30 minutes')"

echo "=== 1. DB 列已加入 ==="
HAS_COLS=$(sqlite3 ~/.webaz/webaz.db "SELECT COUNT(1) FROM pragma_table_info('products') WHERE name IN ('low_stock_threshold','auto_delist_on_zero','low_stock_alerted_at','auto_delisted_at')")
chk "4 列存在" "4" "$HAS_COLS"

echo ""
echo "=== 2. 创建测试商品 ==="
PROD_JSON=$(curl -sS -X POST "$BASE/api/products" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"库存测试品","description":"自动化测试用","price":10,"stock":5,"category":"家居"}')
PID=$(echo "$PROD_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('product_id') or json.load(sys.stdin).get('id') or '')")
if [[ -z "$PID" ]]; then
  echo "✗ 创建商品失败 — $PROD_JSON"; exit 1
fi
echo "✓ 创建商品 $PID"

echo ""
echo "=== 3. GET 商品包含新字段 ==="
P_JSON=$(curl -sS "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY")
THRESH=$(echo "$P_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('low_stock_threshold'))")
chk "默认阈值 = 3" "3" "$THRESH"
AUTO=$(echo "$P_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auto_delist_on_zero'))")
chk "默认自动下架 = 1" "1" "$AUTO"

echo ""
echo "=== 4. PUT 更新阈值 ==="
PUT_JSON=$(curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"low_stock_threshold":2,"auto_delist_on_zero":0}')
OK=$(echo "$PUT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success'))")
chk "PUT 成功" "True" "$OK"

P_JSON=$(curl -sS "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY")
THRESH=$(echo "$P_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('low_stock_threshold'))")
chk "阈值已更新 = 2" "2" "$THRESH"
AUTO=$(echo "$P_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auto_delist_on_zero'))")
chk "自动下架关闭 = 0" "0" "$AUTO"

echo ""
echo "=== 5. 模拟扣库存到阈值下 → 应发通知 ==="
# 直接 SQL 模拟（避免要走完整下单流程）
sqlite3 ~/.webaz/webaz.db "UPDATE products SET stock = 1, low_stock_threshold = 3, auto_delist_on_zero = 1, low_stock_alerted_at = NULL WHERE id = '$PID'"
curl -sS -X POST "$BASE/api/_dev/trigger-stock-check?product_id=$PID" -H "Authorization: Bearer $KEY" > /dev/null 2>&1 || true
# 由于没有 dev 触发端点，改为通过 PUT 触发：把 stock 从 5 -> 1
sqlite3 ~/.webaz/webaz.db "UPDATE products SET stock = 5, low_stock_threshold = 3 WHERE id = '$PID'"
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"stock":1}' > /dev/null

SELLER_ID=$(sqlite3 ~/.webaz/webaz.db "SELECT seller_id FROM products WHERE id = '$PID'")
NTF_CNT=$(sqlite3 ~/.webaz/webaz.db "SELECT COUNT(1) FROM notifications WHERE user_id = '$SELLER_ID' AND title LIKE '%库存预警%' AND created_at > datetime('now','-1 minute')")
chk "低库存通知已发" "1" "$NTF_CNT"

echo ""
echo "=== 6. stock=0 + auto_delist=1 → 自动下架 ==="
sqlite3 ~/.webaz/webaz.db "UPDATE products SET stock = 1, status = 'active', auto_delist_on_zero = 1, auto_delisted_at = NULL WHERE id = '$PID'"
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"stock":0}' > /dev/null

STATUS=$(sqlite3 ~/.webaz/webaz.db "SELECT status FROM products WHERE id = '$PID'")
chk "状态变为 warehouse" "warehouse" "$STATUS"
HAS_DELIST_AT=$(sqlite3 ~/.webaz/webaz.db "SELECT CASE WHEN auto_delisted_at IS NULL THEN 0 ELSE 1 END FROM products WHERE id = '$PID'")
chk "auto_delisted_at 已记录" "1" "$HAS_DELIST_AT"
DELIST_NTF=$(sqlite3 ~/.webaz/webaz.db "SELECT COUNT(1) FROM notifications WHERE user_id = '$SELLER_ID' AND title LIKE '%自动下架%' AND created_at > datetime('now','-1 minute')")
chk "自动下架通知已发" "1" "$DELIST_NTF"

echo ""
echo "=== 7. stock=0 + auto_delist=0 → 保持 active ==="
sqlite3 ~/.webaz/webaz.db "UPDATE products SET stock = 1, status = 'active', auto_delist_on_zero = 0 WHERE id = '$PID'"
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"stock":0}' > /dev/null
STATUS=$(sqlite3 ~/.webaz/webaz.db "SELECT status FROM products WHERE id = '$PID'")
chk "关闭自动下架时状态保持 active" "active" "$STATUS"

echo ""
echo "=== 8. 24h 去重：同商品 1 分钟内不重发 ==="
sqlite3 ~/.webaz/webaz.db "DELETE FROM notifications WHERE user_id = '$SELLER_ID' AND title LIKE '%库存预警%'"
sqlite3 ~/.webaz/webaz.db "UPDATE products SET stock = 5, low_stock_threshold = 3, low_stock_alerted_at = NULL WHERE id = '$PID'"
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"stock":2}' > /dev/null
sleep 1
sqlite3 ~/.webaz/webaz.db "UPDATE products SET stock = 5 WHERE id = '$PID'"   # 模拟补货
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"stock":1}' > /dev/null
NTF_CNT=$(sqlite3 ~/.webaz/webaz.db "SELECT COUNT(1) FROM notifications WHERE user_id = '$SELLER_ID' AND title LIKE '%库存预警%' AND created_at > datetime('now','-1 minute')")
chk "24h 内仅发 1 次通知（去重）" "1" "$NTF_CNT"

echo ""
echo "=== 清理 ==="
sqlite3 ~/.webaz/webaz.db "DELETE FROM notifications WHERE user_id = '$SELLER_ID' AND title LIKE '%库存%'"
sqlite3 ~/.webaz/webaz.db "DELETE FROM products WHERE id = '$PID'"  # 硬删 — 避免 rate limit 累计计数
echo "✓ 已清理测试商品 $PID"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败：$FAIL_LOG"; exit 1; }
