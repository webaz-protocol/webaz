# FULL_BUTTON_TEST_MATRIX

> **Phase-3A.1 update:** rows 17 (查看最新状态) and 22 (联系商家) are now **DIRECT_TOOL** (were DIRECT_TOOL-target-NL). New controls: 发送给订单对方 (DIRECT_TOOL, `webaz_order_chat` send, UNIT_TESTED via `test-mcp-direct-tool-buttons`), 查看订单 (DIRECT_TOOL, conditional on executed), chat textarea (LOCAL_UI). Runtime invariants (no-model, single-flight, idempotency, no sensitive-field auto-insert, `fallback_reason`) locked by `scripts/test-mcp-direct-tool-buttons.ts` (12). Authoritative counts: MODEL_USAGE_ARCHITECTURE.md header (LOCAL_UI 12 / DIRECT_TOOL 14 / target-NL 0). Still no CHATGPT_WEB/IOS/ANDROID levels.


> Phase-3A §X. Test level per button + which §X low-token invariant covers it. Test levels: **CODE_INSPECTED** · **UNIT_TESTED** · **HOST_SIMULATED** (JSDOM/vm) · **LIVE_HOST_REQUIRED**. No CHATGPT_WEB / IOS / ANDROID levels (no real ChatGPT access this phase).

## Automated tests backing this matrix
- `scripts/test-product-widget-expand.ts` (43) — ProductResults: LOCAL_UI (sort/expand/select/返回 — HOST_SIMULATED in a minimal DOM), DIRECT_TOOL 详情/准备下单 (single structured call, no NL when callTool present), fail-visible fallback, compare-row.
- `scripts/test-mcp-quote-approval-ui.ts` — QuoteAndApproval: DIRECT_TOOL 创建草稿/提交审批, duplicate warning, disclosures.
- `scripts/test-mcp-order-timeline-ui.ts` — OrderTimeline: DIRECT_TOOL 刷新/时间线/list, fail-visible.
- `scripts/test-mcp-apps-standard.ts` — standard `ui/*` bridge single-call (node:vm).
- `scripts/diagnose-mcp-card-matrix.ts` — check 11: DIRECT_TOOL card tools are app-visible.
- `scripts/test-mcp-card-contract.ts` (24) — truncation/full-terms, duplicate mapping, schema alignment.

## §X invariant coverage
| # | §X invariant | covered by | level |
|---|---|---|---|
| 1 | LOCAL_UI buttons emit no MCP tool call | widget-expand (sort/expand/select assert no `callTool`) | HOST_SIMULATED |
| 2 | DIRECT_TOOL buttons emit exactly ONE structured call | widget-expand B2-3 (准备下单=1 quote_order), detail B4-5 | HOST_SIMULATED |
| 3 | DIRECT_TOOL buttons create no NL chat message (when callTool available) | widget-expand B2-4 (`sent.length===0`) | HOST_SIMULATED |
| 4 | DIRECT_TOOL buttons don't depend on model tool-selection | structured args carry product_id/quote_token/order_id directly (code) | CODE_INSPECTED |
| 5 | Rapid double-click → no duplicate tool call | `onceGuard` 1.5s + disabled (code); server intent_hash for submit | CODE_INSPECTED |
| 6 | Component remount doesn't double-register events | fresh iframe per render; standard bridge removes listener on fail | CODE_INSPECTED / LIVE_HOST_REQUIRED (in-place reboot) |
| 7 | MODEL_REQUIRED buttons have an explicit reason | none at button level (documented in MODEL_USAGE_ARCHITECTURE) | CODE_INSPECTED |
| 8 | Large UI data not unconditionally in structuredContent/content | search minimal projection + on-demand detail/full_terms (card contract) | UNIT_TESTED |
| 9 | app-only tools don't enter the model tool list | WebAZ uses `['model','app']` (no app-only-hidden tool); check 11 | UNIT_TESTED |
| 10 | No-UI host still has short text fallback | `content` summary for the 5 tools; JSON for others (card contract) | UNIT_TESTED |
| 11 | 22(+1) buttons all have interaction_class | MODEL_USAGE_ARCHITECTURE §III table | CODE_INSPECTED |

