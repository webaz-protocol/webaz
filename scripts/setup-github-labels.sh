#!/usr/bin/env bash
# setup-github-labels.sh
#
# 一次性脚本:在 GitHub repo 上创建/更新标签集
# One-shot script: create/update label set on the GitHub repo
#
# 用法 / Usage:
#   bash scripts/setup-github-labels.sh                       # 默认 webaz-protocol/webaz
#   REPO=owner/repo bash scripts/setup-github-labels.sh       # 自定义 repo
#
# 依赖:gh CLI 已登录(gh auth login)
# Requires: gh CLI authenticated (gh auth login)

set -euo pipefail

REPO="${REPO:-webaz-protocol/webaz}"

echo "🏷  Setting up labels on $REPO"
echo ""

# 颜色配色(GitHub hex,不含 #)
# Color palette (GitHub hex, no #)
#   type/feature:    1f883d (green)
#   type/bug:        d73a4a (red)
#   type/rfc:        7057ff (purple)
#   type/meta:       b60205 (dark red — 元规则相关高优先)
#   type/docs:       0075ca (blue)
#   type/chore:      ededed (grey)
#   priority:        ff8800 / ffa500 / ffcc00 / d4d4d4 (gradient)
#   area:            5319e7 (dark purple)
#   status:          c5def5 (light blue) — 流转中
#   rfc:             d4c5f9 (lavender)
#   meta:            fef2c0 (light yellow — 醒目但非紧急)
#   iron-rule:       b60205 (red — 单独标记技术边界,非元规则)

# ============================================================================
# Migration: delete legacy M1-M10 meta labels (one-time, idempotent)
# 旧 M1-M10 命名跟协议里程碑(M1-M7)+ 开放协作 milestone(M1-M3)冲突
# 元规则用 #1-#10(对齐 docs/META-RULES-FULL.md)
# Iron-Rule 独立为单独 label(技术边界,不是元规则)
# ============================================================================
echo "── migration: delete legacy meta:M* labels ──"
for old_label in "meta:M1-symbiosis" "meta:M2-anti-manipulation" \
                 "meta:M3-purpose-bound" "meta:M4-transparency" \
                 "meta:M5-iron-rule" "meta:M6-economic-neutral" \
                 "meta:M7-guide-not-manip" "meta:M8-fairness" \
                 "meta:M9-non-invasive" "meta:M10-phase-disclosure"; do
  gh label delete "$old_label" --repo "$REPO" --yes 2>/dev/null && echo "  - deleted: $old_label" || true
done

create_label() {
  local name="$1"
  local color="$2"
  local description="$3"

  if gh label list --repo "$REPO" --limit 200 | awk -F'\t' '{print $1}' | grep -qx "$name"; then
    echo "  ↻ updating: $name"
    gh label edit "$name" --repo "$REPO" --color "$color" --description "$description" >/dev/null
  else
    echo "  + creating: $name"
    gh label create "$name" --repo "$REPO" --color "$color" --description "$description" >/dev/null
  fi
}

# ============================================================================
# type:* — 一个 issue/PR 一个 type
# type:* — one type per issue/PR
# ============================================================================
echo "── type:* ──"
create_label "type:bug"                  "d73a4a" "Bug / 错误行为"
create_label "type:feature"              "1f883d" "New feature / 新功能"
create_label "type:rfc"                  "7057ff" "Request for Comments / 重大设计提案"
create_label "type:meta-rule-question"   "fbca04" "Meta-rule interpretation question / 元规则解释"
create_label "type:meta-rule-revision"   "b60205" "Meta-rule revision (RFC+60d+multisig) / 元规则修订"
create_label "type:docs"                 "0075ca" "Documentation only / 纯文档"
create_label "type:refactor"             "c2e0c6" "Refactor, no behavior change / 重构无行为变化"
create_label "type:chore"                "ededed" "Build, deps, tooling / 构建依赖工具"
create_label "type:security"             "ee0701" "Security / 安全(优先 advisory)"

# ============================================================================
# priority:* — 单选
# priority:* — single select
# ============================================================================
echo "── priority:* ──"
create_label "priority:P0"               "ff0000" "Critical / 阻塞上线或安全"
create_label "priority:P1"               "ff8800" "High / 应当尽快处理"
create_label "priority:P2"               "ffcc00" "Medium / 计划内"
create_label "priority:P3"               "d4d4d4" "Low / nice-to-have"

