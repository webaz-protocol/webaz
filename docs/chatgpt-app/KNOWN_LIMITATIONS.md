# KNOWN_LIMITATIONS (Phase-3A)

> Honest limits of what Phase-3A delivered. Nothing here is claimed as live-host verified.

## DIRECT_TOOL conversions — DONE in Phase-3A.1 (was deferred)
- **🔄 查看最新状态** (`webaz_approval_requests`) and **联系商家** (`webaz_order_chat`) are now DIRECT_TOOL (commit `a04ccd7`): app-visibility widened additively (`_meta.ui.visibility:['model','app']` + `widgetAccessible`, no `resourceUri`); the standard bridge returns the callTool promise so card-less results are consumed in-place. NL follow-up is retained ONLY as a fail-visible fallback (host without `callTool`), logging `fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE`.
- **Still LIVE_HOST_REQUIRED (Phase 3B):** whether ChatGPT renders/returns a card-initiated call to a **card-less** tool (`approval_requests`/`order_chat`) so the in-card status/chat area actually updates. The DIRECT path is implemented and consumes the returned promise; if a real host neither pushes a notification nor returns a value to the widget, the fail-visible fallback covers the user. **Chat SEND was tested with a mock/vm only — never against a real order** (no real message sent).

## LIVE_HOST_REQUIRED (Phase 3B) — cannot close from code
- Whether ChatGPT renders a **cross-component** result (ProductResults calling `webaz_quote_order` → QuoteAndApproval card) as a new card, or feeds it back to the calling widget. The 准备下单 DIRECT_TOOL path assumes a new card; the NL fallback + copyable hint cover the case where it does not.
- Whether ChatGPT honors `_meta.ui.visibility:['app']` for `webaz_quote_order` when the legacy skybridge path is used (`window.openai.callTool`).
- Whether ChatGPT still requires `text/html+skybridge` vs `text/html;profile=mcp-app` (BUG-05, unchanged this phase — dual-emit preserved).
- Real enforced CSP / iframe `sandbox` strings.
- The real `duplicate=true` incident classification (needs the trace fields — remaining Phase-3A item).
- All card renders on ChatGPT web + iOS + Android.

## No columns exist for some "full terms" fields (BUG-01 scope note)
The `products` table has `specs / return_condition / ship_regions / has_variants / product_type / fragile`, but **no dedicated columns** for packaging, attachments, or third-party fulfillment. `full_terms` returns the untruncated fields that exist plus `has_variants`/`product_type`/`fragile`; packaging/attachments/third-party would live inside `specs`/`description` free text. Adding structured columns is out of scope (a seller-schema change), noted for a future PR.

## BUG-02 (delivery ETA snapshot) — DONE (Phase-3A.2A), with these known limits
- ~~Direct buy-now orders carry no promised ETA (F2)~~ — **RESOLVED** (`0e17db4`): direct buy-now was confirmed a **live production purchase path** (`POST /api/orders` = `place_order`; `webaz_place_order` + PWA `#buy`), so per the "add ETA before BUG-06 if live" rule it now freezes the **current listing** at order-creation (= what the buyer saw). Also closed a wider gap: **direct_p2p orders** (draft AND buy-now, via `direct-pay-create.ts`) were entirely uncovered and are now snapshotted too. Both order-creation paths use `promisedEtaForOrder` (draft→inherit, direct→freeze). Only genuinely-no-ETA products stay `source:none` (honest, never fabricated). Locked by flow test F2a/b/c.
- **`logistics_eta` is not a live carrier feed.** WebAZ has no real-time logistics integration; the "当前物流预计" line is the order-time shipping-template estimate (`orders.shipping_est_days`), labeled as such. A true dynamic logistics ETA is future work.
- **No CJK→ISO region aliasing.** A region name that is not the (uppercased) template key is honestly `region_not_covered` (falls to wildcard/product-level). `sg`/`SG` agree (case-normalized, F1 fixed); `新加坡`→`SG` aliasing is out of scope.
- **LIVE_HOST_REQUIRED:** confirm the OrderTimeline card renders both ETAs correctly on a real ChatGPT host.

## Remaining Phase-3A work (NOT done — Phase-3A is NOT complete)
The following graded items from Phase 2 are **not yet implemented**; each is a money/state/schema change that warrants its own isolated, adversarially-reviewed, fresh-boot-verified change (per repo rules) and is gated on your go-ahead:
- **BUG-02** delivery-ETA snapshot (quote/draft/order freeze + DB migration + timeline card render).
- **BUG-04** widget resource URI versioning (+ old URI aliases).
- **BUG-06** status/quantity schema-version bump with dual-version component compat.
- **BUG-07** timestamp TZ-qualification at the projection layer.
- **BUG-08** duplicate-purchase semantics (product rule confirmation + two compatible options) + the zero-PII duplicate trace (§8/§IX telemetry wiring).
- **BUG-09** manifest protocol-version refresh (verify against official spec first).

