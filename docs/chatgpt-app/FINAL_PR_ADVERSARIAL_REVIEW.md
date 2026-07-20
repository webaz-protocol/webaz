# FINAL_PR_ADVERSARIAL_REVIEW — PR #471 (fix/chatgpt-card-contract-phase3 → main)

> Independent second-model READ-ONLY review of the full Phase-3A PR diff (`git diff main...HEAD`, 39
> commits: BUG-01 full terms · Model-When-Necessary DIRECT_TOOL · BUG-04 URI versioning · BUG-07 UTC ·
> BUG-02 ETA snapshot · BUG-06 Schema v2 + quantity safety · BUG-08 idempotency + 再买一份 + zero-PII
> trace). The reviewer verified from source, did NOT trust the implementation session's conclusions, and
> did NOT modify code. Single-model pass (Codex unavailable until 2026-07-25 — a third-party pass is
> still recommended before production).

## Verdict: no BLOCKER, no HIGH. Nothing can cause a double-charge, double-order, PII leak, or authz
## bypass. Safe to proceed to staging after the MEDIUM is fixed.

## MEDIUM

### M1 — new BUG-01/02/04/07 test scripts not wired into CI/package.json — **FIXED**
`test-delivery-eta`, `test-eta-migration`, `test-eta-snapshot-flow`, `test-mcp-card-contract`,
`test-mcp-direct-tool-buttons`, `test-mcp-manifest-version`, `test-mcp-uri-versioning` were committed and
pass locally but were not run steps in `.github/workflows/ci.yml`, so a future regression in ETA
snapshotting / URI versioning / card-contract compatibility could ship green (the "新 test:* 必手动接
ci.yml" lesson). **Fix:** wired all of them into `package.json` scripts + `ci.yml`. Not a runtime bug.

## LOW (fixed — was a false-green)

### L1 — `RESPONSE_LOSS_RECONCILED` after execution was unreachable in prod; its test asserted an
### impossible state — **FIXED**
In `order-submit-request.ts` the draft-status/expiry guard (`DRAFT_NOT_AVAILABLE` if status != 'draft')
ran **before** the `idempotency_key` replay branch. In production an executed submit moves its draft to
`ordered` (`order-submit-exec.ts`), so a same-key retry after execution returned `409
DRAFT_NOT_AVAILABLE` instead of the idempotent `RESPONSE_LOSS_RECONCILED` echo; the test "passed" only
by leaving the draft in `draft` while setting `executed_at` — a state the real executor never produces.
**Money-safety was never at risk** (double-order is independently prevented by `ux_orders_draft` +
`orderSubmitParamsHash` including `draft_id` → a post-execution same-key re-quote yields
`IDEMPOTENCY_CONFLICT`, not a second order). **Fix:** the `idempotency_key` pre-check now runs FIRST
(before the draft guard), so a lost-response retry after execution returns the original request +
`RESPONSE_LOSS_RECONCILED` regardless of the draft's current status; the test was corrected to the
reachable production state (draft moved to `ordered`).

## CONFIRMED-SAFE (reviewer spot-checked)
- **A. Money/orders** — ETA (BUG-02) is purely additive (`promised_eta_snapshot TEXT`); never read into
  any total / payable / escrow / status. Execution re-validation still hard-fails on any economic+identity
  drift (incl. seller_id, dest_region) + `draft→ordering` CAS + `ux_orders_draft`. Duplicate Passkey → one
  order (I5 CAS). Money math otherwise unchanged (only the additive column + the region-normalization fix).
- **B. DB/migration** — all new columns are additive nullable `ADD COLUMN` after CREATE (try/catch, no
  backfill); partial unique indexes (`ux_apr_submit_idem` / `ux_apr_intent_active` /
  `ux_apr_order_submit_active`) correct with proper NULL exclusion; fail-closed boot check; PG parity
  confirmed (`db/schema.pg.sql` has the columns/table/indexes); trace write fail-open, never blocks the trade.
- **C. Cards/schema** — v1+v2 both render; status via canonical `stCode` (never from label); unknown
  status → honest `label=code`; invalid quantity → `quantity_valid:false` + 数量数据异常 + disabled
  buttons; old bare-URI cards resolve via the alias map; `promised_eta` preserved + separate from logistics.
- **D. Idempotency** — three layers with correct conflict handling (same key + different payload →
  `IDEMPOTENCY_CONFLICT`, no execute/overwrite); cross-user collision impossible (human_id-scoped); the
  ONLY intent escape is the explicit `purchase_intent_instance` (never NL-inferred); single-flight guards
  rapid double-click.
- **E. Security/privacy** — trace stores only hashes + machine codes; the three identity tokens validated
  `^[A-Za-z0-9_-]{1,64}$` at the route; other trace fields diagnostic-only + 128-capped, cannot alter
  authz/idempotency/tx; `visibility:['model','app']` additive; widget-accessible tools stay OAuth-scope
  gated; component-initiated writes still require human Passkey.
- **F. Model usage** — deterministic buttons are DIRECT_TOOL `callTool` with structured args; NL fallback
  only when the host lacks `callTool`, fails visibly; no silent degradation.

## CANNOT-CONFIRM-IN-CODE (needs live host / staging — Phase 3B)
- Whether ChatGPT/Claude round-trips the card-tool result back to the calling component so the 再买一份
  chain's `consume(r)` receives `structuredContent` (on hosts that surface card tools only via
  `ui/notifications/tool-result`, the chain fails visibly at step 1 — acceptable, but the happy path is
  host-dependent).
- Real double-render / promise-return behavior of card `callTool` in a live host.
- Actual live `tools/list` payload size (guarded by the wired `test:mcp-definition-budget` ratchet).

## Disposition
M1 fixed (CI wiring). L1 fixed (pre-check reorder + corrected test). No BLOCKER/HIGH. The three
CANNOT-CONFIRM items are the Phase-3B live-host verification list (KNOWN_LIMITATIONS). Ready for staging
after the fix regression is green.
