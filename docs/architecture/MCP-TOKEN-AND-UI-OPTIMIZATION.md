# MCP Token & UI Optimization — Architecture

> Series: PR-1 #401 · PR-2 #402 · PR-3 #403 (all production-verified on webaz.xyz) · PR-7 (this PR, verification pending deploy).
> UI components (ProductResults / QuoteAndApproval / OrderTimeline) are PR-4..6 — pending a host-support
> spike (MCP Apps rendering must be verified on real ChatGPT/Claude clients before we build).

## 1. The three-layer data model

```
Model Projection  (webaz.*.model.v1)   — what the LANGUAGE MODEL sees: decision fields only
UI Projection     (planned, PR-4..6)   — what components fetch on demand (images, full specs)
Backend Internal  (never leaves the server) — full rows, hashes, migration/backfill columns,
                                              commission_rate, sourcing data, full addresses, keys
```

Discipline (same strength as `agent-order-minimal-view.ts`): projections are **allowlist-constructed
literal objects — rows are never spread**. Internal fields are unreachable by construction, not
stripped by denylist. Single truth source: `src/agent-model-projection.ts`.

## 2. Before / after

### webaz_search (production-measured)

Before (2026-07-18 audit): every product = the full DB row spread — **99 fields, 38 null/empty,
~3.2KB/item**, including `commitment_hash`, `price_hash`, `metrics_backfilled_at`,
`cold_start_remaining`, `score_breakdown`, `commission_rate`, `source_url/source_price` — inside a
pretty-printed JSON-in-text block. 3 items ≈ 12.9KB.

After: `structuredContent` (`webaz.product_search.model.v1`) — 13 decision keys/item, sellers deduped,
`decision_flags` server-asserted facts, `next_cursor` paging (default 5), `result_handle` for on-demand
detail. 3 items ≈ **2.1KB (−84%)**; 5-item benchmark 14,220B → 2,662B (**−81%**, CI-locked).
`content[0].text` = 1–3 sentence **actionable** summary (ids + prices + cursor) for text-only clients.

### tools/list (production-measured)

Before: one flat list — 54 tools, **~101–110KB (~25–35k tokens) to every client**, no filtering.
After (PR-3): surface-scoped. Anonymous/OAuth default = **buyer (21 tools, ~41KB, −63%)**;
`?surface=seller` (23); `?surface=full` (54); api_key bearer auto-full; stdio always full local set.
**Surface affects tools/list visibility ONLY — never authorization** (call-by-name + all call-time
gates unchanged; e2e-locked).

### webaz_info

Before: ~35KB long form on every onboarding call, including `available_tools` (redundant with
tools/list). After: compact overview (~12.5KB in production, dominated by live `network_live`
honesty disclosures which we keep); long form content-identical via MCP resource `webaz://guide/info`
or `{"full":true}` (deep-compare locked).

## 3. Token flow

```
tools/list  ── surface bundle ──────────────► model pays: 21 defs (~9.5k tok) not 54 (~25k)
tool call   ── model projection ────────────► structuredContent (minified, null-stripped*)
            ── degradation summary ─────────► content text: 1–3 sentences WITH actionable ids
            ── result_handle (PR-2) ────────► big follow-ups become {handle, selected_ids} (≤5)
            ── updated_since (PR-2) ────────► polling an order costs <400B when unchanged
            ── minify (PR-7, all tools) ────► pretty-print indent removed (~10–30%/response)
telemetry   ── mcp_tool_calls.response_bytes ► per-call model-visible bytes (no PII)
```
\* `webaz_buyer_orders` is exempt from null-stripping — its 7-key minimal contract keeps meaningful
null placeholders on the wire.

## 4. Security boundaries (unchanged, now test-locked)

- **Passkey iron rule untouched**: every economic execution still flows submit → human Passkey →
  server executes exactly once. This series changed read projections, serialization, and size-only
  telemetry (no economic writes, no content recording).
- **PII**: allowlist construction; addresses/contacts/keys never SELECTed on agent paths; paste-path
  `extracted` reduced to shape-checked `{platform, external_id}` (raw pastes can carry PII/tokens).
- **result_handle is not a permission channel**: handles store only id selection sets; every fetch
  re-reads live and re-runs the SAME public visibility predicates (active + stock + seller-pause +
  external-link governance); deactivated items return `unavailable_ids`, never cached data.
- **Surface ≠ authorization**: hidden tools dispatch identically when called by name.
- **Custody honesty preserved under compression**: deadlines, stakes, verifier counts, custody/refund
  semantics are safety material — description compression must never drop them (audit-enforced).

## 5. Incremental reads

`webaz_buyer_orders {order_id, full:true, updated_since}`: unchanged → tiny `up_to_date` reply.
Anchors cover every stored order-scoped source (order row, state history, returns created/resolved,
agent ship tracking, mutual-cancel proposals, disputes) plus the product row when return terms read
the live listing (`effectiveReturnDays().source === 'live_listing'` — the consumer's own predicate).
Purely time-derived eligibility is excluded by contract: take a full read before acting.
Same-second boundary: `up_to_date` uses strict `<`, timeline filter `>=` — duplicates possible,
loss forbidden.

## 6. Budgets & guards (CI)

| Guard | Lock |
|---|---|
| `test-mcp-model-projection` (36) | forbidden-internal-fields, PII, null-strip, page defaults, cursor disjointness, byte budgets, −60% acceptance vs legacy baseline |
| `test-mcp-result-handle` (34) | handle lifecycle, live-predicate re-run, TTL, caps (UTF-8 bytes), updated_since anchors, rate limit |
| `test-mcp-tool-surfaces` (17) | surface membership/counts, buyer ≤50% of full bytes, info slim/full/resource deep-identity |
| `test-mcp-definition-budget` (10) | surface byte ceilings (ratchet: lower-only), per-tool desc ≤2600 chars / def ≤7KB, global minify source lock, telemetry presence |

Current measurements (local): buyer 37,988B · seller 39,021B · full 101,728B; search5 −81%;
quote ≤3,000B; orders page ≤2,800B.

## 7. Planned (PR-4..6): UI projection & components

Data tool → model picks → render tool (`result_handle` + `selected_ids`) → MCP App component.
Images come from the PWA hash-addressed thumbnail endpoints (search responses deliberately carry no
image URLs). `_meta` will NOT carry UI payloads until per-host model-visibility is verified —
component-fetch tools are the primary path. Local interactions (expand/carousel/sort/compare) never
call the model; economic actions always return to the Passkey flow.