Committed so far this phase: **BUG-01** (full product terms) and the **Model-When-Necessary** interaction fix (准备下单 → DIRECT_TOOL). See PHASE3_TEST_RESULTS.

## Things deliberately NOT changed (per your constraints)
- No legacy Skybridge removed; no template-key merge; no ext-apps SDK; no forced ChatGPT bridge switch; no component-layer rewrite.
- `webaz_quote_order` visibility was **widened** (additive `+app`), never narrowed; `['model']` retained.

## BUG-08 (duplicate purchase / idempotency / explicit second-purchase / trace) — DONE (Phase-3A.2C), with these limits
- **Server core is complete + tested** (25 assertions): three-layer identity (operation_attempt_id /
  idempotency_key / purchase_intent_instance), all six `duplicate_reason` paths, explicit
  `new_purchase_intent` → independent submit (distinct intent_hash, still Passkey-gated),
  response-loss reconcile, one-active-row money invariant, zero-PII fail-open trace. Independent
  adversarial review clean (no BLOCKER/HIGH). Rail-agnostic — no money/exec/ETA/schema-v2 change.
- **Widget-driven "再买一份" end-to-end chain — DONE (Phase-3A final closure).** The approval card's
  再买一份 now runs a deterministic DIRECT_TOOL chain in the component: `webaz_quote_order` (reorder
  product/qty) → `webaz_order_draft` (create, new quote_token) → `webaz_submit_order_request` (new draft,
  `new_purchase_intent`, one `purchase_intent_instance` threaded through the whole chain, fresh per-step
  `idempotency_key`). No natural language, no model, fail-stop on any step with a recovery entry, manual
  single-flight (triple-click = one chain), no auto-replay on remount, cancel is local-only, both the
  original and new approval entries kept. Proven in a `node:vm` Host simulation (test-bug08-second-
  purchase-widget-flow, 18). **Still LIVE_HOST_REQUIRED:** that the REAL ChatGPT host actually returns
  each card-initiated tool result to the widget so the chain advances (the vm proves the widget logic +
  arg threading; a real multi-call host round-trip can only be confirmed live).
- **§五.9-11 (fresh quote on expiry / stock=1 second-purchase fails / delisted-or-price-changed) are
  enforced by the EXISTING execution re-validation** at Passkey approval (unchanged by BUG-08), not by new
  code. They were not re-tested in this phase (the exec path was deliberately untouched).
- **Concurrency tests are single-process** (SQLite sync + partial-unique-index race handling proven by
  construction); a true multi-process race and process-restart retry are LIVE_HOST_REQUIRED.
- **MCP-level trace ids** (trace_id / interaction_id / widget_session_id / bridge_type / tool_call_id /
  mcp_request_id) are recorded when the component/tool supplies them; wiring the widget to emit them is
  incremental (the server-side correlation — request_id / draft_id / idempotency_key_hash /
  intent_hash_prefix / duplicate_reason / purchase_intent_instance — is populated now).
- **F2 — anonymous/free-text search recall (Round-1 live finding, NOT a Phase-3A regression):** `webaz_search`
  is strict-match (no fuzzy, default limit 5, unconstrained-browse cap 8; 0-hit → recovery → PWA #discover). Live
  dropship products sit on `category_id="cat_default"` (unpublished category), so free-text queries — even exact
  titles — return 0. Fix is data/config (assign published categories/keywords to products) + an optional matcher
  review; tracked separately from the Phase-3B UI hotfix (F3/F4/F5), NOT changed in that PR.

## R3-1 (2026-07-21, live-reproduced twice) — ChatGPT silently DROPS widget-initiated sendFollowUpMessage
- `window.openai.sendFollowUpMessage({prompt})` exists, the call succeeds, but the message never enters
  the conversation (no user turn, no model turn; reproduced on multiple products, dev-13 sandbox).
- Consequence: any "one-tap → model orchestrates next step" chain cannot rely on it. A2.1 mitigation:
  the copy fallback stays PERMANENTLY visible next to 继续下单, and the sent-state label promises only
  "已请求发送", never delivery. Re-probe this host capability on future ChatGPT sandbox updates.
