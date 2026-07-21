# TOOL_OUTPUT_CONTRACT_AUDIT — envelope, schema, data visibility

> Phase-2 §V. Verified in `server.ts` (`buildToolEnvelope` `:2152`, `projectForTool` `:2139`, `STRUCTURED_RESULT_TOOLS` `:2178`, CallTool tail `:6308-6348`), `agent-model-projection.ts`, `tool-output-schemas.ts`. Locked by `scripts/test-mcp-card-contract.ts` (16/16). No code changed.
> Grades: **CONFIRMED** · **HIGH_CONFIDENCE** · **NOT_REPRODUCED**.

## 1. structuredContent ↔ outputSchema — exact 5:5, no mismatch — CONFIRMED
`STRUCTURED_RESULT_TOOLS` (`server.ts:2178-2189`) = `OUTPUT_SCHEMAS` (`tool-output-schemas.ts:21-121`) = exactly **{webaz_search, webaz_buyer_orders, webaz_quote_order, webaz_order_draft, webaz_submit_order_request}**. Every one emits `structuredContent` (`server.ts:2163`) AND declares an `outputSchema`. Every other tool hits the `else` (`server.ts:2166`) → `content`-only, no structuredContent, no outputSchema.
- No tool emits structuredContent without outputSchema. — CONFIRMED
- No tool declares outputSchema without emitting structuredContent. — CONFIRMED
- The broader §V list (webaz_discover, webaz_approval_requests, webaz_order_chat, webaz_address, webaz_buyer_action_request, webaz_prepare_case) return **content-only JSON** — no structuredContent, so no outputSchema is required for them. — CONFIRMED (this is spec-compliant, not a gap)

## 2. Is `content[]` a summary or a JSON dump? — CONFIRMED (mixed by design)
`server.ts:2161`: `const text = isErr ? JSON.stringify(clean) : summarize(clean)`.
- The 5 structured tools, **success** → short one/two-line summary (`summarize*` in `agent-model-projection.ts`), e.g. `summarizeSearchResult` "Found N … Details in structuredContent." Full data stays in structuredContent, not duplicated into content.
- The 5 structured tools, **error** → full minified error JSON in content (intentional `server.ts:2324` — plaintext clients keep `recovery` fields).
- **All other tools** → full minified JSON dump of the whole result into content (`server.ts:2166`).
So "some tools return stringified JSON in content" is **true by design for non-card tools**, not a defect. — CONFIRMED

## 3. `_meta` leakage — none on result envelopes — CONFIRMED
`buildToolEnvelope` returns only `{content, structuredContent?, isError?}` (`server.ts:2152,:2163,:2166,:2171`). **No `_meta` on any tool RESULT.** Every `_meta` in server.ts is on a tool/resource **definition** (ListTools/ListResources CSP), never a result. No PII/secret/token path via `_meta`. — CONFIRMED
- **`_mode` stamp:** `server.ts:6313-6319` writes `_mode` ('network'|'sandbox'|'network_readonly') + optional `_sandbox_note` onto the raw result before projection. For **non-projected** structured paths (webaz_search; webaz_buyer_orders list/minimal/up_to_date) `projectForTool` returns the object unchanged, so `_mode` appears in structuredContent; for **projected** paths (quote/draft/submit/full-timeline) a fresh object is built and `_mode` is dropped. `_mode` is a non-sensitive honesty stamp, not leakage. `webaz_search`'s outputSchema has no `additionalProperties:false`, so the extra `_mode` key does not fail validation. — CONFIRMED (non-issue, noted for completeness)

## 4. schema_version + business type, and type drift — CONFIRMED
- `schema_version` stamped by `projectQuoteConsumer:253`, `projectDraftConsumer:279`, `projectSubmitConsumer:300`, `projectOrderTimelineConsumer:347`. **`projectProductModel` does NOT stamp schema_version** — it is stamped one layer up in `handleSearch` (`server.ts:2704/2862/2903`); the single-product projection object is unversioned on its own. — CONFIRMED
- **Business `type`:** none of the projections emit a field named `type`. Only submit carries a discriminator: `action_type:'order_create'` (`:302`). Quote/draft/timeline/product rely on `schema_version` alone. — CONFIRMED
- **Type drift across stages (the notable one — `status`):**
  - timeline: `status: statusView(o.status)` → **object** `{code,label,label_en}` (`:332-336,:354`).
  - draft: `status` = **string** (`:280`); submit: `status:'pending'` **string** (`:302`); buyer_orders list/up_to_date: **raw status string** (documented `tool-output-schemas.ts:59`).
  → the wire field `status` is an object in the timeline schema and a string in the others. **Documented + intentional, but it is a real cross-schema type change** a strict consumer must branch on `schema_version` to read. — CONFIRMED
  - `quantity`: number (quote `:248`) / passthrough (draft `:283`) / nullable (timeline `:351`). Minor shape inconsistency. — CONFIRMED
  - `price`/`display`/`amount_minor`: consistent (`price` always object, `display` always formatted string, `amount_minor` number|null). — CONFIRMED (no drift)

## 5. Timestamps timezone-qualified? — HIGH_CONFIDENCE: NO (bare passthrough)
Projection timestamps are emitted verbatim from upstream, no `Z`/offset added: `expires_at` (`:266,:289`), `fiat_estimate.as_of` (`:224`), `deadline.iso` (`:356`, with a `note:'render in the viewer local timezone'`), timeline `at` (`:360`), refund `created_at`/`resolved_at` (`:365`). Internal evidence that upstream is bare: `productDecisionFlags:45` must do `String(seller_created_at).replace(' ','T')+'Z'` to parse it — i.e. the DB timestamps are space-separated with no offset. The card compensates client-side (`localTime()` in ui-widgets appends `Z` if absent, `:512`), so rendering is usually correct, but the **wire values are not TZ-qualified**. — HIGH_CONFIDENCE

## Verdicts vs the §V checklist
| # | question | verdict |
|---|---|---|
| 1 | outputSchema == structuredContent | ✅ exact 5:5 — CONFIRMED |
| 2 | any tool returns only stringified JSON | non-card tools by design; card tools emit structuredContent — CONFIRMED |
| 3 | real structuredContent also provided | yes for the 5 — CONFIRMED |
| 4 | content = model/user summary | yes for 5-success; JSON dump otherwise — CONFIRMED |
| 5 | unnecessary business data in `_meta` | none — CONFIRMED |
| 6 | secrets/PII/address in `_meta` | none — CONFIRMED |
| 7 | component reads structuredContent (not content) | yes — standard bridge renders `r.structuredContent` (`ui-widgets.ts:114`); legacy reads `toolOutput` — CONFIRMED |
| 8 | component force-renders on wrong `type` | no — each render body guards `out.schema_version` and shows "未知投影版本" (`ui-widgets.ts:406,480,544`) — CONFIRMED |
| 9 | missing schema_version / type | `projectProductModel` lacks schema_version (stamped upstream); no `type` field anywhere — CONFIRMED |
| 10 | field type drift | `status` object↔string; `quantity` shape — CONFIRMED |
| 11 | timestamps TZ-qualified | bare passthrough — HIGH_CONFIDENCE |
| 12 | WAZ/USDC display consistent | consumer projections relabel to USDC + rail-honesty notes (`tool-output-schemas.ts:82`, `order-submit-request.ts:65-68`) — CONFIRMED consistent at projection layer |
