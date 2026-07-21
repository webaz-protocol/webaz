# IDEMPOTENCY_TRACE_AUDIT — `duplicate=true` on first-visible approval

> Phase-2 §VII. Full chain traced in code + verified by hand. No production behavior changed.
> Grades: **CONFIRMED** (code-proven) · **HIGH_CONFIDENCE** (code strongly supports, needs live/logs) · **LIVE_HOST_REQUIRED** · **NOT_REPRODUCED**.

## The chain (card click → DB write → envelope)

| hop | location | what happens |
|---|---|---|
| 1 | `ui-widgets.ts:445` | QuoteAndApproval "提交 Passkey 审批" button → `oai.callTool('webaz_submit_order_request',{draft_id})`, wrapped in `onceGuard`(1500ms) + `b2.disabled=true` (single-flight). |
| 2 | `server.ts:6262` → `handleSubmitOrderRequest` (`server.ts:3100`) | pure wrapper → HTTP `POST /api/agent/order-drafts/:id/submit`. No idempotency logic here. |
| 3 | `routes/agent-grants.ts:631` | `createOrderSubmitRequest(db,…)`; response body nests `idempotency:{ duplicate, reused_existing_request }`. |
| 4 | `order-submit-request.ts:113-152` | the INSERT + duplicate decision (below). |
| 5 | `agent-model-projection.ts:296-311` (`projectSubmitConsumer`) | reads `r.idempotency.duplicate` → emits top-level `duplicate:true` + `duplicate_warning`. |
| 6 | `server.ts:6330-6331` | `projected = projectForTool(...)`; `buildToolEnvelope(name, projected)` → structuredContent + summary. |

## The duplicate mechanism (CONFIRMED, verified in `order-submit-request.ts`)

- Approval rows live in **`agent_permission_requests`** (`kind='order_submit'`, `order_id` column reused as `draft_id`), guarded by **two partial UNIQUE indexes** (`webaz-schema-helpers.ts:1900-1904`):
  - `ux_apr_order_submit_active` on `(order_id)` where `kind='order_submit' AND status IN('pending','approved')` — one active submit per **draft**.
  - `ux_apr_intent_active` on `(human_id, intent_hash)` where `…AND executed_at IS NULL AND intent_hash IS NOT NULL` — one active submit per **human + economic intent**.
- `intent_hash` (`order-submit-request.ts:80-101`) = SHA-256 over the economic snapshot **excluding `draft_id`** (+ `human_id`, product, variant, seller, quantity, all unit/total units, currency, rail, dest_region, address_summary_hash, anonymous_recipient). No timestamp, no nonce.
- `duplicate:true` is set at **exactly one place — `order-submit-request.ts:148`** — only when: the INSERT throws a `UNIQUE` collision **AND** `findActiveSubmit` (`:107-111`) returns a live row (`status IN('pending','approved')`, `executed_at IS NULL`, matching `order_id=draftId` OR `intent_hash`) whose backing draft is **not** dead. It then **reuses** the existing `request_id`; no second row/order is created.
- TTL: the row's `expires_at = created_at + 24h` (`:131`). The intent lock releases on execution (`executed_at` set), terminal status, or TTL lapse.

## Precise semantics of `duplicate=true` (the §VII questions)

1. **Same HTTP request internal repeat?** No. — CONFIRMED
2. **Two MCP `tools/call`?** This is one trigger — the second collides. — CONFIRMED as a mechanism
3. **Two HTTP requests?** Same as (2) at the transport layer. — CONFIRMED
4. **Safe retry after a lost first response?** Yes — the first POST wrote the row but the response never reached ChatGPT; the retry collides → `duplicate:true`. This is the *designed* idempotent reuse. — CONFIRMED mechanism / **LIVE_HOST_REQUIRED** to confirm it was the actual incident
5. **A pre-existing pending request?** Yes — an earlier turn/session already submitted the same economic intent (still pending, not executed/expired) → a fresh submit collides via `intent_hash`. From the user's view this is their "first" approval yet returns duplicate. — CONFIRMED mechanism / **HIGH_CONFIDENCE** as the likely real cause
6. **Fingerprint too wide?** `intent_hash` excludes `draft_id` and any time window inside 24h → a genuine second identical purchase (same item/qty/terms/region) *before the first executes* is returned as duplicate. Deliberate (comment `:78-79`), but a real UX sharp edge. — **HIGH_CONFIDENCE** (H4)
7. **Front-end firing both bridges?** No — single-bridge design + `onceGuard`+`disabled` on the submit button (see BRIDGE_PROTOCOL_AUDIT). — **NOT_REPRODUCED**
8. **Server mislabels a brand-new record as duplicate?** No — it only ever returns an actually-existing live row; it never marks a DB-distinct new row as duplicate. — **NOT_REPRODUCED** (disproven)

