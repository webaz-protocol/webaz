#!/usr/bin/env bash
# V3 Verifier 拒投权 — abstain 不计入共识 + 不算 outlier
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

# 准备 1 个 verifier + 1 个 claim task
# 找一个 buyer + 卖家 + paid 订单（用于创建 claim）
BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u WHERE u.role='buyer' AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id=u.id AND w.balance >= 50) AND NOT EXISTS (SELECT 1 FROM verifier_whitelist v WHERE v.user_id = u.id) LIMIT 1")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' AND seller_id NOT IN (SELECT user_id FROM verifier_whitelist) LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")

# 创建 demo verifier 加入 whitelist
DEMO_VID="usr_test_v3_$RANDOM"
DEMO_KEY="key_test_v3_${RANDOM}"
sqlite3 "$DB" "INSERT INTO users (id, name, role, api_key, handle, created_at) VALUES ('$DEMO_VID','测试V3','verifier','$DEMO_KEY','testv3',datetime('now'))"
sqlite3 "$DB" "INSERT INTO verifier_whitelist (user_id, tier, is_system) VALUES ('$DEMO_VID', 'trial-1', 0)"
sqlite3 "$DB" "INSERT INTO verifier_stats (user_id, verify_rights, tasks_done, tasks_correct, tasks_wrong) VALUES ('$DEMO_VID', 3, 0, 0, 0)"

# 注入 paid 订单 + 发起 claim
ORD="ord_test_v3_$RANDOM"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$ORD','$PID','$BUYER_ID','$SELLER_ID',1,10,10,10,'paid',datetime('now'),datetime('now'))"

RESP=$(curl -sS -X POST "$BASE/api/orders/$ORD/claim-verification" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" -d '{"claim_target":"price","claim_text":"V3 测试声明 — verifier 弃投不应计入共识"}')
TASK_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task_id') or '')")
[[ -z "$TASK_ID" ]] && { echo "✗ claim 创建失败 — $RESP"; exit 1; }
echo "Task: $TASK_ID"

echo ""
echo "=== 1. abstain 投票 → 接受 ==="
RESP=$(curl -sS -X POST "$BASE/api/claim-tasks/$TASK_ID/vote" -H "Authorization: Bearer $DEMO_KEY" \
  -H "Content-Type: application/json" -d '{"vote":"abstain","note":"不熟悉这类商品"}')
OK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success'))")
chk "abstain 投票成功" "True" "$OK"

echo ""
echo "=== 2. abstain 不计入 votes_count（仍 0/3）==="
COLLECTED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('votes_collected'))")
chk "votes_collected = 0（abstain 不算）" "0" "$COLLECTED"

echo ""
echo "=== 3. /api/claims/public votes_count 也不算 abstain ==="
RESP=$(curl -sS "$BASE/api/claims/public?status=open")
VC=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=next((x for x in d['items'] if x['id']=='$TASK_ID'), None)
print(t.get('votes_count') if t else 'missing')
")
chk "广场 votes_count = 0" "0" "$VC"

echo ""
echo "=== 4. abstain 行 was_majority 应保持 NULL（结算前）==="
WM=$(sqlite3 "$DB" "SELECT IFNULL(was_majority,'NULL') FROM claim_verification_votes WHERE task_id='$TASK_ID' AND verifier_id='$DEMO_VID'")
chk "was_majority 默认 NULL" "NULL" "$WM"

echo ""
echo "=== 5. 同一 verifier 重复投 → 409 ==="
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/claim-tasks/$TASK_ID/vote" -H "Authorization: Bearer $DEMO_KEY" \
  -H "Content-Type: application/json" -d '{"vote":"pass"}')
chk "重复 409" "409" "$HTTP"

echo ""
echo "=== 6. 非法 vote 值 → 400 ==="
RESP=$(curl -sS -X POST "$BASE/api/claim-tasks/$TASK_ID/vote" -H "Authorization: Bearer $DEMO_KEY" \
  -H "Content-Type: application/json" -d '{"vote":"maybe"}')
HAS_ERR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')")
chk "非法 vote 400" "yes" "$HAS_ERR"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM claim_verification_votes WHERE task_id='$TASK_ID'"
sqlite3 "$DB" "DELETE FROM claim_verification_tasks WHERE id='$TASK_ID'"
sqlite3 "$DB" "DELETE FROM orders WHERE id='$ORD'"
sqlite3 "$DB" "DELETE FROM verifier_stats WHERE user_id='$DEMO_VID'"
sqlite3 "$DB" "DELETE FROM verifier_whitelist WHERE user_id='$DEMO_VID'"
sqlite3 "$DB" "DELETE FROM users WHERE id='$DEMO_VID'"
# 退买家 stake
sqlite3 "$DB" "UPDATE wallets SET balance = balance + 10, escrowed = MAX(0, escrowed - 10) WHERE user_id='$BUYER_ID'"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
