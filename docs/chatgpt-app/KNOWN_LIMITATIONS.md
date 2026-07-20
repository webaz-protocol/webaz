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
