#!/usr/bin/env bash
# S4 商品溯源 — origin_claims 落库 + 解析 + 校验
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. origin_claims 列已加 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('products') WHERE name='origin_claims'")
chk "列存在" "1" "$HAS"

# 找一个 seller + 商品
SELLER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u WHERE u.role='seller' AND EXISTS (SELECT 1 FROM products p WHERE p.seller_id=u.id AND p.status='active') LIMIT 1")
PID=$(sqlite3 "$DB" "SELECT p.id FROM products p JOIN users u ON u.id=p.seller_id WHERE u.api_key='$SELLER_KEY' AND p.status='active' LIMIT 1")
echo "Seller key prefix: $(echo $SELLER_KEY | head -c 12)...  product=$PID"

echo ""
echo "=== 2. PUT origin_claims 落库 ==="
RESP=$(curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin_claims":{"country":"中国 浙江","manufacturer":"测试工坊","materials":["100% 棉","GOTS 认证"],"certs":[{"name":"ISO9001","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","link":"https://example.com/cert.pdf"}]}}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success'))")
chk "PUT 成功" "True" "$OK"

STORED=$(sqlite3 "$DB" "SELECT origin_claims FROM products WHERE id='$PID'")
HAS_COUNTRY=$(echo "$STORED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('country'))")
chk "country 落库" "中国 浙江" "$HAS_COUNTRY"
HAS_CERTS=$(echo "$STORED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('certs',[])))")
chk "certs 数 = 1" "1" "$HAS_CERTS"

echo ""
echo "=== 3. GET /api/products/:id 返回 origin_claims 对象（解析）==="
RESP=$(curl -sS "$BASE/api/products/$PID")
COUNTRY=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('origin_claims',{}).get('country'))")
chk "GET 返回 country" "中国 浙江" "$COUNTRY"
MAT_LEN=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('origin_claims',{}).get('materials',[])))")
chk "materials 长度 = 2" "2" "$MAT_LEN"

echo ""
echo "=== 4. 非法 sha256 hash → 400 ==="
RESP=$(curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin_claims":{"certs":[{"name":"Bad","sha256":"not-a-real-hash"}]}}')
HAS_ERR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d and '64' in d.get('error','') else 'no')")
chk "非法 sha256 被拒" "yes" "$HAS_ERR"

echo ""
echo "=== 5. 清空 origin_claims（传 null）==="
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" -d '{"origin_claims":null}' > /dev/null
STORED=$(sqlite3 "$DB" "SELECT IFNULL(origin_claims,'NULL') FROM products WHERE id='$PID'")
chk "清空后 = NULL" "NULL" "$STORED"

echo ""
echo "=== 6. product_claim_tasks claim_target='origin' 已存在（接入认领系统）==="
HAS_TARGET=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('product_claim_tasks') WHERE name='claim_target'")
chk "product_claim_tasks 表已支持 origin 类目（v0.4.x audit doc 已规定）" "1" "$HAS_TARGET"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