## Per-button test level
| # | card | button | interaction_class | test level | test |
|---|---|---|---|---|---|
| 1 | Product | Sort | LOCAL_UI | UNIT_TESTED | product-presentation-ui / widget-expand |
| 2 | Product | title→expand | LOCAL_UI | UNIT_TESTED | widget-expand B1 |
| 3 | Product | 展开/收起 | LOCAL_UI | UNIT_TESTED | widget-expand B1 |
| 4 | Product | 比较/已选 | LOCAL_UI | HOST_SIMULATED | widget-expand B4-7/8 |
| 5 | Product | 复制 (hint) | LOCAL_UI | CODE_INSPECTED | — |
| 6 | Product | ← 返回列表 | LOCAL_UI | UNIT_TESTED | widget-expand B1 |
| 7 | Product | 下一页 | DIRECT_TOOL | CODE_INSPECTED | (callTool webaz_search cursor) |
| 8 | Product | 详情 | DIRECT_TOOL | UNIT_TESTED | widget-expand B4-5 |
| 9 | Product | 查看完整条款 (new) | DIRECT_TOOL | UNIT_TESTED | card-contract T8 (fetch ref) |
| 10 | Product | 准备下单 (primary) | DIRECT_TOOL | UNIT_TESTED | widget-expand B2-3/4/5 |
| 11 | Product | 准备下单 (compare) | DIRECT_TOOL | UNIT_TESTED | widget-expand B4-8 (NL fallback path) |
| 12 | Quote | toggler ×4 | LOCAL_UI | UNIT_TESTED | quote-approval-ui |
| 13 | Quote | 创建订单草稿 | DIRECT_TOOL | UNIT_TESTED | quote-approval-ui |
| 14 | Quote | toggler 轨道 | LOCAL_UI | UNIT_TESTED | quote-approval-ui |
| 15 | Quote | 提交 Passkey 审批 | DIRECT_TOOL | UNIT_TESTED | quote-approval-ui |
| 16 | Quote | 打开审批页面 | LOCAL_UI (NAV) | UNIT_TESTED | quote-approval-ui |
| 17 | Quote | 🔄 查看最新状态 | DIRECT_TOOL-target (NL) | UNIT_TESTED | quote-approval-ui (fallback) — conversion LIVE_HOST_REQUIRED |
| 18 | Quote | 复制 (actHint) | LOCAL_UI | CODE_INSPECTED | — |
| 19 | Timeline | 查看完整时间线 | DIRECT_TOOL | UNIT_TESTED | order-timeline-ui |
| 20 | Timeline | order row | DIRECT_TOOL | UNIT_TESTED | order-timeline-ui |
| 21 | Timeline | 刷新 | DIRECT_TOOL | UNIT_TESTED | order-timeline-ui |
| 22 | Timeline | 联系商家 | DIRECT_TOOL-target (NL) | UNIT_TESTED | order-timeline-ui (fallback) — conversion LIVE_HOST_REQUIRED |
| 23 | Timeline | 订单页 | LOCAL_UI (NAV) | UNIT_TESTED | order-timeline-ui |

**No button is CHATGPT_WEB_TESTED / IOS_TESTED / ANDROID_TESTED** — those require Phase 3B live-host access.

## BUG-08 addendum — duplicate/second-purchase buttons
| button | test | result |
|---|---|---|
| 打开已有审批 (duplicate) | existing openWebaz path | unchanged, fail-visible |
| 取消本次 (ACTIVE_INTENT_REUSED) | vm render D1 | present; client-only no-op (nothing to cancel server-side) |
| 再买一份 (ACTIVE_INTENT_REUSED only) | vm render D1/D2 | present only for ACTIVE_INTENT_REUSED; absent on SAME_DRAFT_REPLAY; fail-visible explicit-purchase entry (server new_purchase_intent) |
| submit (idempotent) | test-bug08 1-7 | retry/double-click/response-loss/race → same request_id, no 2nd row |
Component-driven auto-chained 再买一份 (quote→draft→submit instance threading) = LIVE_HOST_REQUIRED.
