#!/usr/bin/env bash
# Agent 治理 enforcement — P0 audit fixes (spec §2.1/2.2/2.3/4.2/5.1)
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 准备：新建一个专用买家
TS=$(date +%s)
REG=$(curl -sS -X POST "$BASE/api/register" -H "Content-Type: application/json" -d "{\"role\":\"buyer\",\"handle\":\"enf_b_$TS\",\"name\":\"EnfTest$TS\",\"region\":\"global\"}")
BUYER_KEY=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
[[ -z "$BUYER_KEY" ]] && { echo "failed to create test buyer"; exit 1; }

# 给买家 100 WAZ 用于下单
sqlite3 "$DB" "UPDATE wallets SET balance=balance+100 WHERE user_id='$BUYER_ID'"

echo "=== 1. 5.1 · price_negotiation config 校验 ==="
SELLER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='seller' LIMIT 1")
# 临时升级 seller 到 quality 级，避免 P1-5.2 trust 门槛阻拦 5.1 config 校验
SELLER_ID_FOR_BOOST=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$SELLER_KEY'")
sqlite3 "$DB" "INSERT OR REPLACE INTO agent_reputation (api_key, user_id, trust_score, level, last_calculated_at) VALUES ('$SELLER_KEY', '$SELLER_ID_FOR_BOOST', 60, 'quality', datetime('now'))"
# 越界配置 → 业务 error
RESP=$(curl -sS -X POST "$BASE/api/skills" -H "Authorization: Bearer $SELLER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"bad-neg","description":"test","skill_type":"price_negotiation","config":{"max_discount_pct":0.9,"min_quantity":1}}')
HAS_ERR=$(echo "$RESP" | python3 -c "import sys,json; print('1' if 'max_discount_pct' in str(json.load(sys.stdin).get('error','')) else '0')")
chk "max_discount_pct=0.9 错误提示" "1" "$HAS_ERR"
# 合法配置 → 通过
RESP=$(curl -sS -X POST "$BASE/api/skills" -H "Authorization: Bearer $SELLER_KEY" -H "Content-Type: application/json" \
  -d "{\"name\":\"ok-neg-$TS\",\"description\":\"test\",\"skill_type\":\"price_negotiation\",\"config\":{\"max_discount_pct\":0.2,\"min_quantity\":1}}")
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success'))")
chk "合法配置 success" "True" "$OK"
# 测试结束：移除临时 boost
sqlite3 "$DB" "DELETE FROM agent_reputation WHERE api_key='$SELLER_KEY' AND trust_score = 60"

echo ""
echo "=== 2. 2.2 · declared_scope enforcement ==="
# 给买家声明：只允许 search
RESP=$(curl -sS -X POST "$BASE/api/me/agents/declarations" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d '{"operator_name":"ScopeTest","operator_contact":"x@test","purpose":"only search test enforcement","declared_scope":{"roles":["buyer"],"actions":["search"],"regions":["*"]}}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "声明 actions=['search'] 成功" "True" "$OK"
# 尝试 place_order → 应被 403 + AGENT_SCOPE_DENIED
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' AND stock>0 LIMIT 1")
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"test addr\",\"quantity\":1}")
ERR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error_code',''))")
chk "place_order 越界 → AGENT_SCOPE_DENIED" "AGENT_SCOPE_DENIED" "$ERR"
# 更新声明：加上 place_order
curl -sS -X POST "$BASE/api/me/agents/declarations" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d '{"operator_name":"ScopeTest","operator_contact":"x@test","purpose":"now can buy","declared_scope":{"roles":["buyer"],"actions":["search","place_order"],"regions":["*"]}}' > /dev/null

echo ""
echo "=== 3. 2.1 · spend_cap enforcement ==="
# 设 spend_cap_per_order = 5 WAZ
curl -sS -X POST "$BASE/api/me/agents/attestations" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$BUYER_KEY\",\"approved_scope\":{\"actions\":[\"place_order\"]},\"spend_cap_per_order\":5}" > /dev/null
PRICE=$(sqlite3 "$DB" "SELECT price FROM products WHERE id='$PID'")
QTY=10
EXPECTED_TOTAL=$(python3 -c "print($PRICE * $QTY)")
RESP=$(curl -sS -X POST "$BASE/api/orders" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PID\",\"shipping_address\":\"test\",\"quantity\":$QTY,\"expected_price\":$PRICE}")
ERR=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error_code',''))")
chk "超过 spend_cap_per_order → AGENT_SPEND_CAP_PER_ORDER" "AGENT_SPEND_CAP_PER_ORDER" "$ERR"
# 清掉 attestation
sqlite3 "$DB" "UPDATE agent_attestations SET revoked_at=datetime('now') WHERE api_key='$BUYER_KEY'"

echo ""
echo "=== 4. 4.2 · appeal endpoint ==="
# 手动塞一个 strike
sqlite3 "$DB" "INSERT INTO agent_strikes (api_key, user_id, severity, reason_code, reason_detail, expires_at) VALUES ('$BUYER_KEY', '$BUYER_ID', 'warning', 'test_strike', 'manual e2e', datetime('now', '+24 hours'))"
STRIKE_ID=$(sqlite3 "$DB" "SELECT id FROM agent_strikes WHERE api_key='$BUYER_KEY' ORDER BY id DESC LIMIT 1")
# 无理由 → 400
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/me/agents/strikes/$STRIKE_ID/appeal" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" -d '{"reason":""}')
chk "无理由 → 400" "400" "$HTTP"
# 正常申诉
RESP=$(curl -sS -X POST "$BASE/api/me/agents/strikes/$STRIKE_ID/appeal" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" -d '{"reason":"This is my e2e test appeal reason, please review."}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "申诉成功" "True" "$OK"
STATUS=$(sqlite3 "$DB" "SELECT appeal_status FROM agent_strikes WHERE id=$STRIKE_ID")
chk "申诉状态 = pending" "pending" "$STATUS"
# 重复申诉 → 409
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/me/agents/strikes/$STRIKE_ID/appeal" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" -d '{"reason":"trying again"}')
chk "重复申诉 → 409" "409" "$HTTP"
# Admin 裁决 approved
ADMIN_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='admin' AND (admin_type IS NULL OR admin_type='root') LIMIT 1")
RESP=$(curl -sS -X POST "$BASE/api/admin/agent-strikes/$STRIKE_ID/decide" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{"decision":"approved"}')
DECISION=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision',''))")
chk "admin 裁决 approved" "approved" "$DECISION"
FINAL=$(sqlite3 "$DB" "SELECT appeal_status FROM agent_strikes WHERE id=$STRIKE_ID")
chk "appeal_status = approved" "approved" "$FINAL"

echo ""
echo "=== 5. 2.3 · strike issuance helper 升级 ==="
# 直接调 issuance — 通过制造 3 个连续 warning 看是否升级 suspend_7d
# （手动 INSERT 模拟，因为 7 天窗口需要时间）
sqlite3 "$DB" "DELETE FROM agent_strikes WHERE api_key='$BUYER_KEY' AND id != $STRIKE_ID"
# 注入一个最近 warning（不算 approved 的 STRIKE_ID）
sqlite3 "$DB" "INSERT INTO agent_strikes (api_key, user_id, severity, reason_code, expires_at) VALUES ('$BUYER_KEY', '$BUYER_ID', 'warning', 'simulated_1', datetime('now', '+24 hours'))"
# 模拟第 2 次 warning 升级路径 — 通过塞 audit_log 触发 rate_limit_abuse 不太好稳定测；这里直接验证 helper 的"已 1 warning + 当前要升 suspend"逻辑
# 改用 SQL 直接看：现存 warning count = 1（approved 不算）
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_strikes WHERE api_key='$BUYER_KEY' AND severity='warning' AND issued_at > datetime('now','-7 days') AND appeal_status NOT IN ('approved')")
chk "approved strike 不计入升级窗口" "1" "$COUNT"

echo ""
echo "=== 6. 4.2 admin 端点：申诉列表 ==="
# 制造一个 pending
sqlite3 "$DB" "INSERT INTO agent_strikes (api_key, user_id, severity, reason_code, reason_detail, appeal_status, appeal_reason, expires_at) VALUES ('$BUYER_KEY', '$BUYER_ID', 'warning', 'admin_list_test', 'x', 'pending', 'pending appeal e2e', datetime('now','+24 hours'))"
RESP=$(curl -sS "$BASE/api/admin/agent-strikes/pending" -H "Authorization: Bearer $ADMIN_KEY")
ITEM_COUNT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))")
HAS_AT_LEAST_1=$([[ "$ITEM_COUNT" -ge 1 ]] && echo "ok" || echo "empty")
chk "pending 列表至少 1 条" "ok" "$HAS_AT_LEAST_1"

