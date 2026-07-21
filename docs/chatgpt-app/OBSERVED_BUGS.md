# OBSERVED_BUGS

> Phase-2 §XI. Each observed issue is graded and backed by code evidence. Nothing here is a fix; grades are strict.
> **CONFIRMED** = code/test-proven · **HIGH_CONFIDENCE** = code strongly supports, needs live/logs · **LIVE_HOST_REQUIRED** · **NOT_REPRODUCED** = insufficient/disproven (NOT a bug).

Order: real defects first, then disproven/by-design.

---

### BUG-01 — Detail truncation is partly SILENT and a dead end · CONFIRMED
- **Repro (code):** `projectProductDetail` byte-caps `return_condition`/`ship_regions` to 200 B **with no truncation flag**, and drops oversized `specs` wholesale; there is no agent-reachable full-text fetch.
- **Expected:** either full terms, or a flagged/paginated truncation with a way to get the rest.
- **Actual:** `return_condition` cut mid-sentence, no flag; `specs` vanish (card shows no specs, no notice); only `description` gets a "见商品页" notice; agents cannot retrieve the full text.
- **Code:** `src/agent-model-projection.ts:159-192` (caps 900/800/200; `return_condition` `:189` no flag); card `src/layer1-agent/L1-1-mcp-server/ui-widgets.ts:193-208`.
- **Evidence:** locked by `scripts/test-mcp-card-contract.ts` T1–T5.
- **Root cause:** model-projection byte budget with no companion "full detail" path.
- **Pending:** none (code-proven). **Remediation dir:** add `*_truncated` flag for return_condition; add an agent second-fetch (or point to a PWA deep link) for full terms.

### BUG-02 — Quoted delivery ETA is lost on the formal order · CONFIRMED (mechanism) / HIGH_CONFIDENCE (end-to-end)
- **Repro (code):** quote/search show `products.estimated_days` (live); the order shows `orders.shipping_est_days`, sourced only from the shipping **template** `est_days`. Product ETA is never persisted into quote/draft/order columns.
- **Expected:** the delivery estimate the buyer saw at quote time is the authority frozen onto the order.
- **Actual:** for a product with an ETA but no template covering the region, `shipping_est_days=null` on the order though the quote showed the ETA. Additionally the OrderTimeline card never renders `shipping_est_days` at all.
- **Code:** `src/pwa/buyer-quote.ts:160`; `src/shipping-templates.ts:124,:136`; `src/pwa/routes/orders-create.ts:348`; `src/agent-model-projection.ts:362`; card `ui-widgets.ts:544-573` (no ETA row).
- **Root cause:** two-source mismatch + a schema gap (no ETA column in quote/draft/order); `trade_terms_snapshot.fulfilment.estimated_days` freezes it but the card doesn't read it.
- **Pending:** the specific product's template state (not queried). **Remediation dir:** carry the quoted ETA into the snapshot, or render `trade_terms_snapshot.fulfilment.estimated_days` on the timeline card.

### BUG-03 — `duplicate=true` on a user's "first visible" approval · HIGH_CONFIDENCE (cause) / LIVE_HOST_REQUIRED (which cause)
- **Repro (code):** durable idempotency: a UNIQUE collision on `(order_id)` or `(human_id,intent_hash)` returns an existing live `order_submit` row as `duplicate:true`.
- **Expected:** a genuinely first submit creates a fresh pending approval.
- **Actual:** the user's first *visible* approval can return duplicate when a prior live submit of the same economic intent already exists (earlier turn/session) or after a ChatGPT safe-retry of a lost response.
- **Code:** `src/pwa/order-submit-request.ts:80-101,107-111,148`; indexes `src/runtime/webaz-schema-helpers.ts:1900-1904`.
- **Root cause:** correct idempotent reuse of a pre-existing live intent row; NOT a false positive against a new row (disproven — IDEMPOTENCY_TRACE_AUDIT Q8). Draft creation writes no intent row, so a clean first submit does not duplicate.
- **Pending:** whether the real incident was retry vs prior-intent — **blocked by weak correlation logging** (`agent_grant_auth_log` lacks request_id/intent_hash; `mcp-remote.ts` logs no tool_call_id).
- **Remediation dir (design only):** default-off diagnostic trace fields (tool_call_id, intent_hash prefix, reused_request_id); consider a UI note distinguishing "reused your existing pending approval" from a new one.

