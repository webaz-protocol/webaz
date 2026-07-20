# KNOWN_LIMITATIONS (Phase-3A)

> Honest limits of what Phase-3A delivered. Nothing here is claimed as live-host verified.

## Deferred DIRECT_TOOL conversions (kept as NL follow-up + fail-visible fallback)
- **🔄 查看最新状态** (`webaz_approval_requests`) and **联系商家** (`webaz_order_chat`): both target tools have **no `_meta` / no app-visibility / no card**. Converting to DIRECT_TOOL needs (a) widening their visibility to `['model','app']` and (b) deciding a render target (they have no widget). On ChatGPT the result of a card-initiated call to a non-card tool would render as model text — **LIVE_HOST_REQUIRED** to confirm behavior. Deferred to avoid a speculative visibility change on read tools; the NL path still works and is fail-visible. Not a regression.

## LIVE_HOST_REQUIRED (Phase 3B) — cannot close from code
- Whether ChatGPT renders a **cross-component** result (ProductResults calling `webaz_quote_order` → QuoteAndApproval card) as a new card, or feeds it back to the calling widget. The 准备下单 DIRECT_TOOL path assumes a new card; the NL fallback + copyable hint cover the case where it does not.
- Whether ChatGPT honors `_meta.ui.visibility:['app']` for `webaz_quote_order` when the legacy skybridge path is used (`window.openai.callTool`).
- Whether ChatGPT still requires `text/html+skybridge` vs `text/html;profile=mcp-app` (BUG-05, unchanged this phase — dual-emit preserved).
- Real enforced CSP / iframe `sandbox` strings.
- The real `duplicate=true` incident classification (needs the trace fields — remaining Phase-3A item).
- All card renders on ChatGPT web + iOS + Android.

## No columns exist for some "full terms" fields (BUG-01 scope note)
The `products` table has `specs / return_condition / ship_regions / has_variants / product_type / fragile`, but **no dedicated columns** for packaging, attachments, or third-party fulfillment. `full_terms` returns the untruncated fields that exist plus `has_variants`/`product_type`/`fragile`; packaging/attachments/third-party would live inside `specs`/`description` free text. Adding structured columns is out of scope (a seller-schema change), noted for a future PR.

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