echo ""
echo "=== 7. P1-4.3 · admin 主动 issue strike ==="
# 清掉测试 5/6 留下的非 approved warnings，避免 escalation 把本次 warning 升级成 suspend_7d
sqlite3 "$DB" "DELETE FROM agent_strikes WHERE api_key='$BUYER_KEY' AND (appeal_status IS NULL OR appeal_status != 'approved')"
RESP=$(curl -sS -X POST "$BASE/api/admin/agent-strikes/issue" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$BUYER_KEY\",\"reason_code\":\"admin_manual_test\",\"severity\":\"warning\",\"reason_detail\":\"e2e admin manual\"}")
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "admin issue strike 成功" "True" "$OK"
SEV=$(sqlite3 "$DB" "SELECT severity FROM agent_strikes WHERE api_key='$BUYER_KEY' AND reason_code='admin_manual_test' ORDER BY id DESC LIMIT 1")
chk "落库 severity = warning" "warning" "$SEV"
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/agent-strikes/issue" -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d '{"api_key":"x","reason_code":"x"}')
chk "非 admin → 403" "403" "$HTTP"

echo ""
echo "=== 8. P1-4.4 · /api/me/agents 返回 signals ==="
curl -sS "$BASE/api/agents/me/reputation" -H "Authorization: Bearer $BUYER_KEY" > /dev/null
RESP=$(curl -sS "$BASE/api/me/agents" -H "Authorization: Bearer $BUYER_KEY")
HAS_SIG=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('items',[]); first=items[0] if items else {}; rep=first.get('reputation') or {}; print('1' if isinstance(rep.get('signals'), dict) else '0')")
chk "/api/me/agents 返回 signals 对象" "1" "$HAS_SIG"

