# BUG08_ADVERSARIAL_REVIEW

> Independent read-only adversarial review of the BUG-08 change (duplicate-purchase / approval
> idempotency / explicit "再买一份" / zero-PII tracing), run by a fresh Claude session (single-model pass;
> Codex unavailable until 2026-07-25 — second-model pass recommended before merge). The review session
> did NOT modify code; findings were processed by the main session afterward and re-tested.
>
> Scope reviewed: `git diff a31f88e..HEAD` — commits `a205653` (audit), `b8e3569` (migration),
> `f520988` (submit semantics), `bf9d72d` (test), `409569a` (trace), `8f69530` (UI).

## Verdict: PASS — no BLOCKER, no HIGH. One MEDIUM (fixed) + two LOW (one fixed, one documented).

## Findings

### F1 — MEDIUM (client identity tokens unvalidated → zero-PII gap) — **FIXED**
`idempotency_key` / `purchase_intent_instance` / `operation_attempt_id` were accepted with a bare
`typeof === 'string'` check; the documented `[A-Za-z0-9_-]{1,64}` constraint was not enforced, so a
grant holder could store a multi-KB or free-form-text `purchase_intent_instance` — written **unhashed**
into the `agent_idempotency_trace` "zero-PII" table (the `idempotency_key` there was already SHA-truncated).
No double-order/correctness impact (it's the client's own data, still Passkey-gated), but it undercut the
zero-PII guarantee. **Fix:** the submit route now fail-closes any of the three tokens that don't match
`^[A-Za-z0-9_-]{1,64}$` with `400 IDENTITY_MALFORMED` (so `purchase_intent_instance` is provably an opaque
nonce), and `recordIdempotencyTrace` caps every string input to 128 chars as a backstop for the
MCP-level ids. `agent-grants.ts` + `idempotency-trace.ts`.

### F2 — LOW (trace correlation index was dead) — **FIXED**
`intent_hash` was never passed to `recordIdempotencyTrace`, so `intent_hash_prefix` was always NULL and
`idx_idemtrace_intent` couldn't correlate a retry to its intent. **Fix:** `createOrderSubmitRequest` now
returns `intent_hash` (a hash, zero-PII) on every result and the route threads it into the trace.

### F3 — LOW ("取消本次" is a client-only no-op) — **documented, no change**
A duplicate never created a second row, so there is nothing server-side to cancel; the button clears the
local action area and states "原有待审批购买不受影响" (which is exactly true). Harmless; kept as-is.

## Checks that passed cleanly (reviewer-confirmed)
1. **Double-charge / double-order** — one active submit row per draft (`ux_apr_order_submit_active`), per
   intent (`ux_apr_intent_active`), per key (`ux_apr_submit_idem`); one order per draft
   (`ux_orders_draft`) + the unchanged I5 CAS. `new_purchase_intent` on the SAME draft still collides on
   `order_id` → `SAME_DRAFT_REPLAY` (a 2nd purchase needs a NEW draft). No path creates a 2nd row/order.
2. **Independent-purchase folding / zero regression** — `orderSubmitIntentHash` inserts the instance only
   when truthy → `instance=null` is byte-identical to the pre-BUG-08 hash (implicit repeats dedup exactly
   as before); explicit `new_purchase_intent` folds a minted instance → distinct identity.
3. **Passkey bypass** — `createOrderSubmitRequest` never imports the executor and only ever inserts
   `status='pending'`, `executed_at NULL`; the widget "再买一份" button calls no tool. Execution stays
   human-Passkey-only.
4. **Concurrency** — every race loser hits a UNIQUE violation and re-resolves to the winner
   (`findByIdemKey`/`findActiveSubmit`) → returns the existing row; two-attempt bounded loop → 503 worst
   case. No window for a 2nd row.
5. **Key predictability/leak** — full key only in the dedup column (standard) + SHA-256[:16] in the
   trace; never console-logged; index/lookup are `(human_id, idempotency_key)` → no cross-human collision.
6. **Same key + different payload** — both the pre-check and the post-INSERT race branch return
   `IDEMPOTENCY_CONFLICT` 409 with no INSERT/UPDATE (no overwrite).
7. **intent_hash coarseness** — economics-only, excludes `draft_id` (intended); the ONLY escape is the
   explicit folded instance (no title/label leaks in).
8. **instance forgeable** — only ever relaxes dedup within the same `human_id`'s own intent, still
   Passkey-gated and re-validated at exec; can't touch another human's dedup.
9. **`ux_apr_submit_idem`** — partial `WHERE idempotency_key IS NOT NULL` (NULL/legacy rows unaffected);
   keyed across ALL statuses → response-loss recovery works; a legit 2nd purchase uses a NEW key.
10. **Response-loss** — `findByIdemKey` spans terminal/executed → `RESPONSE_LOSS_RECONCILED`, same
    request_id, no 2nd.
11. **Direct Pay vs Escrow** — `order-submit-exec.ts` / `orders-create.ts` / `direct-pay-create.ts` NOT
    in the diff; BUG-08 is rail-agnostic (pre-execution submit row only).
12. **Old-client compat** — no new args → identical hash + behavior; extra return fields ignored;
    `duplicate:true` boolean still set.
13. **Rollback** — purely additive (3 nullable `ADD COLUMN` + `CREATE UNIQUE INDEX IF NOT EXISTS` + new
    table); no backfill; reverting the code leaves them inert.
14. **Trace PII** — ids/hashes/machine codes only; key hashed; the never-written list honored (F1 closed
    the instance gap).
15. **Trace fail-open** — `recordIdempotencyTrace` is fully `try/catch → false`; the route ignores the
    return and is not in a transaction → a trace error cannot abort the trade.
16. **General scan** — INSERT arity balanced; `/idempotency_key/i` & `/UNIQUE/i` parsing robust; retry
    loop bounded; no null-deref.

## Limitation of this review
Single-model adversarial pass (Claude, this session). A second-model (Codex) pass is recommended when it
returns (2026-07-25) before this branch is merged — standard for money/idempotency/schema changes.

## Phase-3A final-closure addendum (new surface — self-reviewed, external re-review recommended)
The 4 closure items added new code: the 再买一份 DIRECT_TOOL chain (component), the trace wiring
(component→handler→route), and the exec/restart tests. Money-safety checks re-verified this pass:
- **No new execute path.** The chain calls only quote_order/order_draft/submit_order_request; the REAL order is still created exclusively by the human Passkey execution path (approveAndExecuteOrderSubmit), unchanged. The chain's submit carries new_purchase_intent → an independent PENDING request (Passkey-gated), never an execution.
- **No double-order via the chain.** A fresh quote→draft→submit that collides (implicit) still dedups; the explicit instance yields a distinct intent. Execution re-validation (now TESTED) hard-fails on price/stock/region/address drift with NO order + NO charge; duplicate Passkey → one order (test-bug08-execution-revalidation).
- **Trace can't affect the trade.** Trace ids are format-capped, observation-only, never used for authz/idempotency/tx; recording is fail-open (a write error never blocks the trade). Strict zero-PII re-verified (test-bug08-trace-propagation).
- **Client can't forge control via trace/instance.** purchase_intent_instance only relaxes dedup within the same human's own intent (still Passkey-gated + re-validated); trace fields are 128-capped and non-authoritative.
- **Single-model, no external re-review of the new surface yet.** A second-model (Codex, 2026-07-25) pass over the closure commits is recommended before merge, as for all money/idempotency changes.
