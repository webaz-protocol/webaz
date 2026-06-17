#!/usr/bin/env bash
# W1-W9 对话窗端到端 smoke
# 假设：PWA server 在 BASE（默认 :3000） 跑，DB = ~/.webaz/webaz.db
# 用法：bash tests/test-w1w9-smoke.sh
set -u
BASE="${BASE:-http://localhost:3000}"
DB="${WEBAZ_DB:-$HOME/.webaz/webaz.db}"

PASS=0; FAIL=0; FAIL_LOG=""
chk() { local label="$1" exp="$2" act="$3" hint="${4:-}"
  if [[ "$act" == "$exp" ]]; then PASS=$((PASS+1)); printf "✓ %s  [%s]\n" "$label" "$act"
  else FAIL=$((FAIL+1)); printf "✗ %s  [got %s expected %s] %s\n" "$label" "$act" "$exp" "$hint"
    FAIL_LOG="${FAIL_LOG}\n  ${label}: got ${act} expected ${exp} ${hint}"; fi
}
chk_has() { local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$label"
  else FAIL=$((FAIL+1)); printf "✗ %s  [missing '%s' in: %s]\n" "$label" "$needle" "$(echo "$haystack" | head -c 200)"; fi
}

[[ -f "$DB" ]] || { echo "DB not found: $DB"; exit 1; }
echo "=== SCHEMA: W1-W9 表/列存在 ==="
chk "table return_messages"          "1" "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='return_messages';")"
chk "table feedback_messages"        "1" "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='feedback_messages';")"
chk "table shareable_comments"       "1" "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='shareable_comments';")"
chk "table dispute_comment_replies"  "1" "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='dispute_comment_replies';")"
chk "col messages.kind"              "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('messages') WHERE name='kind';")"
chk "col messages.meta"              "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('messages') WHERE name='meta';")"
chk "col notifications.actions"      "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('notifications') WHERE name='actions';")"
chk "col order_ratings.buyer_followup" "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('order_ratings') WHERE name='buyer_followup';")"
chk "col return_messages.flag_reasons"     "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('return_messages') WHERE name='flag_reasons';")"
chk "col feedback_messages.flag_reasons"   "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('feedback_messages') WHERE name='flag_reasons';")"
chk "col dispute_comments.flag_reasons"    "1" "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('dispute_comments') WHERE name='flag_reasons';")"

echo ""
echo "=== Fixture 自动发现（取最近一个有效测试用户） ==="
BK_NAME="aud_w1w9_$$_$RANDOM"
REG=$(curl -sS -X POST "$BASE/api/register" -H 'content-type: application/json' \
  -d "{\"name\":\"${BK_NAME}\",\"role\":\"buyer\",\"region\":\"global\"}")
BK=$(echo "$REG" | sed -E 's/.*"api_key":"([^"]+)".*/\1/')
BUID=$(echo "$REG" | sed -E 's/.*"user_id":"([^"]+)".*/\1/')
[[ -n "$BK" && "$BK" != "$REG" ]] && { PASS=$((PASS+1)); echo "✓ register buyer $BK_NAME"; } || { FAIL=$((FAIL+1)); echo "✗ register failed: $REG"; exit 1; }

# 拿一个现有 admin 的 key
AK=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='admin' AND length(api_key) > 30 LIMIT 1;")
[[ -n "$AK" ]] && { PASS=$((PASS+1)); echo "✓ admin key found"; } || { FAIL=$((FAIL+1)); echo "✗ no admin user"; exit 1; }

# 拿一个 seller key（用作 W1 私信 + 任意对端）
SK=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE role='seller' AND length(api_key)=16 LIMIT 1;")
SUID=$(sqlite3 "$DB" "SELECT id FROM users WHERE role='seller' AND length(api_key)=16 LIMIT 1;")

