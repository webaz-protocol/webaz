# CURRENT_BUTTON_INVENTORY

> **Phase-3A update:** each button now carries an `interaction_class` (LOCAL_UI / DIRECT_TOOL / MODEL_REQUIRED) — the authoritative 23-row classification with all fields lives in **MODEL_USAGE_ARCHITECTURE.md §III** and **FULL_BUTTON_TEST_MATRIX.md**. Two changes since Phase 2: (1) **准备下单** is now **DIRECT_TOOL** — it calls `webaz_quote_order{product_id,quantity:1}` directly (NL follow-up kept only as fail-visible fallback); (2) a new **查看完整条款** button (DIRECT_TOOL, `webaz_search` with `full_terms:true`) was added to the detail view (BUG-01). Count is now **23** controls.
>
> Phase-2 §VIII. Extracted from the ACTUAL component source `src/layer1-agent/L1-1-mcp-server/ui-widgets.ts` — not from any ideal design. Every button below exists in code with the cited line.
> Test-level legend: **CODE_INSPECTED** (read this phase) · **UNIT_TESTED** (a `scripts/test-*` exercises it) · HOST_SIMULATED/CHATGPT_WEB_TESTED/IOS_TESTED/ANDROID_TESTED — **none used** (no live ChatGPT access this phase, per instruction).

## ProductResults (`PRODUCT_RESULTS_BODY_JS`)

| button / control | line | shown when | disabled when | calls | side effect | loading | dup-guard | Passkey | test level |
|---|---|---|---|---|---|---|---|---|---|
| Sort: 默认 / 价格↑ / 价格↓ | 267-271 | always (search page) | — | none (local sort) | none | no | n/a | no | UNIT_TESTED (product-presentation-ui) |
| 下一页 | 273-276 | `next_cursor && callTool` | — | `callTool webaz_search{cursor,limit:5}` | read (page) | no | onceGuard 1.5s | no | CODE_INSPECTED |
| title (click) → expand | 290-291 | always | — | none (toggleOpen) | none | no | n/a | no | UNIT_TESTED (product-widget-expand) |
| 展开 / 收起 | 313-315 | always | — | none (toggleOpen) | none | no | n/a | no | UNIT_TESTED (product-widget-expand) |
| 详情 | 317-319 | `result_handle` present | — | `callTool webaz_search{result_handle,selected_ids}` + fail-visible hint | read (detail) | hint text | onceGuard 1.5s | no | CODE_INSPECTED |
| 准备下单 (primary) | 325-327 | always | — | **follow-up message only** (`sendFollowUpCompat`, asks model to run quote→draft→submit) + hint | **none directly** (model orchestrates) | hint text | onceGuard 1.5s | downstream (webaz.xyz) | UNIT_TESTED (agent-approvals/quote-approval indirectly) |
| 比较 / 已选✓ | 328-330 | always | — | none (local select) | none | no | n/a | no | CODE_INSPECTED |
| 准备下单 (compare mini) | 345-347 | ≥2 selected | — | same follow-up as primary | none directly | hint | onceGuard 1.5s | downstream | CODE_INSPECTED |
| 复制 (hint) | 356 | a hint is shown | — | `navigator.clipboard.writeText` (fail-visible) | none | "复制中…" | n/a | no | CODE_INSPECTED |
| ← 返回列表 | 195 | detail view + cached search | — | none (re-render cached list) | none | no | n/a | no | UNIT_TESTED (product-widget-expand) |

0-hit recovery view (②): catalog-sample cards render **no action buttons** (`:220-223`).

## QuoteAndApproval (`QUOTE_APPROVAL_BODY_JS`)

| button / control | line | shown when | disabled when | calls | side effect | loading | dup-guard | Passkey | test level |
|---|---|---|---|---|---|---|---|---|---|
| toggler ×4 (费用明细/退货保修/风险轨道/汇率) | 415,420,422,423 | quote form | — | none (local expand) | none | no | n/a | no | UNIT_TESTED (quote-approval-ui) |
| 创建订单草稿(不扣款) | 427-429 | `quote_token && callTool` | `disabled=true` on click, reenable 4s | `callTool webaz_order_draft{action:create,quote_token}` + actHint | additive draft (no fund/stock) | disabled | onceGuard + disabled | no (draft) | UNIT_TESTED (quote-approval-ui) |
| toggler 轨道说明 | 441 | draft form | — | none | none | no | n/a | no | UNIT_TESTED |
| 提交 Passkey 审批(不会直接执行) | 444-446 | `status==='draft' && callTool` | `disabled=true`, reenable 4s | `callTool webaz_submit_order_request{draft_id}` + actHint | additive approval-queue INSERT (no execution) | disabled | onceGuard + disabled | **execution needs Passkey @webaz.xyz** | UNIT_TESTED (quote-approval-ui) |
| 打开审批页面(webaz.xyz·Passkey) | 462-470 | approval form | — | `openWebaz(approval_url)` + **always** append copyable URL | opens webaz.xyz (Passkey page) | — | onceGuard | yes (target page) | UNIT_TESTED (quote-approval-ui) |
| 🔄 查看最新状态 | 473-475 | approval form | `disabled=true`, reenable 4s | follow-up `webaz_approval_requests(get)` | read | disabled | onceGuard + disabled | no | UNIT_TESTED (quote-approval-ui) |
| 复制 (actHint) | 402 | after any action | — | clipboard write | none | — | n/a | no | CODE_INSPECTED |

## OrderTimeline (`ORDER_TIMELINE_BODY_JS`)

| button / control | line | shown when | disabled when | calls | side effect | loading | dup-guard | Passkey | test level |
|---|---|---|---|---|---|---|---|---|---|
| 查看完整时间线 (single) | 527-529 | order_status single + callTool | — | `callTool webaz_buyer_orders{order_id,full:true}` | read | no | onceGuard | no | UNIT_TESTED (order-timeline-ui) |
| order row (click, list) | 538 | order_status list + callTool | — | `callTool webaz_buyer_orders{order_id,full:true}` | read | no | onceGuard | no | UNIT_TESTED (order-timeline-ui) |
| 刷新 | 566-568 | timeline form + callTool | — | `callTool webaz_buyer_orders{order_id,full:true}` | read | no | onceGuard | no | UNIT_TESTED (order-timeline-ui) |
| 联系商家 | 571-573 | timeline + canFollowUp | — | follow-up `webaz_order_chat` read | read | no | onceGuard 2s | no | UNIT_TESTED (order-timeline-ui) |
| 订单页(webaz.xyz) | 575-577 | timeline form | — | `openWebaz(#order/<id>)` | opens webaz.xyz | no | onceGuard | high-risk actions live there | UNIT_TESTED (order-timeline-ui) |

## Totals
- **ProductResults:** 10 controls · **QuoteAndApproval:** 7 · **OrderTimeline:** 5 → **22 real controls** across 3 components (excluding pure text/disclosure lines).
- **Zero** widget button directly moves funds or executes an order. The only two `callTool`s with any write are `webaz_order_draft` (additive draft) and `webaz_submit_order_request` (additive approval-queue INSERT); both are non-executing and gated by a human Passkey at webaz.xyz. — CONFIRMED
- Every button that calls the host is capability-probed and fail-visible (a copyable manual phrase is always left when the host callback is silently dropped).
- No button was tested on a real ChatGPT web/iOS/Android host this phase.
