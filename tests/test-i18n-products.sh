#!/usr/bin/env bash
# S3 跨境上架（多语言 MVP）冒烟
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. 两个 i18n 列已加 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('products') WHERE name IN ('i18n_titles','i18n_descs')")
chk "2 列存在" "2" "$HAS"

SELLER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u JOIN products p ON p.seller_id=u.id WHERE p.status='active' LIMIT 1")
PID=$(sqlite3 "$DB" "SELECT p.id FROM products p JOIN users u ON u.id=p.seller_id WHERE u.api_key='$SELLER_KEY' AND p.status='active' LIMIT 1")
echo "Seller key prefix: $(echo $SELLER_KEY | head -c 12)... product=$PID"

echo ""
echo "=== 2. PUT i18n_titles + i18n_descs 落库 ==="
RESP=$(curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"i18n_titles":{"en":"Handmade Leather Wallet","ja":"手作りレザー財布"},"i18n_descs":{"en":"Crafted in Hangzhou"}}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success'))")
chk "PUT 成功" "True" "$OK"

STORED_T=$(sqlite3 "$DB" "SELECT i18n_titles FROM products WHERE id='$PID'")
EN_T=$(echo "$STORED_T" | python3 -c "import sys,json; print(json.load(sys.stdin).get('en'))")
chk "en title 落库" "Handmade Leather Wallet" "$EN_T"
JA_T=$(echo "$STORED_T" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ja'))")
chk "ja title 落库" "手作りレザー財布" "$JA_T"

echo ""
echo "=== 3. GET /api/products/:id 不带 Accept-Language → 中文 ==="
RESP=$(curl -sS "$BASE/api/products/$PID")
LANG=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('_lang'))")
chk "_lang = zh" "zh" "$LANG"

echo ""
echo "=== 4. GET 带 Accept-Language: en → 标题 swap 成英文 ==="
RESP=$(curl -sS -H "Accept-Language: en-US" "$BASE/api/products/$PID")
LANG=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('_lang'))")
chk "_lang = en" "en" "$LANG"
TITLE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title'))")
chk "title swap 为英文" "Handmade Leather Wallet" "$TITLE"
DESC=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description'))")
chk "description swap 为英文" "Crafted in Hangzhou" "$DESC"

echo ""
echo "=== 5. Accept-Language: ja → title 切日文，description 缺译回落中文 ==="
RESP=$(curl -sS -H "Accept-Language: ja-JP" "$BASE/api/products/$PID")
TITLE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title'))")
chk "title swap 为日文" "手作りレザー財布" "$TITLE"
DESC=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('en' if d.get('description')=='Crafted in Hangzhou' else 'zh-fallback')")
chk "description 日译缺失回落中文" "zh-fallback" "$DESC"

echo ""
echo "=== 6. 不支持的语言（ar）→ 自动回落 zh ==="
RESP=$(curl -sS -H "Accept-Language: ar-SA" "$BASE/api/products/$PID")
LANG=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('_lang'))")
chk "_lang = zh（ar 未支持回落）" "zh" "$LANG"

echo ""
echo "=== 7. PUT i18n_titles=null → 清空 ==="
curl -sS -X PUT "$BASE/api/products/$PID" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" -d '{"i18n_titles":null,"i18n_descs":null}' > /dev/null
STORED=$(sqlite3 "$DB" "SELECT IFNULL(i18n_titles,'NULL') FROM products WHERE id='$PID'")
chk "清空后 NULL" "NULL" "$STORED"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
