# MODEL_USAGE_ARCHITECTURE — Model-When-Necessary (low-token interaction)

> Phase-3A supplemental. Principle: **UI interactions are deterministic and must not round-trip through the model.** The model is used only for natural-language understanding, semantic comparison, recommendation, and explanation.
> Grades: **CONFIRMED** (code) · **HIGH_CONFIDENCE** · **LIVE_HOST_REQUIRED** · **NOT_REPRODUCED**.

## interaction_class taxonomy
- **LOCAL_UI** — modifies component-local state only; no server, no model (sort/expand/select/compare/copy; deterministic `openExternal` NAV to webaz.xyz).
- **DIRECT_TOOL** — the component calls a WebAZ tool with **structured params**; no model tool-selection, no natural-language chat message.
- **MODEL_REQUIRED** — genuinely needs NL understanding / semantic judgment / recommendation / summarization / explanation.

## §II Difference audit vs the 5 principles

| principle | status | evidence |
|---|---|---|
| 1. Pure UI interactions don't call the model | ✅ CONFIRMED | sort/expand/select/compare/copy/返回 all mutate in-memory `state` and `render()` — no `callTool`, no `sendFollowUp` (`ui-widgets.ts:263-363`). |
| 2. Deterministic business interactions call tools directly | ✅ mostly CONFIRMED (after this commit) | 详情/下一页 → `webaz_search`; 创建草稿 → `webaz_order_draft`; 提交审批 → `webaz_submit_order_request`; 刷新/时间线/列表 → `webaz_buyer_orders`; **准备下单 → `webaz_quote_order` (fixed this phase)**. |
| 3. Only NL/semantic/recommend/explain uses the model | ✅ CONFIRMED | The only model entry in the main chain is the initial "I want X" product understanding + optional AI-recommendation passthrough (server never generates; `ui-widgets.ts:285-293`). |
| 4. Ordinary buttons must not send NL to chat to invoke tools | ⚠️ PARTIAL → fixed for 准备下单; 2 residual | Before: 准备下单/查看最新状态/联系商家 sent NL follow-ups. After: 准备下单 is DIRECT_TOOL. **查看最新状态 & 联系商家 remain NL** because their tools (`webaz_approval_requests`, `webaz_order_chat`) have no `_meta`/app-visibility and no card to render into (see §V). |
| 5. Large UI data not unconditionally in model context | ✅ CONFIRMED | search returns a short summary in `content` + a minimal projection in `structuredContent`; full detail is an on-demand fetch (`result_handle`), full terms an explicit `full_terms` fetch (BUG-01). |

### Compliant now
Every LOCAL_UI control; all read/refresh/pagination/detail DIRECT_TOOL buttons; the whole quote→draft→submit chain is card-driven DIRECT_TOOL after this phase.

### Not yet compliant (residual)
- **查看最新状态** (approval status) and **联系商家** (order chat) still use NL follow-ups. Their target tools are not app-visible and have no card. Converting them is DIRECT_TOOL-eligible but requires (a) widening tool visibility to app and (b) a render target — and cross-tool render on ChatGPT is **LIVE_HOST_REQUIRED**. Kept as NL with fail-visible copy fallback; deferred (see KNOWN_LIMITATIONS).

### Buttons changed this phase
- **准备下单** (ProductResults primary + compare-row): NL follow-up → **DIRECT_TOOL** `webaz_quote_order{product_id,quantity:1}` (default address server-side), NL retained as fail-visible fallback. `webaz_quote_order` visibility widened `['model']`→`['model','app']` (additive). Risk: cross-component quote-card render is LIVE_HOST_REQUIRED; fallback covers it.

## §III/IV — interaction_class of all buttons (23 controls; 22 from Phase-2 + 1 new full-terms)