### Does draft creation pre-seed an intent row? — NOT_REPRODUCED (disproven)
`order-draft.ts:108` inserts only into `order_drafts`; the only writer of an `order_submit` row is `createOrderSubmitRequest`. So a clean quote→draft→**first** submit with no prior submit does **NOT** return duplicate.

### Disproven side-claim — NOT_REPRODUCED
An earlier hypothesis held that `summarizeSubmitResult` misses the duplicate note because the route nests the flag under `idempotency.duplicate`. **Disproven:** `server.ts:6330-6331` projects **before** `buildToolEnvelope`, so the summary runs on the projected object whose top-level `duplicate:true` is set by `projectSubmitConsumer:307`. Locked by `test-mcp-card-contract.ts` D4.

## Most likely root cause of the observed incident
**HIGH_CONFIDENCE:** the user's "first visible" approval returned `duplicate=true` because a live prior `order_submit` row for the **same economic intent** already existed — most plausibly from (a) a ChatGPT safe-retry after a lost response, or (b) an earlier agent turn that already quoted→drafted→submitted the same item. Distinguishing (a) from (b) is **LIVE_HOST_REQUIRED** and blocked by weak correlation logging (below).

## Correlation identifiers that exist today (HIGH_CONFIDENCE: weak)
- `agent_grant_auth_log` (`agent-grants.ts:795`) records only `grant_id, human_id, capability, outcome, error_code` — **no** `request_id`/`intent_hash`/`params_hash`/`duplicate`/`tool_call_id`.
- `mcp-remote.ts` logs **no** per-`tools/call` identifiers (T8 privacy: no args/Authorization). The JSON-RPC `id` is never logged.
- The only durable correlation is the **DB row** (`agent_permission_requests`: `id`, `order_id`=draft_id, `human_id`, `params_hash`, `intent_hash`, `created_at`, `expires_at`, `executed_at`) and the HTTP **response body** (`request_id`, `params_hash`, `idempotency.*`). Tying two calls together requires querying `agent_permission_requests` by `human_id+intent_hash`; logs alone cannot.

## Trace fields Phase 3 should add (design only — do NOT change prod behavior now)
A default-off, test-only diagnostic could stamp (behind an env flag, no PII): the JSON-RPC `id` (`tool_call_id`), `intent_hash` prefix, `duplicate` flag, and `reused_existing_request_id` into a diagnostic log, so a real `duplicate=true` can be classified as retry-vs-prior-intent without guessing. This is a Phase-3 proposal, not built here.

## BUG-08 resolution (Phase 3A.2C) — gaps this audit found, now closed
- **H4 over-merge** (`intent_hash` excludes `draft_id` → different drafts merged forever): closed by the explicit `purchase_intent_instance` escape (folded into `intent_hash` only on the user's "再买一份"); implicit repeats still dedup. See `IDEMPOTENCY_IMPLEMENTATION.md`.
- **Weak correlation logging** (only the DB row tied calls together): closed by the zero-PII `agent_idempotency_trace` (trace_id / interaction_id / operation_attempt_id / bridge_type / tool_call_id / idempotency_key_hash / intent_hash prefix / purchase_intent_instance / draft_id / request_id / order_id / duplicate / duplicate_reason / duplicate_of / timings). Fail-open — a trace-write error never blocks the trade.
- **retry-vs-prior-intent classification** (was LIVE_HOST_REQUIRED): now a machine `duplicate_reason` distinguishes SAME_DRAFT_REPLAY / SAME_IDEMPOTENCY_KEY / ACTIVE_INTENT_REUSED / EXPLICIT_SECOND_PURCHASE / DATABASE_UNIQUE_RACE / RESPONSE_LOSS_RECONCILED.
- **Client key**: base had none; BUG-08 adds an optional `idempotency_key` as the primary retry key (same key+payload → same result; same key+different payload → IDEMPOTENCY_CONFLICT).

## Phase-3A final closure — trace now wired end-to-end
The designed trace is implemented and propagated: component (widget-minted trace_id/interaction_id/operation_attempt_id/widget_session_id + bridge_type) → tool handler (forwards) → submit route (records, fail-open, 128-cap) → agent_idempotency_trace (hashed key, intent prefix, machine codes). A retry correlates to its logical operation via interaction_id + key-hash; a second explicit purchase carries a new interaction, relatable to the original. Strict zero-PII verified (test-bug08-trace-propagation).
