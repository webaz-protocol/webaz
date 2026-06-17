# Contribution Score v1 — design & safety boundary (PR5 design-only)

> **Status:** design + field contract only. This document and its companion type contract
> (`src/layer2-business/L2-9-contribution/contribution-score-contract.ts`) lock the **boundary** of a
> future contribution score. They define **no scoring formula, no weights, no curve, no numbers** — those
> are deferred (invariant 7). Authority for the value boundary: **RFC-017 I-12 / §7**; display contract:
> **PR5A** (`contribution-display-envelope.ts`, docs/IDENTITY-CLAIM-DESIGN.md §8.8).

## §1 What Contribution Score v1 is — and is NOT

Contribution Score v1 is a **contribution-metering / build-layer** signal: an *explainable summary of
already-recorded contribution facts*, for **display and build-layer tiering only**. It is the "score" half
of the `record → claim → score` loop (the record/claim halves landed in the 4b chain + PR-F4).

It is **NOT** a reward, valuation, equity/economic right, redemption, payout, KYC gate, binary-tree
position, seller/buyer referral reward, DAO parameter, wallet/escrow/commission input, or trade-side
admission (verifier/arbitrator). It inherits every boundary established by PR5A/5B/5C: the act of
*measuring and showing* contribution must never read as a promise of return.

> Naming rule (from PR5A/5B/5C): score fields use **contribution / evidence / build / signal**
> vocabulary — never `reward`, `payout`, `claim`, `amount`, `currency`, `yield`, `price`, or `promise`.
> The headline field is `contribution_score`, **never** `reward_score`. A Passkey expresses an
> **accountability anchor**, never a reward anchor.

## §2 Invariants (locked)

1. **Uncommitted only.** A score carries no committed economic value (RFC-017 I-12).
2. **No economic rights.** A score grants no security / equity / debt / redemption right.
3. **No redemption.** A score is not redeemable and implies no payout, amount, currency, or yield.
4. **No reward formula.** v1 defines the *contract*, not weights/curves/numbers (those are deferred).
5. **No KYC / fulfillment.** A score neither requires nor unlocks KYC, fulfillment, or any gated action.
6. **Explainable by evidence.** Every score component is backed by `evidence_refs` pointing at the
   already-recorded facts/credentials/overlay it summarizes — no opaque number.
7. **Revisable by governance.** Weights, components, and whether a score is ever defined at all are
   future DAO + professional-team decisions; v1 locks only the boundary, never the math.
8. **Boundary on every display.** Every displayed score MUST be wrapped in the PR5A
   `value_boundary` (`value_state:'uncommitted'`, valuation/redemption `not_defined`,
   `economic_rights:false`).

## §3 Inputs — read-only, from existing models (no new table)

A score is **derived at read time** from models that already exist; v1 adds **no DB table** and **no
write path**:

- **`contribution_facts`** — the RFC-017 fact layer (the authoritative, immutable record).
- **`github_contribution_credentials` ⋈ `github_fact_credentials`** — the authenticated GitHub credential
  backing each fact (same trust root as F2/F3b).
- **identity-claim accountable overlay** — `identity_bindings_active` (the `/api/contribution-identity/
  github/me` read overlay, PR-F4): which active facts are attributable to the caller.
- **`build_reputation`** read model (RFC-006, PR5B): the build/coordination-layer pool (independent of
  trade reputation; never gates verifier/arbitrator).

`accountable_ref` on facts stays NULL — attribution is the read-time overlay, never a fact mutation.

## §4 Output field contract (shape only; values deferred)

`ContributionScoreV1` (see the type contract module): `{ score_version: 'v1', contribution_score: number,
components: ScoreComponentV1[] }`, where each `ScoreComponentV1 = { key, raw_count, evidence_refs[] }`.
Canonical evidence component keys (v1 set; weights deferred): `accepted_contributions`,
`reviews_provided`, `maintenance_actions`, `impact_observed`, `reverted_penalty`. None of these — and no
display field — uses an economic-promise term.

When displayed, a score is returned as
`ContributionScoreV1Display = ContributionScoreV1 & { value_boundary }` via the PR5A
`withUncommittedValueBoundary` wrapper (invariant 8).

