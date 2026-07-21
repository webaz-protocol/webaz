# Phase 3B Round 1 — Live-Host UI Findings (F3 / F4 / F5)

> Source: real ChatGPT Developer-mode test on production `webaz.xyz` (deployment `5daf7d25` = tag
> `phase3a-ci-green-8cdd3db`, commit `8cdd3db`), buyer account Tina, owner-performed Passkey.
> Money-path was fully safe (one order, one debit, request↔order 1:1, trace zero-PII). These are UI /
> host-integration defects only. F2 (search recall) is tracked separately in KNOWN_LIMITATIONS, NOT fixed here.

## F4 — widget tool-result not consumed (HIGH)

**Symptom (live):** clicking 准备下单 → card froze on "正在获取报价…"; the quote tool *did* execute server-side, so
repeated clicks produced **5 duplicate quotes** (server idempotency protected money/orders; UX failed). 查看最新状态
and the draft/submit buttons show the same freeze.

**Verified root cause (code, not host assumption)** — `src/layer1-agent/L1-1-mcp-server/ui-widgets.ts`:
1. `prepareOrder` (L259) calls `oai.callTool('webaz_quote_order', …)` **fire-and-forget** — the returned Promise is
   discarded; `structuredContent` is never read; the card is never re-rendered. Only `state.hint` is set.
2. Same fire-and-forget on **create-draft** (L468) and **submit** (L485).
3. These depend on the **standard SEP-1865** `ui/notifications/tool-result` path (L95 `onMsg` → L114 `__onToolResult`
   → `renderBody`). **ChatGPT uses the legacy `window.openai` bridge, which emits no such notification** → the
   executed tool's result is silently dropped and the card stays a submit-time snapshot.
4. `__onToolResult` re-renders through the **same** widget's `renderBody`, with **no type router** — a quote result
   arriving at ProductResults would misrender via the products renderer (0-hit branch).

**Proof the correct pattern already exists in the same file** (so this is a code gap, not a host limitation):
- refresh-status (L582-583): `var p=oai.callTool('webaz_approval_requests',…); p.then(applyApprovalStatus, …)` — consumes.
- 再买一份 chain (L540-556): `Promise.resolve(oai.callTool(…)).then(function(qr){ var q=consume(qr); … })` — consumes.
- chat list/send (L714, L727-728): consume `p.then(...)`.

**Checklist answers (§二):** (1) yes callTool; (2) **prepareOrder/draft/submit do NOT await/consume the Promise**
(refresh/reorder/chat do); (3) not read for the three buttons; (4) **no type router**; (5) standard bridge listens for
tool-result, legacy does not; (6) **legacy path fires without consuming** — the bug; (7) standard correlates request-id
for the promise but the notification path is uncorrelated to the initiating card; (8) `state.hint` loading never clears
(no result consumption); (9) **callTool rejection unobserved on the three buttons** (swallowed); (10) CARD tools have
widgets, but the legacy widget must self-consume, which the three buttons don't.

## F3 — ETA object rendered as `[object Object]` (MEDIUM)

**Symptom:** ProductResults card ("预计送达 {"SG":12,"all":12}") and QuoteAndApproval quote card. OrderTimeline card
and the model's text both render "约12天" correctly.

**Root cause:** `products.estimated_days` is stored as a region→days JSON (`{"SG":12,"all":12}`); the detail projection
JSON-parses it to an object, then `ui-widgets.ts:326` (product card) and `:458` (quote card) do `String(obj)` →
`[object Object]`. OrderTimeline has a proper `etaText()` formatter (L677); the other two lack it.

## F5 — model narrative count ≠ card count (MEDIUM)

**Symptom:** model text "找到6款 / 推荐3款", ProductResults card shows 1 product.

**Verified facts:** the widget renders **all** products it receives (`ui-widgets.ts:221/294/299` — no truncation).
`webaz_search` is strict-match, default limit 5, unconstrained-browse cap 8 (server.ts L691/L715) — so a single default
search can never yield "6". The card's search strict-matched 1; the "6款/3推荐" came from the model's recommendation
narration (PR-B3), a different/larger set. **Card-vs-narrative mismatch, not truncation, and not a data-volume risk**
(the 5/8 caps + cursor pagination remain the bound). Fix = surface explicit candidate vs shown/verified counts so the
model narration and the card agree, within the existing caps.

## Non-goals (unchanged): money/amounts, escrow, Direct Pay, order state machine, Passkey execution, DB migrations,
BUG-08 idempotency server semantics, promised-ETA snapshot, Schema v2 contracts, OAuth, legacy-bridge removal.