### BUG-04 — Widget resource URIs are unversioned (stale-cache risk) · HIGH_CONFIDENCE
- **Repro (code):** all six widget URIs are static (`ui://widget/webaz-products.html` etc.) with no hash/version segment.
- **Expected:** a content-addressed or versioned URI so a redeploy that changes the HTML busts the host cache.
- **Actual:** hosts cache by URI; a redeploy that changes the widget body can serve stale HTML until the host TTL expires (echoes the prior PWA no-cache lesson).
- **Code:** `src/layer1-agent/L1-1-mcp-server/server.ts:5951-5998`; matrix check 7.
- **Pending:** ChatGPT's real cache TTL (LIVE_HOST). **Remediation dir:** version the URI (e.g. `…-v<hash>.html`) or set explicit cache semantics; keep legacy URI aliased.

### BUG-05 — `_meta.ui.resourceUri` and `openai/outputTemplate` point to DIFFERENT resources · HIGH_CONFIDENCE (design) / LIVE_HOST_REQUIRED
- **Repro (code):** for all 5 UI tools, `_meta.ui.resourceUri` → the standard `-mcp.html`, `openai/outputTemplate` → the legacy `.html`. Official rule expects the two keys to name the same resource.
- **Actual:** deliberate — each host family loads the resource carrying the bridge it speaks; consequence: **ChatGPT only ever loads the legacy skybridge component**, and the entire standard `ui/*` bridge is dormant on ChatGPT.
- **Code:** tool `_meta` in `server.ts` (search `:735-740`, quote/draft/submit `:1982-2037`); matrix check 2; BRIDGE_PROTOCOL_AUDIT.
- **Pending:** whether ChatGPT would accept a single standard resource (i.e. whether the divergence is still necessary) — LIVE_HOST. **Remediation dir:** none yet — do NOT collapse until live-confirmed; it may be load-bearing for ChatGPT compatibility.

### BUG-06 — `status` field is object in timeline, string elsewhere · CONFIRMED (low severity)
- **Actual:** wire field `status` = `{code,label,label_en}` in `order_timeline` but a string in draft/submit/list schemas; a strict consumer must branch on `schema_version`. Documented (`tool-output-schemas.ts:59`) but a real cross-schema type change.
- **Code:** `agent-model-projection.ts:280,302,332-336,354`. **Remediation dir:** document prominently or normalize; low priority.

### BUG-07 — Wire timestamps are not timezone-qualified · HIGH_CONFIDENCE (low severity)
- **Actual:** `expires_at`/`deadline.iso`/timeline `at`/refund times are bare (no `Z`/offset); the card compensates client-side (`ui-widgets.ts:512`), so rendering is usually correct, but non-card consumers of structuredContent may misread them as local.
- **Code:** `agent-model-projection.ts:224,266,289,356,360,365`; upstream-bare evidence `:45`. **Remediation dir:** qualify at the projection layer.

### BUG-08 — Coarse `intent_hash` can block a genuine second identical purchase · HIGH_CONFIDENCE
- **Actual:** `intent_hash` excludes `draft_id` and any sub-24h time window; a real second identical order (same item/qty/terms/region) before the first executes is returned as duplicate.
- **Code:** `order-submit-request.ts:80-101`. Deliberate (comment `:78-79`) but a UX sharp edge. **Remediation dir:** allow an explicit "buy another" override; out of scope to change now.