> A `reward_eligibility`-style field is **intentionally omitted** from v1: eligibility for any economic
> return belongs to the redemption layer, which RFC-017 keeps `uncommitted` in full. Recording a
> contribution score must not imply eligibility for a payout.

## §5 What this PR does / does not change

- **Adds:** this doc + a pure **type/contract** module (interfaces + a frozen metadata constant) + a
  static guard test; and (PR5E, §6) a **read-only evidence collector** that computes no score. No scoring
  **formula** engine, no API, no UI, no DB table, no migration, no write path.
- **Unchanged:** `build_points` formula; identity-claim / credential-ingestion / binding state machines;
  every API write path; funds / orders / wallet / escrow / commission; KYC / admin permissions; CI shape.

The full scoring engine (computing `contribution_score` + applying any weight from the components) is a
**later** implementation PR, gated on this boundary being locked and on governance defining any weights.

## §6 Read-only evidence collector (PR5E)

`contribution-score-evidence.ts` `collectContributionScoreEvidence(accountId)` aggregates **component
evidence only** — it returns the five `ScoreComponentV1` `{ key, raw_count, evidence_refs[] }` and
**never** a `contribution_score`, total, weight, tier, or eligibility (those stay deferred). Read-only:
no DB write, no new table; attribution is the read overlay (`accountable_ref` stays NULL). Source mapping
(existing models only, §3):

| component | source (all attributable to the account via the active credential-backed `/github/me` overlay) |
|---|---|
| `accepted_contributions` | active attributable facts (all types) |
| `reviews_provided` | active attributable facts, `type='audit'` |
| `maintenance_actions` | active attributable facts, `type='maintenance'` |
| `impact_observed` | **no evidence source in v1 models → `0` / `[]`** (not fabricated; a future PR wires a real source) |
| `reverted_penalty` | **no source yet → `0` / `[]`** — see the append-only note below |

> **`reverted_penalty` is deliberately NOT sourced from `contribution_facts.status='reverted'.`** Lifecycle
> status changes (revert / supersede / void) belong to a **future append-only status-events overlay**;
> `contribution_facts.status` is **as-ingested `active` and never updated in place**
> (`GITHUB-CREDENTIAL-INGESTION-DESIGN.md`, `github-credential-ingestion-engine.ts`). Reading
> `status='reverted'` here would both stay perpetually `0` under the current ingestion **and** tempt future
> code into an in-place status mutation that violates append-only. `reverted_penalty` is wired to the real
> status-events overlay only once that overlay PR lands.

`evidence_refs` are real `contribution_facts.fact_id` values (invariant 6). Only the account's own facts
are counted (anchor `identity_bindings_active.account_id = accountId`); unbound-actor facts, other
accounts' facts, and non-`active` facts are excluded. The buckets are **evidence counts, not a score** — a
`raw_count` of 0 is an honest "0 records found" (or "no source wired yet" for `impact_observed` /
`reverted_penalty`), never a scored 0. Proven by `scripts/test-contribution-score-evidence.ts`.

## §7 Evidence read surface (PR5F)

`routes/contribution-score.ts` exposes the §6 collector as a logged-in **self-view** — still **not** a
score engine:

`GET /api/contribution-score/evidence/me` → `withUncommittedValueBoundary({ evidence_version: 'v1',
components })`, where `components = collectContributionScoreEvidence(session user id)`.

- **Read-only, self-only**: `accountId` is ALWAYS the session user — the route reads **no** `req.query` /
  `req.body`, so `?account_id=…&github_actor_id=…` is ignored and a caller cannot ask about another
  account. The route holds **no `db` handle** and writes no core table (it only calls the layer2 collector).
- **No score**: returns component evidence only — never `contribution_score` / total / weight / tier /
  eligibility, no formula/ranking. Every response is wrapped in the PR5A `value_boundary` (invariant 8).
- **No leak**: no other account's id, token, nonce, nonce_hash, email, or gist content.

No new DB table / schema / write path, no UI, no MCP tool (MCP parity, if wanted, is a separate later PR).
Proven by `scripts/test-contribution-score-read.ts`.
