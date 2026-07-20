# IDEMPOTENCY_IMPLEMENTATION — BUG-08 duplicate semantics + full trace (DESIGN — NOT YET IMPLEMENTED)

> Target duplicate-purchase semantics + a zero-PII diagnostic trace. Money/state change → its own commit, backward-compatible, second-model adversarial pass + concurrency tests before merge. Current mechanism verified in Phase-2 IDEMPOTENCY_TRACE_AUDIT (durable `agent_permission_requests` + two partial UNIQUE indexes; `intent_hash` excludes `draft_id`; 24h TTL).

## Product-rule gate (MUST confirm before changing trade semantics)
The current rule **blocks a second identical purchase during the active window** (intent_hash reuse). This is a **product decision**. Two paths:
- **If the rule is intentional** (no second identical buy while one is pending): do NOT change it. Keep it; still add `duplicate_reason` + the trace + the UI options below.
- **If "buy another" should be allowed:** implement the minimal compatible design below.
Do NOT self-select the trade-affecting option — surface both to the project owner (this doc is the artifact).

## Target semantics (if "buy another" is allowed)
1. Same `draft` resubmitted → reuse the same approval (`SAME_DRAFT_REPLAY`).
2. Same `idempotency_key` → reuse the same result (`SAME_IDEMPOTENCY_KEY`).
3. Rapid double-click / network / MCP retry → no second purchase (onceGuard + server dedup).
4. User explicitly chooses "再买一份" → a NEW independent purchase via an explicit server field `purchase_intent_instance` (a nonce the human's action introduces), which varies the intent → passes the UNIQUE index.
5. Two different drafts with identical economics → NOT permanently merged solely by content; distinguished when a `purchase_intent_instance` is present.
6. The second purchase is expressed by an explicit server field, never inferred from natural language.
7. UI must offer three distinct actions: **打开已有审批** · **取消本次** · **再买一份**.
8. "再买一份" still requires a fresh human Passkey approval.

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