echo ""
echo "=== W1 私信结构化消息（offer / tracking） ==="
# 用 conv 创建端点 — 需要合法 context。简化：直接拿现有 conversation 测发消息。
CV_ID=$(sqlite3 "$DB" "SELECT id FROM conversations LIMIT 1;")
if [[ -n "$CV_ID" ]]; then
  CV_KEY_A=$(sqlite3 "$DB" "SELECT u.api_key FROM conversations c JOIN users u ON u.id=c.user_a WHERE c.id='$CV_ID' AND length(u.api_key) IN (16,68) LIMIT 1;")
  if [[ -n "$CV_KEY_A" ]]; then
    OFFER_RES=$(curl -sS -X POST "$BASE/api/conversations/$CV_ID/messages" -H "Authorization: Bearer $CV_KEY_A" -H "Content-Type: application/json" \
      -d '{"kind":"offer","meta":{"amount":99,"product_id":"prd_test_d2968372","note":"smoke test"}}')
    chk_has "W1 offer 端点接受" '"id"' "$OFFER_RES"
    TRK_RES=$(curl -sS -X POST "$BASE/api/conversations/$CV_ID/messages" -H "Authorization: Bearer $CV_KEY_A" -H "Content-Type: application/json" \
      -d '{"kind":"tracking","meta":{"carrier":"SF","tracking_no":"SMOKE12345"}}')
    chk_has "W1 tracking 端点接受" '"id"' "$TRK_RES"
    BAD_KIND=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/conversations/$CV_ID/messages" -H "Authorization: Bearer $CV_KEY_A" -H "Content-Type: application/json" \
      -d '{"kind":"xxxBADxxx","meta":{}}')
    chk "W1 非法 kind 拒绝" "400" "$BAD_KIND"
    # GET 验证 meta 落库可读
    CV_GET=$(curl -sS "$BASE/api/conversations/$CV_ID" -H "Authorization: Bearer $CV_KEY_A")
    chk_has "W1 conv detail 含 kind 字段" '"kind"' "$CV_GET"
    chk_has "W1 conv detail 含 meta 字段" '"meta"' "$CV_GET"
  else
    echo "⊘ skip W1 — 无可用 conv key"
  fi
else
  echo "⊘ skip W1 — 无 conversation fixture"
fi

echo ""
echo "=== W2 售后协商 + 反诈 detectFraud(rawBody) ==="
# 找一个 active return request（pending 状态）
RID=$(sqlite3 "$DB" "SELECT id FROM return_requests WHERE status='pending' LIMIT 1;")
if [[ -n "$RID" ]]; then
  RR_BUYER_K=$(sqlite3 "$DB" "SELECT u.api_key FROM return_requests r JOIN users u ON u.id=r.buyer_id WHERE r.id='$RID';")
  # 发一条带电话号的消息，验证 fraud detect 命中 phone_cn
  FRAUD_RES=$(curl -sS -X POST "$BASE/api/return-requests/$RID/messages" -H "Authorization: Bearer $RR_BUYER_K" -H "Content-Type: application/json" \
    -d '{"body":"打电话 13912345678 联系"}')
  chk_has "W2 协商消息 fraud detect 命中 phone_cn" '"phone_cn"' "$FRAUD_RES"
  chk_has "W2 协商消息 flagged=true" '"flagged":true' "$FRAUD_RES"
  # GET timeline 验证 event 含 flag_reasons
  TL=$(curl -sS "$BASE/api/return-requests/$RID" -H "Authorization: Bearer $RR_BUYER_K")
  chk_has "W2 timeline event 含 flag_reasons" '"flag_reasons"' "$TL"
else
  echo "⊘ skip W2 协商 — 无 pending return_request"
fi

