#!/usr/bin/env bash
# #1018: charity 圆梦人认领 — POST /api/wishes/:id/fulfill
# 同时验证 POST /api/wishes/:id/claim 由 claim-initiators 占用（fraud-claim）
#
# 历史背景：claim-initiators (Phase 76) 注册早于 charity (Phase 6)，charity 的原
# POST /api/wishes/:id/claim 圆梦认领被 fraud-claim 路由 shadow 成 dead code，
# frontend.claimWish + MCP webaz_charity action=claim 都打不通。
# #1018 把 charity 圆梦改名 /fulfill，/claim 让 fraud-claim 独占。
set -u
BASE="${BASE:-http://localhost:3000}"
DB=~/.webaz/webaz.db
PASS=0; FAIL=0

chk() { local l="$1" e="$2" a="$3"
  if [[ "$a" == "$e" ]]; then PASS=$((PASS+1)); printf "✓ %s\n" "$l"
  else FAIL=$((FAIL+1)); printf "✗ %s [got '%s', expected '%s']\n" "$l" "$a" "$e"
  fi
}

SUFFIX=$(date +%s%N | tail -c 7)

# 注册 wisher + fulfiller
WK=$(curl -sS -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"wisher_${SUFFIX}\",\"role\":\"buyer\",\"region\":\"global\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_key",""))')
FK=$(curl -sS -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"fulfiller_${SUFFIX}\",\"role\":\"buyer\",\"region\":\"global\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_key",""))')
SK=$(curl -sS -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"selfish_${SUFFIX}\",\"role\":\"buyer\",\"region\":\"global\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_key",""))')
[[ -z "$WK" || -z "$FK" || -z "$SK" ]] && { echo "✗ 注册失败"; exit 1; }

WISHER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$WK'")
FULFILLER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$FK'")
SELFISH_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE api_key='$SK'")
echo "wisher=$WISHER_ID fulfiller=$FULFILLER_ID selfish=$SELFISH_ID"

# 发布 wish
WID=$(curl -sS -X POST "$BASE/api/wishes" -H "Authorization: Bearer $WK" -H 'Content-Type: application/json' \
  -d '{"title":"求一本旧教材","content":"高数同济第七版有空闲转让吗？","category":"education","target_kind":"item","window_hours":72,"allow_public":true}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
[[ -z "$WID" ]] && { echo "✗ wish 发布失败"; exit 1; }
echo "wish=$WID"

echo ""
echo "=== 1. wish 初始状态 = open ==="
S=$(curl -sS "$BASE/api/wishes/$WID" -H "Authorization: Bearer $WK" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))')
chk "status = open" "open" "$S"

echo ""
echo "=== 2. POST /api/wishes/:id/fulfill — fulfiller 认领 ==="
R=$(curl -sS -X POST "$BASE/api/wishes/$WID/fulfill" -H "Authorization: Bearer $FK")
OK=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))')
chk "fulfill 返回 ok=True" "True" "$OK"
TIMEOUT=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("claim_timeout_hours"))')
chk "claim_timeout_hours = 48" "48" "$TIMEOUT"

echo ""
echo "=== 3. wish 状态转换：open → claimed ==="
S=$(curl -sS "$BASE/api/wishes/$WID" -H "Authorization: Bearer $WK" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))')
chk "status = claimed" "claimed" "$S"

echo ""
echo "=== 4. is_wisher / is_fulfiller 视角正确 ==="
WV=$(curl -sS "$BASE/api/wishes/$WID" -H "Authorization: Bearer $WK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(str(d.get("is_wisher"))+"|"+str(d.get("is_fulfiller")))')
chk "wisher 视角 is_wisher=True is_fulfiller=False" "True|False" "$WV"
FV=$(curl -sS "$BASE/api/wishes/$WID" -H "Authorization: Bearer $FK" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(str(d.get("is_wisher"))+"|"+str(d.get("is_fulfiller")))')
chk "fulfiller 视角 is_wisher=False is_fulfiller=True" "False|True" "$FV"

echo ""
echo "=== 5. 第二次 fulfill 拒绝（已认领）==="
ERR=$(curl -sS -X POST "$BASE/api/wishes/$WID/fulfill" -H "Authorization: Bearer $FK" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error",""))')
chk "重复 fulfill 报错" "该愿望已被认领或已结束" "$ERR"

echo ""
echo "=== 6. /api/wishes/:id/claim 由 claim-initiators 占用（fraud-claim 不是圆梦）==="
# 不带 body 命中 fraud-claim path → 应报 claim_target 必填
ERR=$(curl -sS -X POST "$BASE/api/wishes/$WID/claim" -H "Authorization: Bearer $FK" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error",""))')
case "$ERR" in
  *claim_target*) PASS=$((PASS+1)); printf "✓ %s\n" "/claim 路由属 fraud-claim（要求 claim_target）" ;;
  *)              FAIL=$((FAIL+1)); printf "✗ %s [got '%s']\n" "/claim 路由属 fraud-claim" "$ERR" ;;
esac

echo ""
echo "=== 7. 防自施善：用 fresh wish 测 ==="
WID2=$(curl -sS -X POST "$BASE/api/wishes" -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
  -d '{"title":"自施善测试 wish","content":"测试 anti-self-fulfill guard 的硬性拦截","category":"other","target_kind":"item","window_hours":72,"allow_public":false}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
[[ -z "$WID2" ]] && { echo "✗ wish2 发布失败"; }
ERR=$(curl -sS -X POST "$BASE/api/wishes/$WID2/fulfill" -H "Authorization: Bearer $SK" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error",""))')
case "$ERR" in
  *禁止圆自己*) PASS=$((PASS+1)); printf "✓ %s\n" "自施善被拦 + 30 天封锁" ;;
  *)            FAIL=$((FAIL+1)); printf "✗ %s [got '%s']\n" "自施善拦截" "$ERR" ;;
esac

echo ""
echo "=== 清理 ==="
sqlite3 "$DB" "DELETE FROM notifications WHERE wish_id IN ('$WID','$WID2')"
sqlite3 "$DB" "DELETE FROM wishes WHERE id IN ('$WID','$WID2')"
sqlite3 "$DB" "DELETE FROM charity_blocklist WHERE user_id='$SELFISH_ID'"
sqlite3 "$DB" "DELETE FROM charity_reputation WHERE user_id IN ('$WISHER_ID','$FULFILLER_ID','$SELFISH_ID')"
sqlite3 "$DB" "DELETE FROM registration_audit_log WHERE user_id IN ('$WISHER_ID','$FULFILLER_ID','$SELFISH_ID')"
sqlite3 "$DB" "DELETE FROM wallets WHERE user_id IN ('$WISHER_ID','$FULFILLER_ID','$SELFISH_ID')"
sqlite3 "$DB" "DELETE FROM users WHERE id IN ('$WISHER_ID','$FULFILLER_ID','$SELFISH_ID')"
echo "✓ 已清理"

echo ""
echo "─────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || { echo "❌ 失败"; exit 1; }
