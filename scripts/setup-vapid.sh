#!/usr/bin/env bash
# Tier 1 #4 — VAPID key 生成 + Railway 设置指引
#
# 用法：在你本地（不是 Railway）跑一次：
#   bash scripts/setup-vapid.sh
#
# 输出两段：公钥（前端 build 时也要这个）+ 私钥（仅 server env）。
# 全程不写文件、不进 git。

set -e

# 检查 npx
if ! command -v npx >/dev/null 2>&1; then
  echo "✗ 需要 npx (Node.js)"
  exit 1
fi

echo "→ 生成 VAPID key pair（256-bit P-256 ECDSA）..."
RAW=$(npx --yes web-push generate-vapid-keys --json 2>/dev/null)

PUB=$(echo "$RAW" | python3 -c 'import sys,json;print(json.load(sys.stdin)["publicKey"])')
PRIV=$(echo "$RAW" | python3 -c 'import sys,json;print(json.load(sys.stdin)["privateKey"])')

cat <<EOF

╔═══════════════════════════════════════════════════════════════════╗
║  VAPID key pair 已生成 — 立刻复制到 Railway 并永久销毁此终端记录   ║
╚═══════════════════════════════════════════════════════════════════╝

请到 Railway dashboard → 当前 webaz service → Variables，按下表设：

  VAPID_PUBLIC_KEY   = $PUB
  VAPID_PRIVATE_KEY  = $PRIV

⚠ 重要：
  · PRIVATE 绝不能进 git / chat / Slack / 笔记
  · 一旦订阅用户开始推送，这对 key 不可再换（换 = 所有订阅失效）
  · 公钥也是 PWA 订阅时需要的，由 GET /api/push/vapid-public-key 暴露
  · 完成后：(1) 关掉这个终端窗口 / 清 history (2) Railway redeploy

验证（重部署后 30s）：
  curl -s https://<你的-railway-url>/api/push/vapid-public-key
  # 期望：{"key":"B..."}（未配置时返 503 + 错误文案）

  # 或更快的状态检测：
  curl -s -H "Authorization: Bearer <任一登录 user 的 api_key>" \\
       https://<你的-railway-url>/api/push/status | jq .vapid_configured
  # 期望 true

EOF
