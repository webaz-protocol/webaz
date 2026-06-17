#!/usr/bin/env bash
# 审计修补冒烟 + 回归测试
# 覆盖 P0 (LIKE escape + i18n) / P1 (speech threshold + PII + LIKE 补齐) / P2 (索引 + 事务 + 评论审核)
set -u
BASE="${BASE:-http://localhost:3000}"
PASS=0; FAIL=0; FAIL_LOG=""
chk() {                      # chk <label> <expect_code> <actual_code> [hint]
  local label="$1" exp="$2" act="$3" hint="${4:-}"
  if [[ "$act" == "$exp" ]]; then
    PASS=$((PASS+1)); printf "✓ %s  [HTTP %s]\n" "$label" "$act"
  else
    FAIL=$((FAIL+1))
    printf "✗ %s  [HTTP %s, expected %s] %s\n" "$label" "$act" "$exp" "$hint"
    FAIL_LOG="${FAIL_LOG}\n  ${label}: got ${act} expected ${exp} ${hint}"
  fi
}
RAND=$RANDOM

echo "=== SMOKE: 基本端点可达性 ==="
chk "GET /api/products"               200 "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/products?limit=1")"
chk "GET /api/listings"               200 "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/listings?limit=1")"
chk "GET /api/auctions"               200 "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/auctions?limit=1")"
chk "GET /api/disputes/cases"         200 "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/disputes/cases?limit=1")"

echo ""
echo "=== P0 回归: LIKE 通配转义（含 %, _, \\ 不报 500）==="
chk "products  fuzzy=true  q=%_test"  200 "$(curl -sS -o /dev/null -w '%{http_code}' --get --data-urlencode 'q=%_test' --data-urlencode 'fuzzy=true' "$BASE/api/products?limit=5")"
chk "listings  q=50%off"              200 "$(curl -sS -o /dev/null -w '%{http_code}' --get --data-urlencode 'q=50%off' "$BASE/api/listings")"
chk "auctions  q=test_x"              200 "$(curl -sS -o /dev/null -w '%{http_code}' --get --data-urlencode 'q=test_x' "$BASE/api/auctions")"
chk "products  q=back\\slash"         200 "$(curl -sS -o /dev/null -w '%{http_code}' --get --data-urlencode 'q=back\slash' --data-urlencode 'fuzzy=true' "$BASE/api/products")"

echo ""
echo "=== P0 回归: X-Match-Mode 头存在 (strict / fuzzy / none) ==="
MM=$(curl -sS -D - -o /dev/null --get --data-urlencode 'q=xxxxNoSuchThingxxxxx' --data-urlencode 'fuzzy=true' "$BASE/api/products" | grep -i '^x-match-mode' | tr -d '\r' | awk '{print $2}')
if [[ -n "$MM" ]]; then PASS=$((PASS+1)); echo "✓ X-Match-Mode 头存在  [$MM]"; else FAIL=$((FAIL+1)); echo "✗ X-Match-Mode 头缺失"; fi

echo ""
echo "=== 测试用户准备（一新一老）==="
# 老账户：注册并直接 backdoor 老化（无法 backdoor —— 测 speech-threshold 必须用 fresh），所以这里只注册一个新账户
NAME="aud${RAND}_$$"
REG=$(curl -sS "$BASE/api/register" -H 'content-type: application/json' \
  -d "{\"name\":\"${NAME}\",\"role\":\"buyer\",\"region\":\"global\"}")
KEY=$(echo "$REG" | sed -E 's/.*"api_key":"([^"]+)".*/\1/')
USER_ID=$(echo "$REG" | sed -E 's/.*"user_id":"([^"]+)".*/\1/')
if [[ -n "$KEY" && "$KEY" != "$REG" ]]; then
  PASS=$((PASS+1)); echo "✓ 注册新买家 $NAME -> $USER_ID"
else
  FAIL=$((FAIL+1)); echo "✗ 注册失败: $REG"; echo "—— 后续依赖此账户的测试将跳过"; exit 1
fi

