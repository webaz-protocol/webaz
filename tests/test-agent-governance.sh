#!/usr/bin/env bash
# Agent 治理 — schema + 自声明 + 用户视角端点 + 撤销 + 铁律开关 + 分档 rate limit
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. 4 张新表 schema 就位 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('agent_declarations','agent_attestations','agent_strikes','agent_revocations')")
chk "4 张表存在" "4" "$HAS"

echo ""
echo "=== 2. 协议参数已注册（铁律开关 + 分档 rate）==="
PARAMS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM protocol_params WHERE key IN ('require_human_presence_for_vote','require_human_presence_for_arbitrate','require_human_presence_for_agent_revoke','agent_rate_new_per_min','agent_rate_trusted_per_min','agent_rate_quality_per_min','agent_rate_legend_per_min')")
chk "7 个新参数已注册" "7" "$PARAMS"
DEFAULT_VOTE=$(sqlite3 "$DB" "SELECT value FROM protocol_params WHERE key='require_human_presence_for_vote'")
chk "默认值 vote=0（DAO Phase B 启用）" "0" "$DEFAULT_VOTE"

echo ""
echo "=== 3. 默认参数公开可查 ==="
RESP=$(curl -sS "$BASE/api/governance/params")
HAS_NEW=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); keys=[p['key'] for p in d['params']]; print('1' if 'require_human_presence_for_vote' in keys else '0')")
chk "新参数在公开 list 中" "1" "$HAS_NEW"

echo ""
echo "=== 4. 用户 GET /api/me/agents ==="
BUYER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='buyer' LIMIT 1")
RESP=$(curl -sS "$BASE/api/me/agents" -H "Authorization: Bearer $BUYER_KEY")
HAS_ITEMS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if isinstance(d.get('items'), list) else '0')")
chk "/api/me/agents 返回 items 数组" "1" "$HAS_ITEMS"

echo ""
echo "=== 5. POST /api/me/agents/declarations 自声明 ==="
RESP=$(curl -sS -X POST "$BASE/api/me/agents/declarations" \
  -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d '{"operator_name":"Test Agent Co","operator_contact":"test@example.com","purpose":"E2E test agent for governance","declared_scope":{"roles":["buyer"],"actions":["search"],"regions":["*"]}}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
chk "自声明成功" "True" "$OK"
SAVED=$(sqlite3 "$DB" "SELECT operator_name FROM agent_declarations WHERE api_key='$BUYER_KEY'")
chk "declaration 落库" "Test Agent Co" "$SAVED"

echo ""
echo "=== 6. 必填字段校验 ==="
RESP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/me/agents/declarations" \
  -H "Authorization: Bearer $BUYER_KEY" -H "Content-Type: application/json" \
  -d '{"operator_name":""}')
chk "缺 operator_name → 400" "400" "$RESP"

echo ""
echo "=== 7. 投票铁律开关（默认关 → 允许）==="
sqlite3 "$DB" "UPDATE protocol_params SET value='0' WHERE key='require_human_presence_for_vote'"
# 触发 invalidateAgentBlockedCache 不直接调用，但参数读取每次都新鲜（无缓存）

# 启用铁律 → 投票应被 412 拒绝
sqlite3 "$DB" "UPDATE protocol_params SET value='1' WHERE key='require_human_presence_for_vote'"
sleep 1  # 等待 protocol_param cache 失效（如有）
# 找一个 verifier user
VERIFIER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u JOIN verifier_whitelist vw ON vw.user_id=u.id WHERE vw.status='active' LIMIT 1")
if [[ -n "$VERIFIER_KEY" ]]; then
  # 找一个开放任务
  TASK_ID=$(sqlite3 "$DB" "SELECT cvt.id FROM claim_verification_tasks cvt WHERE cvt.status='open' AND cvt.buyer_id != (SELECT id FROM users WHERE api_key='$VERIFIER_KEY') AND cvt.seller_id != (SELECT id FROM users WHERE api_key='$VERIFIER_KEY') LIMIT 1")
  if [[ -n "$TASK_ID" ]]; then
    HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/claim-tasks/$TASK_ID/vote" \
      -H "Authorization: Bearer $VERIFIER_KEY" -H "Content-Type: application/json" \
      -d '{"vote":"pass"}')
    chk "铁律开启 + 无 webauthn_token → 412" "412" "$HTTP"
  else
    echo "(skip — no open claim task)"
  fi
else
  echo "(skip — no verifier in DB)"
fi
# 还原
sqlite3 "$DB" "UPDATE protocol_params SET value='0' WHERE key='require_human_presence_for_vote'"

echo ""
echo "=== 8. 自撤销 agent → 后续请求被 403 拦截 ==="
# 关键：必须用"专用一次性 api_key"，避免污染 60s in-memory 缓存影响后续测试
# 创建一个临时 buyer 用户专门用于撤销测试
TEMP_HANDLE="agent_gov_temp_$(date +%s)"
TEMP_REG=$(curl -sS -X POST "$BASE/api/users" -H "Content-Type: application/json" \
  -d "{\"role\":\"buyer\",\"handle\":\"$TEMP_HANDLE\"}")
TEMP_KEY=$(echo "$TEMP_REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))")
if [[ -n "$TEMP_KEY" ]]; then
  PREFIX=$(echo "$TEMP_KEY" | cut -c1-12)
  RESP=$(curl -sS -X POST "$BASE/api/me/agents/$PREFIX/revoke" \
    -H "Authorization: Bearer $TEMP_KEY" -H "Content-Type: application/json" \
    -d '{"reason":"e2e test self-revoke"}')
  OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")
  chk "自撤销返回 ok" "True" "$OK"
  HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/me/agents/declarations" \
    -H "Authorization: Bearer $TEMP_KEY" -H "Content-Type: application/json" \
    -d '{"operator_name":"X"}')
  chk "撤销后调用被拒（AGENT_BLOCKED）" "403" "$HTTP"
else
  echo "(skip — 无法创建临时用户)"
fi

echo ""
echo "=== 9. SDK template 文件就位 ==="
HAS_SDK_README=$([[ -f "sdk/agent-template/README.md" ]] && echo "1" || echo "0")
chk "SDK README 存在" "1" "$HAS_SDK_README"
HAS_SDK_TS=$([[ -f "sdk/agent-template/src/index.ts" ]] && echo "1" || echo "0")
chk "SDK index.ts 存在" "1" "$HAS_SDK_TS"

echo ""
echo "=== 10. spec 文档存在 ==="
HAS_SPEC=$([[ -f "docs/AGENT-GOVERNANCE.md" ]] && echo "1" || echo "0")
chk "AGENT-GOVERNANCE.md 存在" "1" "$HAS_SPEC"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