| # | card | button | interaction_class | current impl | MCP? | model? | chat msg? | into ctx? | tool | side effect | Passkey | idempotency | test level |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Product | Sort 默认/↑/↓ | LOCAL_UI | local sort | no | no | no | no | — | none | no | n/a | UNIT_TESTED |
| 2 | Product | title→expand | LOCAL_UI | toggleOpen | no | no | no | no | — | none | no | n/a | UNIT_TESTED |
| 3 | Product | 展开/收起 | LOCAL_UI | toggleOpen | no | no | no | no | — | none | no | n/a | UNIT_TESTED |
| 4 | Product | 比较/已选 | LOCAL_UI | local select | no | no | no | no | — | none | no | n/a | CODE_INSPECTED |
| 5 | Product | 复制 (hint) | LOCAL_UI | clipboard | no | no | no | no | — | none | no | n/a | CODE_INSPECTED |
| 6 | Product | ← 返回列表 | LOCAL_UI | re-render cache | no | no | no | no | — | none | no | n/a | UNIT_TESTED |
| 7 | Product | 下一页 | DIRECT_TOOL | callTool | yes | no | no | no | webaz_search | read | no | onceGuard | CODE_INSPECTED |
| 8 | Product | 详情 | DIRECT_TOOL | callTool | yes | no | no | no | webaz_search (result_handle) | read | no | onceGuard | UNIT_TESTED |
| 9 | Product | 查看完整条款 (new) | DIRECT_TOOL | callTool | yes | no | no | no | webaz_search (full_terms) | read | no | onceGuard | UNIT_TESTED |
| 10 | Product | 准备下单 (primary) | DIRECT_TOOL | callTool + NL fallback | yes | no | no (direct) | no | webaz_quote_order | additive quote | downstream | onceGuard | UNIT_TESTED |
| 11 | Product | 准备下单 (compare) | DIRECT_TOOL | callTool + NL fallback | yes | no | no (direct) | no | webaz_quote_order | additive quote | downstream | onceGuard | UNIT_TESTED |
| 12 | Quote | toggler ×4 | LOCAL_UI | local expand | no | no | no | no | — | none | no | n/a | UNIT_TESTED |
| 13 | Quote | 创建订单草稿 | DIRECT_TOOL | callTool+disabled | yes | no | no | no | webaz_order_draft | additive draft | no | onceGuard+disabled | UNIT_TESTED |
| 14 | Quote | toggler 轨道说明 | LOCAL_UI | local expand | no | no | no | no | — | none | no | n/a | UNIT_TESTED |
| 15 | Quote | 提交 Passkey 审批 | DIRECT_TOOL | callTool+disabled | yes | no | no | no | webaz_submit_order_request | additive queue | **exec: yes** | onceGuard+disabled+server intent_hash | UNIT_TESTED |
| 16 | Quote | 打开审批页面 | LOCAL_UI (NAV) | openExternal | no | no | no | no | — (webaz.xyz) | nav | yes (page) | onceGuard | UNIT_TESTED |
| 17 | Quote | 🔄 查看最新状态 | DIRECT_TOOL-target (currently NL) | sendFollowUp | via model | yes | yes | yes | webaz_approval_requests | read | no | onceGuard | UNIT_TESTED |
| 18 | Quote | 复制 (actHint) | LOCAL_UI | clipboard | no | no | no | no | — | none | no | n/a | CODE_INSPECTED |
| 19 | Timeline | 查看完整时间线 | DIRECT_TOOL | callTool | yes | no | no | no | webaz_buyer_orders | read | no | onceGuard | UNIT_TESTED |
| 20 | Timeline | order row (click) | DIRECT_TOOL | callTool | yes | no | no | no | webaz_buyer_orders | read | no | onceGuard | UNIT_TESTED |
| 21 | Timeline | 刷新 | DIRECT_TOOL | callTool | yes | no | no | no | webaz_buyer_orders | read | no | onceGuard | UNIT_TESTED |
| 22 | Timeline | 联系商家 | DIRECT_TOOL-target (currently NL) | sendFollowUp | via model | yes | yes | yes | webaz_order_chat | read | no | onceGuard 2s | UNIT_TESTED |
| 23 | Timeline | 订单页(webaz.xyz) | LOCAL_UI (NAV) | openExternal | no | no | no | no | — (webaz.xyz) | nav | high-risk there | onceGuard | UNIT_TESTED |

### Distribution
- **LOCAL_UI: 11** (1-6, 12, 14, 16, 18, 23)
- **DIRECT_TOOL: 10** (7-11, 13, 15, 19, 20, 21)
- **DIRECT_TOOL-target, currently NL (deferred, LIVE_HOST_REQUIRED): 2** (17, 22)
- **MODEL_REQUIRED (button-level): 0** — no button needs semantic judgment; the only genuine model use is the initial product-intent understanding (not a button) + optional AI-recommendation passthrough.

## §V — no deterministic button silently round-trips through the model
Verified pattern `click → NL to chat → model re-interprets → model selects tool` existed only for 准备下单/查看最新状态/联系商家. 准备下单 is fixed. 17 & 22 keep NL **as a fallback**, tagged LIVE_HOST_REQUIRED, never deleted. No LOCAL_UI or read/pagination button routes through NL.

## §VIII — component state layering
- **LOCAL UI STATE**: `state = {sort, selected{}, open{}, hint}` (ProductResults `:232`), toggler `.hide` classes, disabled/reenable — never pushed to model context.
- **SERVER BUSINESS STATE**: price/stock/quote/draft/approval/order/logistics — fetched via DIRECT_TOOL calls, re-read on refresh; never mutated client-side.
- **MODEL CONTEXT**: only `content` summary + minimal `structuredContent`; UI state changes (sort/expand/scroll/select) do **not** call `ui/update-model-context` (WebAZ widgets never call it — verified absent in `ui-widgets.ts`). CONFIRMED: no per-click/expand/scroll model-context update.

## Main-chain model participation points (the low-token goal)
```
NL "I want a ring under S$30"     ← MODEL_REQUIRED (understand intent, pick filters) — 1 model point
  → webaz_search (model/DIRECT)   → ProductResults card
  → 详情 / 查看完整条款             ← DIRECT_TOOL (no model)
  → 准备下单                        ← DIRECT_TOOL webaz_quote_order (no model)   [was NL]
  → 创建订单草稿                    ← DIRECT_TOOL webaz_order_draft (no model)
  → 提交 Passkey 审批              ← DIRECT_TOOL webaz_submit_order_request (no model)
  → webaz.xyz Passkey             ← human
```
After this phase the happy path has **one** model participation point (initial intent) plus optional recommendation — the card chain is model-free. Confirming the cross-card renders on a real host is LIVE_HOST_REQUIRED.

## §IX — cost/interaction telemetry (design; not yet emitted — Phase-3A remainder)
A zero-PII per-interaction record is proposed (default-safe, opt-in like the shadow limiter): `interaction_class, model_invoked, tool_called, tool_name, chat_message_created, structured_content_bytes, content_bytes, meta_bytes, duration_ms, retry_count, success`. Caveats honored: **cannot read OpenAI's internal token usage**; `model_invoked` = only whether WebAZ observed the interaction go through a model path (NL follow-up = true; DIRECT_TOOL = false); never logs NL text/address/payment. Design lives here; wiring is a remaining Phase-3A item (see PHASE3_TEST_RESULTS "remaining").