### BUG-09 — Manifest advertises an old MCP protocol version · HIGH_CONFIDENCE (low severity)
- **Actual:** `remoteMcpManifest()` returns `protocol_version: '2025-03-26'` (`mcp-remote.ts:156`); current core spec is `2025-11-25`. Advertisement only; the transport negotiates its own version. **Remediation dir:** refresh the advertised string.

---

## Observed items that did NOT reproduce (NOT bugs)

### N1 — "Product card may show MCP tool instructions instead of the product" · NOT_REPRODUCED / LIVE_HOST_REQUIRED
No code path found: `webaz_search` binds ProductResults and renders `products[]`. The only developer-facing text near the surface is the **resource/tool descriptions** ("MCP App component rendering…"), which are not normally shown to end users. Needs a live ChatGPT repro to confirm any real occurrence. (See also N-DEV below.)

### N2 — "Draft tool shows quote tool's content/description" · NOT_REPRODUCED (disproven)
Wiring is correct: `webaz_order_draft` binds the QuoteAndApproval resource (shared **by design**) and stamps `schema_version='webaz.order_draft.model.v1'`; the component branches to the DRAFT form (`ui-widgets.ts:432`). quote/draft/approval share one component intentionally. Full chain verified: tool `_meta` → resource → ReadResource → MIME → HTML → boot → `schema_version` (matrix checks 5 & 9; `test-mcp-card-contract` S1–S3). Only a runtime `schema_version` error could cause it; none found.

### N3 — "Some tools only return stringified JSON" · NOT_REPRODUCED as a defect (by design)
The 5 card tools emit `structuredContent`; all other tools return content-only JSON **by design** (`server.ts:2166`). Spec-compliant (no outputSchema declared for them). See TOOL_OUTPUT_CONTRACT_AUDIT.

### N4 — "准备下单 jumps straight to submit approval" · NOT_REPRODUCED (disproven)
`prepareOrder` only sends a follow-up **message** (`ui-widgets.ts:244-250`); it never calls a money-path tool. The model may over-eagerly chain, but that is model behavior, not a card side effect.

### N5 — "Approval card doesn't auto-update to the order" · NOT_REPRODUCED as a bug (by design)
The APPROVAL card is a submit-time snapshot with a manual "🔄 查看最新状态" (`ui-widgets.ts:473-476`); the host cannot push server-side Passkey-approval events back. Deliberate limitation, honestly disclosed.

### N6 — "Component enables both bridges simultaneously" · NOT_REPRODUCED (disproven)
Single-bridge principle: one handshake outcome selects standard **or** `window.openai`, never both (`ui-widgets.ts:17,112-130`). See BRIDGE_PROTOCOL_AUDIT Q4–Q6.

### N7 — "Simulated escrow showing paid/USDC may mislead" · NOT_REPRODUCED as a code defect / LIVE_HOST_REQUIRED
Rail-honesty notes are present (`rail_note`, `disclosures`, "simulated escrow ≠ real USDC custody"; `tool-output-schemas.ts:82`, `order-submit-request.ts:65-68`, `ui-widgets.ts:360,454`). Whether it still misleads is a live-UX judgment, not a proven defect.

### N-DEV — "Card shows developer tool descriptions to consumers" · HIGH_CONFIDENCE (latent) / LIVE_HOST_REQUIRED
The resource descriptions ("MCP App component rendering webaz_search structuredContent…") and some tool descriptions are developer-facing. They are not part of the rendered card body (the body is `renderBody` output), but if a host surfaces `resource.description` in any user-visible affordance they would read as developer text. Needs live confirmation of where ChatGPT shows resource/tool descriptions.

### N-DUP-SUMMARY — "Submit text summary misses the duplicate note" · NOT_REPRODUCED (disproven)
The envelope summary runs on the **projected** object (`server.ts:6330-6331`), whose top-level `duplicate:true` is set by `projectSubmitConsumer:307`; `summarizeSubmitResult` surfaces the REUSED note. Locked by `test-mcp-card-contract` D4.
