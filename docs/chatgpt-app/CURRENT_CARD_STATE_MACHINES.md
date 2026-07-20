# CURRENT_CARD_STATE_MACHINES

> Phase-2 §VIII. The render-state machine of each card, extracted from `ui-widgets.ts`. Each component's `renderBody(oai, out)` branches on `out.schema_version`; there is no persistent client state across host renders except in-memory `state` within one live widget instance.

## Shared boot state
- **Bridge selection** (standard resource only): `loading` → `ui/initialize` handshake (`connect(600)`) → **success**: standard facade, waits for `ui/notifications/tool-result` to render → **timeout/fail**: `window.openai` fallback, renders `toolOutput` → **neither**: read-only empty render (`ui-widgets.ts:112-130`). One-shot; never re-negotiates.
- **Legacy resource**: `loading` → render `window.openai.toolOutput` immediately (`:76-79`).
- Empty payload → "no structured payload visible to this widget." (`:190,:406,:514`).

## ProductResults
```
render(out) → branch on out.schema_version
├── product_detail.model.v1 → DETAIL view: [← 返回列表 (if cached)] + description(+truncation notice) + specs + terms   (terminal; back → SEARCH)
├── (no products) → ZERO-HIT view: strict-match notice + catalog_sample cards (no actions)
└── product_search.model.v1 → SEARCH view (default)
      state = { sort, selected{}, open{}, hint }   // in-memory, per instance
      SEARCH ──sort──▶ SEARCH (local reorder, scroll preserved)
      SEARCH ──expand/collapse──▶ SEARCH (open[id] toggles; mobile: one card at a time)
      SEARCH ──比较 (≥2)──▶ SEARCH + compare table
      SEARCH ──详情──▶ callTool webaz_search(detail) ⇒ host re-renders as DETAIL  (+ fail-visible hint if host silent)
      SEARCH ──准备下单──▶ follow-up message (model runs quote→draft→submit)      (+ hint; card stays SEARCH)
      SEARCH ──下一页──▶ callTool webaz_search(cursor) ⇒ host re-renders next page
```
Note: state is per-instance; a host that re-renders from a fresh tool-result **resets** sort/selection/open (no `setWidgetState` persistence used).

## QuoteAndApproval (one component, three terminal forms)
```
render(out) → branch on out.schema_version
├── order_quote.model.v1 → QUOTE
│     [创建订单草稿] ──callTool webaz_order_draft(create,quote_token)──▶ host re-renders as DRAFT (+ actHint)
│     button disabled on click, reenable 4s
├── order_draft.model.v1
│     ├── {drafts[]} → DRAFT-LIST (rows only, no actions)
│     └── single → DRAFT
│           [提交 Passkey 审批] ──callTool webaz_submit_order_request(draft_id)──▶ host re-renders as APPROVAL (+ actHint)
│           shown only if status==='draft'; disabled on click, reenable 4s
└── order_approval.model.v1 → APPROVAL (submit-time SNAPSHOT; never auto-updates)
      [打开审批页面] ──openWebaz(approval_url)──▶ webaz.xyz Passkey page  (+ always-copyable URL)
      [🔄 查看最新状态] ──follow-up webaz_approval_requests(get)──▶ model reports latest status
      if out.duplicate_warning → renders an explicit warning card (never silent second create)
```
Transition happens **server-side + host re-render**, not in-place: each `callTool` returns a new tool-result whose `schema_version` drives the next form. The card cannot itself advance QUOTE→DRAFT→APPROVAL without the host pushing a new result.

## OrderTimeline (one component, two schema families)
```
render(out) → branch on out.schema_version
├── order_status.model.v1
│     ├── up_to_date:true → "无新变化" (terminal)
│     ├── order (single) → MINI: status/next_actor/deadline + [查看完整时间线]──▶ callTool buyer_orders(full) ⇒ TIMELINE
│     └── list → LIST: summary counts + rows; row click ──▶ callTool buyer_orders(full) ⇒ TIMELINE
└── order_timeline.model.v1 → TIMELINE
      status label + deadline(local-tz) + timeline events + optional refund block
      [刷新]──▶ callTool buyer_orders(full)   [联系商家]──▶ follow-up order_chat   [订单页]──▶ openWebaz(#order/id)
```

## Cross-cutting state facts
- **No auto-refresh anywhere.** The APPROVAL card explicitly declares itself a submit-time snapshot and offers a manual "🔄 查看最新状态" (`ui-widgets.ts:476`). This is a deliberate design limit (the host cannot push server-side Passkey-approval events back to the card), **not a bug** — see OBSERVED_BUGS N7.
- **No `setWidgetState` / `widgetState` persistence** is used — all UI state is per-render in-memory. A host re-render loses sort/selection/expand.
- **Unknown schema_version** → "未知投影版本: <sv>" safe fallback (`:480,:544`); never force-renders the wrong form.

## BUG-08 addendum — approval card duplicate states
On a duplicate submit the approval card renders the precise `duplicate_reason` text (SAME_DRAFT_REPLAY / SAME_IDEMPOTENCY_KEY / ACTIVE_INTENT_REUSED / DATABASE_UNIQUE_RACE / RESPONSE_LOSS_RECONCILED) + `duplicate_of`. For ACTIVE_INTENT_REUSED it offers three distinct structured actions: 打开已有审批 · 取消本次 · 再买一份(独立购买). Non-duplicate → normal pending state. No generic "检测到重复"; no natural-language round-trip.
