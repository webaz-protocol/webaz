# Admin / Agent Coordination Contribution — Design (Phase 1)

> **Status:** Phase 1 (minimal safe). **Augments:** RFC-017 (contribution protocol). **Non-goals:**
> reward formula · valuation · payout · redemption · wallet · token · eligibility scoring · ranking —
> none of these appear in this design and none are built here.

## Purpose

Let coordination work — done by a **non-root admin**, or by an **agent that a real contributor has
authorized** — be recorded as **one class of RFC-017 contribution evidence**, with **zero** economic
value, redemption right, or promise. It records *that work happened and who is accountable for it*; it
does **not** compute or imply any reward.

## The four-layer separation

1. **Actor** — *who executed the action*. A non-root admin account, an agent session, or a system
   batch. Recorded verbatim on the fact as `executor_ref` (`admin:<account_id>` / `agent:<ref>`).
2. **Contributor** — *who the work is attributed to*. Always a **real person's account**. In Phase 1
   this is a normal WebAZ `user id`; it may later be upgraded to a `contribution_identity`. The
   contributor is **resolved at read time** (see §"As-of attribution"), never frozen onto the fact.
3. **Evidence** — *what happened*. Immutable RFC-017 `contribution_facts` rows + an append-only link to
   the originating `admin_audit_log` row. This is the audit truth.
4. **Valuation / Redemption** — *future, not in scope*. Every fact stays `value_state = uncommitted`.
   No `reward_amount`, `payout`, `eligibility`, or `redeemable` field exists in this layer.

## Hard invariants

- **Single fact ledger.** Coordination facts are written into the **existing** RFC-017
  `contribution_facts` table. There is **no** second `coordination_contribution_facts` ledger.
- **Admin accounts are permission seats, not economic accounts.** A coordination fact's `executor_ref`
  may be `admin:<id>`, but attribution resolves to the **contributor** behind that seat via an operator
  claim — never to the admin account itself.
- **Agents are production tools; the contribution accrues to the authorizing, accountable human.** An
  agent action is attributable **only** if a valid `agent_execution_mandate` (mandate scope + cost
  bearer + accountable owner + result acceptance) was effective when the action occurred. No mandate →
  audit only, never a contribution candidate.
- **Founder bootstrap override is legal but must be explicit.** During bootstrap, root/founder may
  self-approve or override, but the claim event MUST record `approval_kind = 'founder_bootstrap_override'`
  (or `'root_approval'`) and `conflict_disclosure = 'self_or_related'`. It must **never** be dressed up
  as `'independent_governance'`.
- **Allowlist-only ingestion.** Only actions in the explicit `ADMIN_COORDINATION_ACTIONS` catalog are
  ingestible. Any unknown / unlisted action **fails closed** (audit only, no fact). Login, viewing,
  permission config, `root creates admin`, routine risk-control actions are **not** contributions.
- **`accountable_ref` is never written** on a coordination fact — it stays `NULL`; the accountable
  party is resolved at read time. This keeps a revoked/rotated claim from stranding the fact.
- **Sensitive admin detail is not leaked.** Admin detail lives in `admin_audit_log`; the coordination
  fact carries no admin detail, and the evidence link carries a `visibility`
  (`private` / `governance_only` / `public`, default `governance_only`) + a `redaction_summary`.

## As-of attribution

Attribution uses **as-of** semantics: the operator claim / agent mandate that was *effective when the
fact occurred* (`contribution_facts.occurred_at`) decides attribution.

- **Normal rotation does not rewrite history.** If a seat was attributed to contributor A from t0 and
  re-approved to B at t1, facts with `occurred_at` in [t0, t1) stay A's; facts at/after t1 are B's.
- **Fraud / theft / misattribution** are handled by **append-only** fact-level events
  (`status` → `void` / `forfeited`, or a future disqualification event), **never** by rewriting the
  fact or back-dating the claim. (Phase 1 ships the `status` enum already present on
  `contribution_facts`: `active|superseded|reverted|void|forfeited`.)