# ============================================================================
# area:* — 多选(影响哪些模块)
# area:* — multi-select (which modules affected)
# ============================================================================
echo "── area:* ──"
create_label "area:protocol"             "5319e7" "Core protocol engines / 核心协议引擎"
create_label "area:mcp"                  "5319e7" "MCP tool surface / MCP 工具表面"
create_label "area:pwa"                  "5319e7" "PWA web app / PWA 网页应用"
create_label "area:desktop"              "5319e7" "Electron desktop / 桌面壳"
create_label "area:docs"                 "5319e7" "Governance, charter, brand docs / 治理文档"
create_label "area:ci"                   "5319e7" "CI / build / workflow"
create_label "area:economy"              "5319e7" "Economic model, fees, rewards / 经济模型"
create_label "area:identity"             "5319e7" "Passkey, agent identity, custodian / 身份"
create_label "area:i18n"                 "5319e7" "Localization / 国际化"

# ============================================================================
# status:* — 流转状态(单选)
# status:* — workflow status (single select)
# ============================================================================
echo "── status:* ──"
create_label "status:needs-triage"       "c5def5" "Awaiting maintainer triage / 待 triage"
create_label "status:accepted"           "0e8a16" "Accepted, ready for work / 已采纳待开工"
create_label "status:in-progress"        "fbca04" "Actively being worked on / 进行中"
create_label "status:blocked"            "ee0701" "Blocked by dependency / 被阻塞"
create_label "status:needs-review"       "1d76db" "Awaiting code review / 待 review"
create_label "status:wontfix"            "ffffff" "Decided not to do / 不做"
create_label "status:duplicate"          "cfd3d7" "Duplicate of another issue / 重复"

# ============================================================================
# rfc:* — RFC 生命周期(仅 RFC 类 issue 使用)
# rfc:* — RFC lifecycle (RFC issues only)
# ============================================================================
echo "── rfc:* ──"
create_label "rfc:draft"                 "d4c5f9" "RFC draft, gathering feedback / 草案征求反馈"
create_label "rfc:review"                "8a4ddc" "RFC under formal review / 正式审议"
create_label "rfc:accepted"              "0e8a16" "RFC accepted / 已通过"
create_label "rfc:rejected"              "b60205" "RFC rejected / 已驳回"
create_label "rfc:deferred"              "fbca04" "RFC deferred (90d archive) / 暂缓 90 天归档"
create_label "rfc:emergency"             "ee0701" "Emergency RFC (24h fast-track) / 应急修订"

# ============================================================================
# meta:* — 元规则关联标记(对应 docs/META-RULES-FULL.md 的 #1-#10)
# meta:* — meta-rule cross-cut markers (matches docs/META-RULES-FULL.md #1-#10)
# 注:M1-M7 是协议里程碑 / M1-M3 是开放协作 milestone(完全不同的命名空间)
# Note: M1-M7 are protocol milestones; M1-M3 are open-collab milestones (different namespace)
# ============================================================================
echo "── meta:* ──"
create_label "meta:1-visibility"        "fef2c0" "Touches #1 当一切可见 / When all is visible"
create_label "meta:2-code-is-rule"      "fef2c0" "Touches #2 代码即规则,协议即信任 / Code is rule, protocol is trust"
create_label "meta:3-no-data-theft"     "fef2c0" "Touches #3 不偷数据 / No data theft"
create_label "meta:4-no-lies"           "fef2c0" "Touches #4 不撒谎 / No lies"
create_label "meta:5-no-favoritism"     "fef2c0" "Touches #5 不偏袒 / No favoritism"
create_label "meta:6-no-abuse"          "fef2c0" "Touches #6 不滥用 / No abuse"
create_label "meta:7-no-manipulation"   "fef2c0" "Touches #7 不操纵 / No manipulation"
create_label "meta:8-min-intervention"  "fef2c0" "Touches #8 最小介入 / Minimal intervention"
create_label "meta:9-algo-is-protocol"  "fef2c0" "Touches #9 算法即协议 / Algorithm is protocol"
create_label "meta:10-webazer"          "fef2c0" "Touches #10 参与者即 webazer / Participants are webazers"

# ============================================================================
# iron-rule — 技术边界 label(不是元规则,但是关键安全标记)
# iron-rule — technical boundary label (NOT a meta-rule, but critical security marker)
# 跨 #4 不撒谎 + #5 不偏袒 + #6 不滥用 + #7 不操纵 的技术强制
# 7 paths: arbitrate / vote / agent_revoke / delete_passkey / revoke_key / rotate_key / wallet
# ============================================================================
echo "── iron-rule ──"
create_label "iron-rule"                 "b60205" "⚠ Iron-Rule technical boundary (7 real-human Passkey paths)"

# ============================================================================
# 社区友好 / Community-friendly markers
# ============================================================================
echo "── community ──"
create_label "good first issue"          "7057ff" "Good for newcomers / 新手友好"
create_label "help wanted"               "008672" "Extra attention is needed / 求支援"
create_label "needs-bilingual"           "0075ca" "Missing zh/en parity / 缺中英文对应"
create_label "discussion-needed"         "d876e3" "Open question, needs community input / 需社区讨论"

echo ""
echo "✅ Done. View labels: https://github.com/$REPO/labels"