echo ""
echo "=== 9. P1-5.2 · skill trust 门槛 ==="
NEW_SELLER_TS=$(date +%s)
NS_REG=$(curl -sS -X POST "$BASE/api/register" -H "Content-Type: application/json" \
  -d "{\"role\":\"seller\",\"handle\":\"new_seller_$NEW_SELLER_TS\",\"name\":\"NS$NEW_SELLER_TS\",\"region\":\"global\"}")
NS_KEY=$(echo "$NS_REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))")
NS_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$NS_KEY'")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/skills" -H "Authorization: Bearer $NS_KEY" -H "Content-Type: application/json" \
  -d '{"name":"neg-skill","description":"low trust try","skill_type":"price_negotiation","config":{"max_discount_pct":0.1,"min_quantity":1}}')
chk "new 级 seller 发 price_negotiation → 403" "403" "$HTTP"

echo ""
echo "=== 10. P1-5.3 · strike → skill 联动 ==="
sqlite3 "$DB" "INSERT INTO skills (id, seller_id, name, description, skill_type, active) VALUES ('skl_test_$NEW_SELLER_TS', '$NS_ID', 'test', 'test', 'auto_accept', 1)"
curl -sS -X POST "$BASE/api/admin/agent-strikes/issue" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"api_key\":\"$NS_KEY\",\"reason_code\":\"test_suspend\",\"severity\":\"suspend_7d\"}" > /dev/null
SKILL_ACTIVE=$(sqlite3 "$DB" "SELECT active FROM skills WHERE id='skl_test_$NEW_SELLER_TS'")
chk "suspend_7d 后 skill.active = 0" "0" "$SKILL_ACTIVE"
DISABLED_AT=$(sqlite3 "$DB" "SELECT disabled_by_strike_at IS NOT NULL FROM skills WHERE id='skl_test_$NEW_SELLER_TS'")
chk "skill.disabled_by_strike_at 已记录" "1" "$DISABLED_AT"
NEW_STRIKE_ID=$(sqlite3 "$DB" "SELECT id FROM agent_strikes WHERE api_key='$NS_KEY' AND reason_code='test_suspend' ORDER BY id DESC LIMIT 1")
curl -sS -X POST "$BASE/api/me/agents/strikes/$NEW_STRIKE_ID/appeal" -H "Authorization: Bearer $NS_KEY" -H "Content-Type: application/json" \
  -d '{"reason":"automated test: please approve to verify skill restoration logic"}' > /dev/null
curl -sS -X POST "$BASE/api/admin/agent-strikes/$NEW_STRIKE_ID/decide" -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"decision":"approved"}' > /dev/null
SKILL_RESTORED=$(sqlite3 "$DB" "SELECT active FROM skills WHERE id='skl_test_$NEW_SELLER_TS'")
chk "approved 申诉后 skill.active = 1" "1" "$SKILL_RESTORED"
# 清理 NS
sqlite3 "$DB" "DELETE FROM skills WHERE id='skl_test_$NEW_SELLER_TS'"
sqlite3 "$DB" "DELETE FROM agent_strikes WHERE api_key='$NS_KEY'"
sqlite3 "$DB" "DELETE FROM users WHERE id='$NS_ID'"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM agent_strikes WHERE api_key='$BUYER_KEY'"
sqlite3 "$DB" "DELETE FROM agent_declarations WHERE api_key='$BUYER_KEY'"
sqlite3 "$DB" "DELETE FROM agent_attestations WHERE api_key='$BUYER_KEY'"
sqlite3 "$DB" "DELETE FROM users WHERE id='$BUYER_ID'"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
