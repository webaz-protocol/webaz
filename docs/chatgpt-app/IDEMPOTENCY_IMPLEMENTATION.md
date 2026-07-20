# IDEMPOTENCY_IMPLEMENTATION — BUG-08 duplicate semantics + full trace (IMPLEMENTED — Phase 3A.2C)

> Duplicate-purchase semantics + explicit second-purchase + a zero-PII diagnostic trace. Money/state
> unchanged; additive migration; concurrency + money-invariant tests; independent adversarial pass
> (BUG08_ADVERSARIAL_REVIEW). Current mechanism was verified in Phase-2 IDEMPOTENCY_TRACE_AUDIT (durable
> `agent_permission_requests` + two partial UNIQUE indexes; `intent_hash` excludes `draft_id`; 24h TTL).

## Product-rule gate — RESOLVED (Phase 3A.2C spec §五): explicit "再买一份" IS allowed
The pre-BUG-08 rule **permanently blocked** a second identical purchase during the active window
(`intent_hash` reuse merged different drafts). The Phase 3A.2C spec settles the product decision:
a user's **explicit** "再买一份" MUST be able to create an independent purchase (rules 7 & 8), while all
implicit repeats (retry / double-click / prior pending) still dedup. No natural-language inference.

## Current → Target (what changed)
| aspect | BEFORE (base) | AFTER (BUG-08) |
|---|---|---|
| client key | none — dedup purely server-derived from `draft_id`+`intent_hash` | optional `idempotency_key` (`[A-Za-z0-9_-]{1,64}`) is the primary retry key |
| identity layers | one coarse `intent_hash` (economics, no draft_id) | THREE: `operation_attempt_id` (trace) · `idempotency_key` (retry) · `purchase_intent_instance` (independent purchase) |
| same-key replay | n/a | same key+payload → same result (`SAME_IDEMPOTENCY_KEY`); same key+diff payload → `IDEMPOTENCY_CONFLICT` (no execute, no overwrite) |
| intent merge | different drafts merged forever by economics | still dedups implicit repeats (`ACTIVE_INTENT_REUSED`, returnable), but an explicit `new_purchase_intent` folds the instance into `intent_hash` → distinct → independent submit (`EXPLICIT_SECOND_PURCHASE`) |
| duplicate signal | `duplicate:true` only | `duplicate` + machine `duplicate_reason` + `duplicate_of` + `existing_request_id` + `purchase_intent_instance` + `available_actions` (old clients still read the boolean) |
| trace | none (only the DB row) | zero-PII append-only `agent_idempotency_trace` (fail-open; never blocks the trade) |

## Three-layer identity (spec §三)
1. **operation_attempt_id** — one component operation attempt (a click and its retries share it). Trace only; never a dedup key.
2. **idempotency_key** — one *logical* operation's retry key. Same key ⇒ same result. A click + its retries carry the SAME key; "再买一份" mints a NEW key.
3. **purchase_intent_instance** — one *independent* purchase intent. Absent ⇒ current dedup. Present (only from the explicit "再买一份" action) ⇒ folded into `intent_hash` ⇒ a distinct economic identity ⇒ passes the intent UNIQUE index.

Never derived from display copy, product title, or natural language.

## Submit dedup precedence (spec §四) — `webaz_submit_order_request`
Checked in order; the first match returns (never a second row/order):
1. **`idempotency_key` present + a prior row with that key exists:**
   - same `params_hash` → return it. `duplicate_reason = SAME_IDEMPOTENCY_KEY` (or `RESPONSE_LOSS_RECONCILED` if the prior row is already terminal/executed — the client never saw the first response).
   - different `params_hash` → **`IDEMPOTENCY_CONFLICT`** (409): do not execute, do not overwrite.
