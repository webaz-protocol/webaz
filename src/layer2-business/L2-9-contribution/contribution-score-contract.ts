/**
 * PR5 — Contribution Score v1 CONTRACT (design/boundary only). NO scoring formula, NO engine.
 *
 * This module locks the *shape* and *boundary* of a future contribution score; it computes nothing,
 * reads nothing, writes nothing. Score v1 is a contribution-metering / build-layer signal — an
 * explainable summary of already-recorded contribution facts, for display + build-layer tiering only. It
 * is NOT a reward / valuation / economic right / redemption / payout / KYC gate / binary-tree position /
 * wallet / escrow / commission / DAO parameter (inherits the PR5A/5B/5C boundary).
 *
 * Naming rule (PR5A/5B/5C lesson): score fields use contribution / evidence / build / signal vocabulary —
 * NEVER reward / payout / claim / amount / currency / yield / price / promise. Headline = `contribution_score`,
 * never `reward_score`. Every displayed score is wrapped in the PR5A uncommitted-value boundary.
 *
 * spec: docs/CONTRIBUTION-SCORE-V1-DESIGN.md · RFC-017 I-12/§7 · docs/IDENTITY-CLAIM-DESIGN.md §8.8.
 */
import type { UncommittedValueBoundary } from './contribution-display-envelope.js'

// One evidence-backed component of a score. raw_count is the evidence measure (a count), NOT money.
// evidence_refs point at the already-recorded facts/credentials/overlay rows it summarizes (invariant 6).
export interface ScoreComponentV1 {
  key: string
  raw_count: number
  evidence_refs: string[]
}

// The score output shape. v1 fixes the contract; the actual numbers/weights are DEFERRED (invariant 4/7),
// so a future engine fills these — this module never computes them.
export interface ContributionScoreV1 {
  score_version: 'v1'
  contribution_score: number
  components: ScoreComponentV1[]
}

// A score is only ever exposed wrapped in the PR5A uncommitted-value boundary (invariant 8).
export type ContributionScoreV1Display = ContributionScoreV1 & { value_boundary: UncommittedValueBoundary }

// Frozen metadata the static guard asserts against — makes the boundary a CODE contract, not just prose.
export const CONTRIBUTION_SCORE_V1 = Object.freeze({
  score_version: 'v1',
  // user-facing field names of a displayed score (guard: none may be an economic-promise term)
  display_fields: ['score_version', 'contribution_score', 'components', 'value_boundary'] as const,
  // evidence component keys (weights/formula DEFERRED to governance — invariant 4/7)
  component_keys: ['accepted_contributions', 'reviews_provided', 'maintenance_actions', 'impact_observed', 'reverted_penalty'] as const,
  // READ-ONLY inputs — all pre-existing models; v1 adds NO table and NO write path (§3)
  input_sources: [
    'contribution_facts (RFC-017 fact layer)',
    'github_contribution_credentials + github_fact_credentials',
    'identity_bindings_active accountable overlay (/github/me, PR-F4)',
    'build_reputation read model (RFC-006, PR5B)',
  ] as const,
  // hard boundary flags (the whole point of this PR)
  display_requires_value_boundary: true,
  decides_money_or_rights: false,
  is_redeemable: false,
  defines_reward_formula: false,
  requires_or_unlocks_kyc: false,
  affects_wallet_escrow_commission: false,
  affects_binary_tree_position: false,
  gates_verifier_or_arbitrator: false,
  revisable_by_governance: true,
  // the 8 locked invariants (full text: docs/CONTRIBUTION-SCORE-V1-DESIGN.md §2)
  invariants: [
    'uncommitted only',
    'no economic rights',
    'no redemption',
    'no reward formula (deferred)',
    'no KYC / fulfillment',
    'explainable by evidence_refs',
    'revisable by governance',
    'every displayed score carries value_boundary',
  ] as const,
})