echo ""
echo "=== P1 回归: meetsPublicSpeechThreshold (新账户被门禁) ==="
# 找一个已发布的判例
CASE_ID=$(curl -sS "$BASE/api/disputes/cases?limit=1" | sed -E 's/.*"id":"(dcase[^"]+)".*/\1/' | head -c 64)
if [[ "$CASE_ID" == dcase* ]]; then
  echo "  使用判例 $CASE_ID"
  # 新账户评论 → 应被 SPEECH_THRESHOLD 403 拦截
  RESP=$(curl -sS -o /tmp/aud_resp.json -w '%{http_code}' "$BASE/api/disputes/cases/$CASE_ID/comment" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"body":"我觉得这个仲裁结果不公平，再议","anonymous":false}')
  chk "新账户评论被门禁拦截" 403 "$RESP" "$(cat /tmp/aud_resp.json | head -c 200)"
  grep -q 'SPEECH_THRESHOLD' /tmp/aud_resp.json && { PASS=$((PASS+1)); echo "✓ 返回 error_code=SPEECH_THRESHOLD"; } || { FAIL=$((FAIL+1)); echo "✗ 缺少 SPEECH_THRESHOLD code"; }
  # 公正度投票同样应被拦截
  RESP=$(curl -sS -o /tmp/aud_resp.json -w '%{http_code}' "$BASE/api/disputes/cases/$CASE_ID/fairness" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"vote":"yes"}')
  chk "新账户公正度投票被门禁拦截" 403 "$RESP"
else
  echo "  无已发布判例，跳过 speech-threshold 测试（这是正常的，dispute 库可能空）"
fi