2. **`ux_apr_order_submit_active(order_id)` collision** — same draft already has an active submit → reuse. `SAME_DRAFT_REPLAY`.
3. **`ux_apr_intent_active(human_id, intent_hash)` collision**, `new_purchase_intent` NOT set → reuse. `ACTIVE_INTENT_REUSED` + actions `[open_existing_approval, create_second_purchase, cancel_current_attempt]`.
4. **`new_purchase_intent` set** → `intent_hash` embeds the fresh `purchase_intent_instance` → no intent collision → independent submit. `EXPLICIT_SECOND_PURCHASE` (not a duplicate; a new request_id, still Passkey-gated).
5. **Concurrent UNIQUE race** — INSERT throws UNIQUE, `findActive*` returns the winner → return it. `DATABASE_UNIQUE_RACE` (DB error never surfaced to the user; no second row).
6. Every independent purchase still requires a fresh human **Passkey** approval (rule 9). The agent/widget cannot execute.

## "再买一份" flow (spec §五)
The explicit action mints a NEW `purchase_intent_instance` + NEW `idempotency_key`, requires a fresh
quote/draft (never a consumed or already-bound draft), and submits with `new_purchase_intent=true`.
The server re-validates price/stock/region/address at Passkey execution exactly as any first purchase —
expired quote → re-quote; stock=1 → the 2nd correctly fails; delisted/price-changed → fresh authoritative
result, never silent reuse (spec §五.8-11 are enforced by the existing execution re-validation, unchanged).

### Minimal mechanism
- Add nullable `purchase_intent_instance TEXT` to `agent_permission_requests` (+ the quote/draft chain). Fold it into `intent_hash` input so a distinct instance yields a distinct hash. Default NULL = current behavior (dedup). Only the explicit "再买一份" UI action mints a new instance.
- The submit response's `duplicate_warning.options` already lists the three choices; wire the "再买一份" option to a re-quote carrying a fresh `purchase_intent_instance`.

## Zero-PII duplicate trace (default-off, opt-in like the shadow limiter)
Append-only diagnostic row (new table `agent_idempotency_trace`, or a structured log), written only when the trace flag is on. Fields:
`trace_id, interaction_id, tool_call_id (JSON-RPC id), mcp_request_id, bridge_type, widget_session_id, idempotency_key_hash, intent_hash (prefix), purchase_intent_instance, draft_id, request_id, order_id, duplicate_reason, duplicate_of, handler_attempt, received_at (ISO Z), completed_at (ISO Z)`.

### `duplicate_reason` enum (returned machine-readably on any duplicate)
`SAME_DRAFT_REPLAY` · `SAME_IDEMPOTENCY_KEY` · `ACTIVE_INTENT_REUSED` · `EXPLICIT_SECOND_PURCHASE` · `DATABASE_UNIQUE_RACE` · `RESPONSE_LOSS_RECONCILED` · `UNKNOWN_RECONCILED`.

### Never logged
Full address, tokens, cookies, Passkey, payment credentials, raw chat/NL text. `idempotency_key_hash` and `intent_hash` are hashes; addresses only ever as `address_summary_hash`.

### Mapping current code → reasons (from Phase-2 trace)
- INSERT succeeds → not a duplicate.
- UNIQUE collision on `order_id` (draft) → `SAME_DRAFT_REPLAY`.
- UNIQUE collision on `(human_id,intent_hash)`, existing row alive → `ACTIVE_INTENT_REUSED`.
- collision then rival row terminated (`continue`/re-insert) → `DATABASE_UNIQUE_RACE`.
- client `idempotency_key` match (quote layer) → `SAME_IDEMPOTENCY_KEY`.
- retry after lost response reusing the same key/draft → `RESPONSE_LOSS_RECONCILED`.
- explicit new instance → `EXPLICIT_SECOND_PURCHASE`.

## Tests
concurrent submits (same draft, same intent, different drafts); rapid double-click; response loss then retry; HTTP retry; MCP retry; explicit "再买一份" → new order; each `duplicate_reason` path; trace never contains PII (field-name scan). Trace flag off → order execution unaffected (fail-open on trace write).

## Guards
Money-path: sync `db.transaction`, balance guards, no fake success; migration additive + fresh-boot verified; second-model adversarial review before merge; Passkey remains the human gate.