A read-time resolver maps `executor_ref` → contributor:
- `github:<id>` → existing identity binding (current binding).
- `admin:<id>` → as-of `admin_operator_claim_events` at the fact's `occurred_at`.
- `agent:<agent_ref>#<mandate_id>` → as-of the SPECIFIC mandate `(agent_ref, mandate_id)` at the fact's
  `occurred_at` → the mandate's `owner_contributor_account_id`. The mandate id is required and is encoded
  into the `executor_ref`, so attribution is deterministic at both ingest and read time even when one
  `agent_ref` holds several mandates (resolving by `agent_ref` alone would mis-credit "whichever mandate
  is latest").

A cached projection is permitted, but the **truth is the append-only claim / mandate / evidence event
log**.

## Components (Phase 1)

| Component | File |
|---|---|
| Centralized admin-audit context writer | `src/pwa/admin-audit.ts` |
| Schema: operator claims, agent mandates, fact-source link, action catalog | `src/layer2-business/L2-9-contribution/admin-coordination-store.ts` |
| Read-time as-of resolver | `src/layer2-business/L2-9-contribution/admin-coordination-resolver.ts` |
| Allowlisted ingestion (single-row + bounded batch) → `contribution_facts` | `src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.ts` |
| Operator entry (manual, dry-run by default) | `scripts/ingest-admin-coordination.ts` (`npm run ingest:admin-coordination`) |

## First production pipeline (allowlist wiring + operator entry)

Phase 1 shipped the engine/resolver/store but the allowlist held only abstract *concept* names that no
route emits, so nothing was ingestible in practice. This step wires the **real audited action strings**
and adds a small, manual operator entry. It remains **evidence ingestion only — reward is deferred; no
amount, payout, eligibility, aggregation, or UI is added.**

- **Allowlist + live set.** The `operator_claim.*` actions logged by the operator-claim workflow routes
  are in `ADMIN_COORDINATION_ACTIONS`, each mapped to RFC-017 `(governance, governance)`:
  `operator_claim.propose · confirm · approve · reject · revoke · unlink_request · unlink_approve ·
  unlink_reject`. The bounded batch / operator CLI selects **only** from
  `LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS` — exactly those 8 strings. The pre-existing concept names
  (`task_review`, `proposal_review`, …) remain ingestible by the **single-row** engine (an operator can
  target a specific `auditId`) but are **explicitly excluded from batch live selection**, so the first
  pipeline never scans or auto-ingests anything but real operator-claim work. A concept name joins the
  live set only when a real route begins emitting it as a stable action string. (A module-load invariant
  asserts every live action has an allowlist spec.)
- **Fail-closed, unchanged.** Any non-listed action → `unknown_action` (no fact). An action with **no
  active operator claim as-of the audit row's `created_at`** → `no_attribution` (no fact). A claim
  created *after* the action is **not** retro-credited; a **revoked** claim stops attribution for later
  actions. Attribution still resolves at read time (`accountable_ref` stays NULL).
- **Operator entry (manual, bounded, dry-run by default).**
  `ingestAdminCoordinationSince(db, { sinceTime?, sinceId?, limit?, commit? })` selects allowlisted
  audit rows and runs each through the same single-row engine; CLI: `npm run ingest:admin-coordination`
  (or `node --import tsx scripts/ingest-admin-coordination.ts`). **Default is dry-run (writes nothing)**;
  `--commit` writes; `--limit` (default 50, max 500) and `--since-time` / `--since-id` scope the run.
  Re-runs are idempotent (one fact per audit row, keyed on `source_event_key`). **A `--commit` MUST be
  cursor-bounded** (`--since-time` or `--since-id`) — a no-cursor commit throws `commit_requires_cursor`
  rather than writing from the earliest row (that would be a backfill). A no-cursor *dry-run* is allowed
  for preview. A typo'd `--since-id` throws `invalid_cursor` (never a from-earliest scan). `--commit`
  takes no value (or `=true`); `--commit=false` and the like are rejected.
- **No historical backfill.** This step does **not** backfill the old ~423 facts / public PRs / legacy
  admin actions, and the operator entry never scans all of history unbounded — it is cursor + limit
  scoped and starts from the present. Any historical backfill is a separate, explicitly-approved step.

## Governance-marking correction (append-only overlay)

A self/related approval (the approver is itself a party — `approved_by ∈ {admin_account_id,
contributor_account_id}`, i.e. a root/founder bootstrap) MUST disclose `self_or_related` + a
non-`independent_governance` kind. When such an approval was recorded dishonestly (e.g.
`independent_governance` / `none`), it is **not** fixed by UPDATE or by revoke+re-approve — revoking and
re-approving would push the effective time to *now* and break the as-of attribution of the original
historical acts. Instead a **root** appends a correction:

- `admin_operator_claim_marking_corrections` (append-only; BEFORE UPDATE/DELETE → ABORT) references the
  approved event id and records `approval_kind` (`root_approval` | `founder_bootstrap_override`),
  `conflict_disclosure` (`self_or_related`), a required `correction_reason`, `corrected_by_root_admin_id`,
  `corrected_at`. DB CHECKs make a dishonest correction (e.g. `independent_governance`) unstorable.
- The **resolver** overlays the latest correction's marking at read time — it never changes the
  contributor or the effective interval, so as-of attribution is preserved.
- **Ingestion fails closed** on a self/related-but-not-honestly-disclosed claim
  (`self_related_not_disclosed`) — such evidence cannot enter `contribution_facts` until a correction
  discloses it. After correction, the original-time acts ingest normally.
- Engine: `correctClaimMarking()` (root-only) · operator CLI: `scripts/correct-operator-claim-marking.ts`
  (`npm run correct:operator-claim-marking`, dry-run by default). Genuinely independent claims
  (`approved_by` not a party) are unaffected.

## Deferred (explicitly NOT in Phase 1)

- No reward / valuation / payout / redemption / eligibility scoring.
- No `contribution_identity` subject (contributor = WebAZ user id for now; seam left open).
- No HTTP/MCP read or write surface, no UI, no automatic trigger — ingestion is an internal/operator
  engine call.
- No migration of the existing ~11 `INSERT INTO admin_audit_log` call sites onto `logAdminAction`
  (helper added; call-site migration is a later, additive step).
- No `build_reputation` wiring to anything economic.