# escalate invariant: 已 escalated 的 request 再发消息应被拒
ESC_RID=$(sqlite3 "$DB" "SELECT id FROM return_requests WHERE status='escalated' LIMIT 1;")
if [[ -n "$ESC_RID" ]]; then
  ESC_BK=$(sqlite3 "$DB" "SELECT u.api_key FROM return_requests r JOIN users u ON u.id=r.buyer_id WHERE r.id='$ESC_RID';")
  ESC_DSP=$(sqlite3 "$DB" "SELECT escalated_dispute_id FROM return_requests WHERE id='$ESC_RID';")
  [[ -n "$ESC_DSP" ]] && { PASS=$((PASS+1)); echo "✓ W2 escalated request 关联 dispute_id"; } || { FAIL=$((FAIL+1)); echo "✗ W2 escalated request 缺 dispute_id"; }
  ESC_TRY=$(curl -sS -X POST "$BASE/api/return-requests/$ESC_RID/messages" -H "Authorization: Bearer $ESC_BK" -H "Content-Type: application/json" \
    -d '{"body":"再发消息"}')
  chk_has "W2 escalated 后禁言" "协商已结束" "$ESC_TRY"
fi

echo ""
echo "=== W3 评价两回合 — followup 一次性 ==="
# 找一个 reply + followup 都有的 rating
DONE_OID=$(sqlite3 "$DB" "SELECT order_id FROM order_ratings WHERE reply IS NOT NULL AND buyer_followup IS NOT NULL LIMIT 1;")
if [[ -n "$DONE_OID" ]]; then
  DONE_BK=$(sqlite3 "$DB" "SELECT u.api_key FROM order_ratings r JOIN users u ON u.id=r.buyer_id WHERE r.order_id='$DONE_OID';")
  # 二次追问应拒
  AGAIN=$(curl -sS -X POST "$BASE/api/orders/$DONE_OID/rating/followup" -H "Authorization: Bearer $DONE_BK" -H "Content-Type: application/json" \
    -d '{"followup":"再试一次"}')
  chk_has "W3 二次追问被拒" "已追问过一次" "$AGAIN"
  # GET 含 buyer_followup 字段
  GET_RT=$(curl -sS "$BASE/api/orders/$DONE_OID/rating" -H "Authorization: Bearer $DONE_BK")
  chk_has "W3 GET 含 buyer_followup" '"buyer_followup"' "$GET_RT"
fi

echo ""
echo "=== W4 仲裁 timeline 含完整事件 + actors ==="
DSP_ID=$(sqlite3 "$DB" "SELECT id FROM disputes WHERE status='resolved' LIMIT 1;")
if [[ -n "$DSP_ID" ]]; then
  DSP_BK=$(sqlite3 "$DB" "SELECT u.api_key FROM disputes d JOIN users u ON u.id=d.initiator_id WHERE d.id='$DSP_ID';")
  TL=$(curl -sS "$BASE/api/disputes/$DSP_ID" -H "Authorization: Bearer $DSP_BK")
  chk_has "W4 dispute detail 含 timeline 字段" '"timeline"' "$TL"
  chk_has "W4 dispute detail 含 actors 字段" '"actors"' "$TL"
  chk_has "W4 timeline 含 open 事件" '"type":"open"' "$TL"
fi

echo ""
echo "=== W5 仲裁公开评论楼中楼 ==="
DCASE=$(sqlite3 "$DB" "SELECT id FROM dispute_cases LIMIT 1;")
if [[ -n "$DCASE" ]]; then
  CASE_RES=$(curl -sS "$BASE/api/disputes/cases/$DCASE" -H "Authorization: Bearer $BK")
  chk_has "W5 case 返回 comments 字段" '"comments"' "$CASE_RES"
  chk_has "W5 comments 含 replies (即使空)" '"replies"' "$CASE_RES"
fi

echo ""
echo "=== W6 笔记评论 + 楼中楼分组 ==="
NOTE_ID=$(sqlite3 "$DB" "SELECT id FROM shareables WHERE type='native_text' OR type='note' LIMIT 1;")
if [[ -n "$NOTE_ID" ]]; then
  CMTS=$(curl -sS "$BASE/api/shareables/$NOTE_ID/comments")
  chk_has "W6 notes comments 返回 items + total" '"items"' "$CMTS"
  chk_has "W6 notes comments 含 replies 分组字段" '"total"' "$CMTS"
  # 验证 root 评论的 replies 字段总存在（即使空）
  echo "$CMTS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok = all('replies' in c for c in d.get('items',[]))
