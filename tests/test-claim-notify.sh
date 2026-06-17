#!/usr/bin/env bash
# V2 claim 任务推送通知 — 后端冒烟
# 覆盖：新任务创建后通知所有 verifier；卖家提交证据后再次通知；opt-out 工作
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

echo "=== 1. notify_claim_tasks 列已加入 ==="
HAS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name='notify_claim_tasks'")
chk "列存在" "1" "$HAS"

# 准备一个 demo verifier（whitelist 入选）
DEMO_VERIFIER="usr_test_v2_verifier_$RANDOM"
sqlite3 "$DB" "INSERT OR IGNORE INTO users (id, name, role, api_key, handle, created_at) VALUES ('$DEMO_VERIFIER','测试V2审核员','verifier','key_test_v2','testv2',datetime('now'))"
sqlite3 "$DB" "INSERT OR IGNORE INTO verifier_whitelist (user_id, tier, granted_by, is_system) VALUES ('$DEMO_VERIFIER', 'trial-1', 'sys_protocol', 0)"
sqlite3 "$DB" "INSERT OR IGNORE INTO verifier_stats (user_id, verify_rights, tasks_done, tasks_correct, tasks_wrong) VALUES ('$DEMO_VERIFIER', 3, 0, 0, 0)"

# 找一个 buyer 和卖家（不在 verifier whitelist）+ 商品 + 已 paid 订单
BUYER_KEY=$(sqlite3 "$DB" "SELECT u.api_key FROM users u WHERE u.role='buyer' AND u.api_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM verifier_whitelist v WHERE v.user_id = u.id) AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id=u.id AND w.balance >= 10) LIMIT 1")
BUYER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$BUYER_KEY'")
PID=$(sqlite3 "$DB" "SELECT id FROM products WHERE status='active' AND seller_id NOT IN (SELECT user_id FROM verifier_whitelist) LIMIT 1")
SELLER_ID=$(sqlite3 "$DB" "SELECT seller_id FROM products WHERE id='$PID'")
echo "测试 buyer=$BUYER_ID  seller=$SELLER_ID  product=$PID"

# 注入一个 paid 订单（让 buyer 能发起 claim）
ORD="ord_test_v2_$RANDOM"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$ORD', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'paid', datetime('now'), datetime('now'))"

echo ""
echo "=== 2. 发起 claim → demo verifier 收到通知 ==="
# 清掉旧 notifications
sqlite3 "$DB" "DELETE FROM notifications WHERE user_id='$DEMO_VERIFIER'"
RESP=$(curl -sS -X POST "$BASE/api/orders/$ORD/claim-verification" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"claim_target":"price","claim_text":"商家声称同款最低价，实际并非如此，需要 verifier 共识"}')
TASK_ID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('task_id') or '')")
[[ -z "$TASK_ID" ]] && { echo "✗ claim 创建失败 — $RESP"; exit 1; }
echo "Task $TASK_ID"

NTF=$(sqlite3 "$DB" "SELECT COUNT(*) FROM notifications WHERE user_id='$DEMO_VERIFIER' AND type='claim_new'")
chk "verifier 收到 claim_new 通知" "1" "$NTF"

# 卖家也应该收到
NTF_SELLER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM notifications WHERE user_id='$SELLER_ID' AND type='claim_new' AND order_id='$ORD'")
chk "卖家也收到通知" "1" "$NTF_SELLER"

# Buyer 不应收到（自己发起的）
NTF_BUYER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM notifications WHERE user_id='$BUYER_ID' AND type='claim_new'")
chk "买家不应收到（自己发起）" "0" "$NTF_BUYER"

echo ""
echo "=== 3. 卖家提交证据 → verifier 再次收到通知 ==="
sqlite3 "$DB" "DELETE FROM notifications WHERE user_id='$DEMO_VERIFIER'"
SELLER_KEY=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE id='$SELLER_ID'")
curl -sS -X POST "$BASE/api/claim-tasks/$TASK_ID/seller-evidence" -H "Authorization: Bearer $SELLER_KEY" \
  -H "Content-Type: application/json" -d '{"evidence_uri":"https://example.com/proof.png"}' > /dev/null

NTF=$(sqlite3 "$DB" "SELECT COUNT(*) FROM notifications WHERE user_id='$DEMO_VERIFIER' AND type='claim_evidence_added'")
chk "证据补充后 verifier 再次收到通知" "1" "$NTF"

echo ""
echo "=== 4. opt-out 后不再收到 ==="
# 关闭通知
curl -sS -X POST "$BASE/api/me/notify-claim-tasks" -H "Authorization: Bearer key_test_v2" \
  -H "Content-Type: application/json" -d '{"enabled":false}' > /dev/null
OFF=$(sqlite3 "$DB" "SELECT notify_claim_tasks FROM users WHERE id='$DEMO_VERIFIER'")
chk "opt-out 后字段为 0" "0" "$OFF"

# 再发一个 claim（另一个订单）→ demo verifier 不应收到
ORD2="ord_test_v2_b_$RANDOM"
sqlite3 "$DB" "INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, created_at, updated_at) VALUES ('$ORD2', '$PID', '$BUYER_ID', '$SELLER_ID', 1, 10, 10, 10, 'paid', datetime('now'), datetime('now'))"
sqlite3 "$DB" "DELETE FROM notifications WHERE user_id='$DEMO_VERIFIER'"
curl -sS -X POST "$BASE/api/orders/$ORD2/claim-verification" -H "Authorization: Bearer $BUYER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"claim_target":"warranty","claim_text":"另一个声明测试 opt-out 不接收新任务通知"}' > /dev/null
NTF=$(sqlite3 "$DB" "SELECT COUNT(*) FROM notifications WHERE user_id='$DEMO_VERIFIER' AND type='claim_new'")
chk "opt-out 后不收到新 claim 通知" "0" "$NTF"

echo ""
echo "=== 5. GET 偏好状态 ==="
RESP=$(curl -sS "$BASE/api/me/notify-claim-tasks" -H "Authorization: Bearer key_test_v2")
GOT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('notify_claim_tasks'))")
chk "GET 返回 0（已 opt-out）" "0" "$GOT"

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM notifications WHERE user_id='$DEMO_VERIFIER' OR user_id='$SELLER_ID' AND type LIKE 'claim_%'"
sqlite3 "$DB" "DELETE FROM claim_verification_tasks WHERE id='$TASK_ID' OR order_id IN ('$ORD','$ORD2')"
sqlite3 "$DB" "DELETE FROM orders WHERE id IN ('$ORD','$ORD2')"
sqlite3 "$DB" "DELETE FROM verifier_stats WHERE user_id='$DEMO_VERIFIER'"
sqlite3 "$DB" "DELETE FROM verifier_whitelist WHERE user_id='$DEMO_VERIFIER'"
sqlite3 "$DB" "DELETE FROM users WHERE id='$DEMO_VERIFIER'"
# 退还买家锁定的 stake (避免污染钱包)
sqlite3 "$DB" "UPDATE wallets SET balance = balance + 20, escrowed = MAX(0, escrowed - 20) WHERE user_id='$BUYER_ID'"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
