# REPRODUCTION_EVIDENCE

> Phase-2. Raw evidence backing each graded finding. "Protocol responses" here are from the in-process MCP client driving the real `buildMcpServer` (no production DB/network; the reference IDs were NOT queried, per the read-only constraint). Automated evidence is reproducible via the two scripts below.

## Reproduce it yourself (no side effects)
```
npx tsx scripts/diagnose-mcp-card-matrix.ts     # tool→resource→component wiring + 10 cross-checks
npx tsx scripts/test-mcp-card-contract.ts        # truncation caps/flags, duplicate mapping, schema alignment (16 assertions)
```

## E1 — Wiring (from the live server, diagnostic output)
```
tools=55 resources=10 ui_resources=6 ui_tools=5
webaz_search               → ui://widget/webaz-products-mcp.html        [ProductResults]   os=true sv=product_search | product_detail
webaz_buyer_orders         → ui://widget/webaz-order-timeline-mcp.html  [OrderTimeline]    os=true sv=order_status | order_timeline
webaz_quote_order          → ui://widget/webaz-quote-approval-mcp.html  [QuoteAndApproval] os=true sv=order_quote
webaz_order_draft          → ui://widget/webaz-quote-approval-mcp.html  [QuoteAndApproval] os=true sv=order_draft
webaz_submit_order_request → ui://widget/webaz-quote-approval-mcp.html  [QuoteAndApproval] os=true sv=order_approval
```
Cross-checks: 1,3,4,5,6,8,9,10 = pass; 2 = FLAG (resourceUri≠outputTemplate, see BUG-05); 7 = FLAG (unversioned URIs, see BUG-04). Full table: `RESOURCE_REGISTRATION_MATRIX.md`, `TOOL_COMPONENT_MATRIX.md`.

Note the `_meta` split proving BUG-05 (from the live tool descriptors): every UI tool's `_meta.ui.resourceUri` names `…-mcp.html` while `openai/outputTemplate` names the legacy `…​.html`.

## E2 — Truncation (BUG-01), verified code
`src/agent-model-projection.ts:159-189`:
```ts
export const DETAIL_SPECS_MAX_BYTES = 800
export const DETAIL_DESC_MAX_BYTES = 900
...
description: descCap.text || null,
description_truncated: descCap.truncated,               // flagged
...(specsTruncated ? { specs_truncated: true } : {}),   // specs dropped wholesale + flagged
return_condition: p.return_condition == null ? null : capBytes(String(p.return_condition), 200).text,  // 200B, NO FLAG
```
Contract-test proof: `T1 description≤900B`, `T2 description_truncated=true`, `T3 specs dropped + specs_truncated`, `T4 return_condition≤200B`, `T5 no return_condition_truncated flag` — all pass.

## E3 — Delivery ETA drift (BUG-02), verified code
- Quote reads product ETA live: `src/pwa/buyer-quote.ts:160` `estimated_days: prod?.estimated_days ?? null`.
- Order writes template ETA only: `src/pwa/routes/orders-create.ts:348` (`_ship.estDays`); `src/shipping-templates.ts:124` `if (!tpl) return { …, estDays: null }`.
- Card reads `logistics.shipping_est_days`: `src/agent-model-projection.ts:362`; timeline widget never renders it (`ui-widgets.ts:544-573` logistics block = tracking only).

## E4 — duplicate=true semantics (BUG-03), verified code
`src/pwa/order-submit-request.ts:148` (the sole set-site):
```ts
// equivalent request → RETURN the existing one (idempotent reuse, never a 2nd active row)
return { ok: true, request_id: String(existing.id), params_hash: String(existing.params_hash), duplicate: true }
```
Guarded by partial UNIQUE indexes (`webaz-schema-helpers.ts:1900-1904`) and `findActiveSubmit` (`order-submit-request.ts:107-111`). `intent_hash` excludes `draft_id` (`:80-101`). Draft creation writes no intent row (`order-draft.ts:108`), so a clean first submit does not duplicate.

## E5 — Envelope / no `_meta` leakage (TOOL_OUTPUT_CONTRACT_AUDIT), verified code
`src/layer1-agent/L1-1-mcp-server/server.ts:2163` returns only `{ content, structuredContent, isError? }`; `:6330-6331` projects then builds the envelope. `STRUCTURED_RESULT_TOOLS` (`:2178-2189`) = the 5 tools with outputSchemas — exact 5:5.

## E6 — Single-bridge (BRIDGE_PROTOCOL_AUDIT), verified code
`src/layer1-agent/L1-1-mcp-server/ui-widgets.ts:116-129`: `__br.connect(600).then(install standard facade).catch(fall back to window.openai)`; failure path removes the message listener (`:104`). Money-path buttons `onceGuard`+`disabled` (`:428,:445`).

## E7 — Disproven claims
- N2 (draft shows quote): wiring + `schema_version` verified; `test-mcp-card-contract` S1–S3 pass.
- N-DUP-SUMMARY (summary misses duplicate): `server.ts:6330-6331` projects first; `test-mcp-card-contract` D4 (`summarizeSubmitResult(projected)` contains "REUSED") passes.
- N6 (double bridge): single-bridge code path (E6).

## Live-host evidence still required (cannot produce from here)
Real ChatGPT web + mobile renders; enforced CSP/`sandbox`; which template key ChatGPT honors; whether the real `duplicate=true` incident was retry vs prior-intent (needs the trace fields BUG-03 proposes); whether any host surfaces resource/tool descriptions to users (N-DEV).