print('✓' if ok else '✗', 'W6 root 评论均有 replies 字段')
sys.exit(0 if ok else 1)
" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
fi

echo ""
echo "=== W7 客服 ticket-thread ==="
TKT=$(sqlite3 "$DB" "SELECT id FROM feedback_tickets LIMIT 1;")
if [[ -n "$TKT" ]]; then
  TKT_BK=$(sqlite3 "$DB" "SELECT u.api_key FROM feedback_tickets f JOIN users u ON u.id=f.user_id WHERE f.id='$TKT';")
  TKT_GET=$(curl -sS "$BASE/api/feedback/$TKT" -H "Authorization: Bearer $TKT_BK")
  chk_has "W7 ticket detail 含 timeline" '"timeline"' "$TKT_GET"
  chk_has "W7 ticket detail 含 is_admin" '"is_admin"' "$TKT_GET"
  chk_has "W7 timeline 含 created 事件" '"type":"created"' "$TKT_GET"
  # admin 视角下 is_admin=true
  ADM_GET=$(curl -sS "$BASE/api/feedback/$TKT" -H "Authorization: Bearer $AK")
  chk_has "W7 admin 视角 is_admin=true" '"is_admin":true' "$ADM_GET"
fi

echo ""
echo "=== W9 通知 actions JSON 注入 ==="
ACT_COUNT=$(sqlite3 "$DB" "SELECT count(*) FROM notifications WHERE actions IS NOT NULL;")
[[ "$ACT_COUNT" -ge "1" ]] && { PASS=$((PASS+1)); echo "✓ W9 至少 1 条 notification 带 actions (current: $ACT_COUNT)"; } || { FAIL=$((FAIL+1)); echo "✗ W9 0 条 notification 带 actions — 触发路径可能失败"; }
# 验证 actions 是合法 JSON
SAMPLE=$(sqlite3 "$DB" "SELECT actions FROM notifications WHERE actions IS NOT NULL LIMIT 1;")
if [[ -n "$SAMPLE" ]]; then
  echo "$SAMPLE" | python3 -c "
import json,sys
arr=json.loads(sys.stdin.read())
assert isinstance(arr, list) and len(arr)>0
a=arr[0]
assert 'kind' in a and 'label' in a
print('✓ W9 actions 合法 JSON: kind=' + a['kind'] + ' label=' + a['label'])
" 2>/dev/null && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "✗ W9 actions JSON 解析失败"; }
fi

echo ""
echo "=== 反诈跨窗一致性：fraud detect 用 rawBody（不能被 piiSanitize 干扰） ==="
# 笔记评论 — 注意 piiSanitize 会脱敏电话，detectFraud 必须看 raw
NOTE_OWNER_ID=$(sqlite3 "$DB" "SELECT owner_id FROM shareables WHERE id='$NOTE_ID';")
NOTE_OTHER_BK=$(sqlite3 "$DB" "SELECT api_key FROM users WHERE id != '$NOTE_OWNER_ID' AND length(api_key)=16 AND role='buyer' LIMIT 1;")
if [[ -n "$NOTE_OTHER_BK" ]]; then
  NOTE_RES=$(curl -sS -X POST "$BASE/api/shareables/$NOTE_ID/comments" -H "Authorization: Bearer $NOTE_OTHER_BK" -H "Content-Type: application/json" \
    -d '{"body":"smoke 测试电话 13900001111 验证 fraud rawBody"}')
  chk_has "W6 笔记 fraud detect 看到 raw phone_cn" '"phone_cn"' "$NOTE_RES"
fi

echo ""
echo "=================================="
if [[ "$FAIL" -gt "0" ]]; then
  printf "❌ %d passed / %d failed\n" "$PASS" "$FAIL"
  printf "%b\n" "$FAIL_LOG"
  exit 1
else
  printf "✅ %d passed / 0 failed\n" "$PASS"
fi