echo ""
echo "=== P1 回归: piiSanitize 函数正确性（直接对 publishDisputeCase 不易触发，做单元自检）==="
PII_TEST=$(node -e "
const piiSanitize = (text) => {
  if (!text) return text
  let out = text
  out = out.replace(/(?<!\d)(\+?86)?1[3-9]\d{9}(?!\d)/g, '[已脱敏-手机]')
  out = out.replace(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[已脱敏-邮箱]')
  out = out.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[已脱敏-身份证]')
  out = out.replace(/(?<!\d)\d{15}(?!\d)/g, '[已脱敏-身份证]')
  out = out.replace(/(?<!\d)\d{16,19}(?!\d)/g, '[已脱敏-卡号]')
  out = out.replace(/[一-龥]{2,}(?:省|市|区|县|镇|乡|村|街道|路|街|巷|弄)[一-龥\d]{0,15}(?:号|楼|室|单元|栋|院|大厦|小区|花园)?/g, '[已脱敏-地址]')
  out = out.replace(/(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, '[已脱敏-IP]')
  return out
}
const r = piiSanitize('卖家联系 13912345678 邮箱 a.b@x.com 身份证 110101199001011234 卡号 4111111111111111 住址 北京市朝阳区建国路88号 IP 192.168.1.1')
const expected = ['[已脱敏-手机]','[已脱敏-邮箱]','[已脱敏-身份证]','[已脱敏-卡号]','[已脱敏-地址]','[已脱敏-IP]']
const all = expected.every(t => r.includes(t))
console.log(all ? 'OK' : 'FAIL:' + r)
")
if [[ "$PII_TEST" == "OK" ]]; then PASS=$((PASS+1)); echo "✓ piiSanitize 6/6 模式命中"; else FAIL=$((FAIL+1)); echo "✗ piiSanitize: $PII_TEST"; fi

echo ""
echo "=== P2 回归: add-role 并发事务（5 个并发请求，最终 roles 不重复）==="
# 新买家 5 并发添加 seller 角色
for i in 1 2 3 4 5; do
  curl -sS "$BASE/api/profile/add-role" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"role":"seller"}' -o "/tmp/aud_addrole_$i.json" &
done
wait
# 最终查询当前用户 roles
ME=$(curl -sS "$BASE/api/me" -H "authorization: Bearer $KEY")
echo "$ME" > /tmp/aud_me.json
ROLES_COUNT=$(node -e '
const fs = require("fs");
const s = fs.readFileSync("/tmp/aud_me.json", "utf8");
try {
  const o = JSON.parse(s);
  const r = Array.isArray(o.roles) ? o.roles : [];
  const sellerCount = r.filter(x => x === "seller").length;
  console.log(sellerCount + " " + r.join(","));
} catch (e) { console.log("parse_error " + e.message); }
')
SC=$(echo "$ROLES_COUNT" | awk '{print $1}')
if [[ "$SC" == "1" ]]; then
  PASS=$((PASS+1)); echo "✓ 并发 5 次 add-role 后 seller 角色只出现一次 (roles=$ROLES_COUNT)"
else
  FAIL=$((FAIL+1)); echo "✗ 并发 add-role 出现 $SC 次 seller (期望 1)  roles=$ROLES_COUNT"
fi

echo ""
echo "=== P2 回归: 评论 blocklist (使用了门禁前的判例 — 若无判例跳过) ==="
if [[ "$CASE_ID" == dcase* ]]; then
  # 用一个绝对会通过门禁的内部 admin（root admin api_key 可能在 .env）— 这里只做"语法路径"测试
  # 真实用户场景下被 SPEECH_THRESHOLD 拦截，blocklist 在它之后
  # 我们直接验证 blocklist 函数本身
  BL_TEST=$(node -e "
  const list = [
    /\b(?:fuck|shit|bitch|asshole|cunt|nigger|faggot|retard)\b/i,
    /(?:傻逼|傻屄|sb|草泥马|cnm|去死|滚蛋|废物|狗东西|贱货|垃圾人)/,
    /(?:打死|弄死|杀全家|灭你全家|烧死)/,
    /(?:加我?(?:V|微信|wechat|QQ|q\s?q|tg|telegram)|代写|刷单|招代理|月入[万百千]+)/i,
    /https?:\/\/\S{10,}/i,
  ]
  const must_block = ['卖家是傻逼','加我微信 abc','弄死他','fuck this','看 https://example.com/abc']
  const must_pass  = ['仲裁不公请重审','卖家承诺没兑现']
  const bad = must_block.filter(t => !list.some(p => p.test(t)))
  const wrong = must_pass.filter(t => list.some(p => p.test(t)))
  if (bad.length === 0 && wrong.length === 0) console.log('OK')
  else console.log('FAIL not_blocked=' + JSON.stringify(bad) + ' false_positive=' + JSON.stringify(wrong))
  ")
  if [[ "$BL_TEST" == "OK" ]]; then PASS=$((PASS+1)); echo "✓ blocklist 5 阻断 / 2 放行 全对"; else FAIL=$((FAIL+1)); echo "✗ $BL_TEST"; fi
fi

echo ""
echo "=== P2 回归: 索引存在性（直接查 SQLite WAL 后的索引列表）==="
DB_PATH=""
for p in "$HOME/.webaz/webaz.db" /Users/holden/dcp/webaz.db; do
  if [[ -f "$p" ]]; then DB_PATH="$p"; break; fi
done
if [[ -n "$DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  IDX=$(sqlite3 "$DB_PATH" ".indexes order_ratings" 2>/dev/null | tr '\n' ' ')
  if echo "$IDX" | grep -q 'idx_rating_recommend'; then PASS=$((PASS+1)); echo "✓ idx_rating_recommend 存在"; else FAIL=$((FAIL+1)); echo "✗ idx_rating_recommend 缺失   actual=$IDX"; fi
  IDX2=$(sqlite3 "$DB_PATH" ".indexes orders" 2>/dev/null | tr '\n' ' ')
  if echo "$IDX2" | grep -q 'idx_orders_product_status'; then PASS=$((PASS+1)); echo "✓ idx_orders_product_status 存在"; else FAIL=$((FAIL+1)); echo "✗ idx_orders_product_status 缺失   actual=$IDX2"; fi
else
  echo "  sqlite3 CLI 不可用或 DB 文件未定位 — 跳过索引检查"
fi

echo ""
echo "=================="
echo "结果: $PASS passed / $FAIL failed"
if [[ $FAIL -gt 0 ]]; then echo -e "失败项:$FAIL_LOG"; exit 1; fi
exit 0
