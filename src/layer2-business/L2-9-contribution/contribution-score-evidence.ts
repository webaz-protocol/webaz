/**
 * PR5E — Contribution Score v1 read-only EVIDENCE COLLECTOR. Aggregates component-level evidence ONLY;
 * computes NO score: no `contribution_score`, no total, no weights / formula / curve / tier / reward /
 * eligibility (all deferred — RFC-017 + the #318 contract). Read-only: no DB write, no new table, no
 * schema change; attribution is the read overlay, so `contribution_facts.accountable_ref` stays NULL.
 * Any future display of this evidence inherits the PR5A uncommitted-value boundary.
 *
 * For a logged-in account it returns one ScoreComponentV1 ({ key, raw_count, evidence_refs[] }) per fixed
 * contract component key (#318), sourced ONLY from existing models:
 *   - accepted_contributions: ACTIVE GitHub credential-BACKED facts attributable to the account — the
 *     /github/me overlay trust root (contribution_facts ⋈ github_fact_credentials ⋈
 *     github_contribution_credentials, executor = a currently-bound actor).
 *   - reviews_provided / maintenance_actions: the active attributable facts of type 'audit' / 'maintenance'.
 *   - impact_observed: NO impact-observation source exists in the current models → 0 / [] (NOT fabricated
 *     to look complete; a future PR wires a real source).
 *   - reverted_penalty: NO source yet → 0 / []. Lifecycle status changes (revert/supersede/void) belong to
 *     a FUTURE append-only status-events overlay; `contribution_facts.status` is as-ingested 'active' and
 *     is NEVER updated in place (GITHUB-CREDENTIAL-INGESTION-DESIGN.md; github-credential-ingestion-engine.ts).
 *     So we deliberately do NOT read `status='reverted'` here — that would both stay perpetually 0 under the
 *     current ingestion AND tempt future code into an in-place status mutation that violates append-only.
 *     reverted_penalty is wired to the real status-events overlay only once that overlay PR lands.
 * `evidence_refs` are real `contribution_facts.fact_id` values (invariant 6 — explainable by evidence).
 *
 * spec: docs/CONTRIBUTION-SCORE-V1-DESIGN.md · contribution-score-contract.ts · docs/IDENTITY-CLAIM-DESIGN.md §8.7.
 */
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'
import type { ScoreComponentV1 } from './contribution-score-contract.js'

// Active attributable facts: the SAME credential-backed + executor-bound-to-me overlay as /github/me
// (PR-F4), anchored on b.account_id = the caller, so only the account's own facts are seen. status='active'
// is the as-ingested value (never updated in place); a future status-events overlay will derive lifecycle.
const ATTRIBUTABLE_ACTIVE_FACTS_SQL = `
  SELECT DISTINCT f.fact_id, f.type
  FROM identity_bindings_active b
  JOIN github_contribution_credentials c
    ON c.github_actor_id = b.github_actor_id
  JOIN github_fact_credentials l
    ON l.credential_id = c.credential_id AND l.source_event_key = c.source_event_key
  JOIN contribution_facts f
    ON f.fact_id = l.fact_id AND f.source_event_key = l.source_event_key
  WHERE b.account_id = ? AND f.source = 'github' AND f.status = 'active'
    AND f.executor_ref = 'github:' || b.github_actor_id
  ORDER BY f.fact_id`

const component = (key: string, refs: string[]): ScoreComponentV1 => ({ key, raw_count: refs.length, evidence_refs: refs })

interface FactRow { fact_id: string; type: string | null }

/**
 * Collect the five fixed-contract evidence components for `accountId`. Returns counts + evidence_refs
 * only — never a `contribution_score`. Order matches CONTRIBUTION_SCORE_V1.component_keys (#318).
 */
export async function collectContributionScoreEvidence(accountId: string): Promise<ScoreComponentV1[]> {
  if (!accountId) {
    return ['accepted_contributions', 'reviews_provided', 'maintenance_actions', 'impact_observed', 'reverted_penalty']
      .map(k => component(k, []))
  }
  const active = await dbAll<FactRow>(ATTRIBUTABLE_ACTIVE_FACTS_SQL, [accountId])
  const ofType = (rows: FactRow[], t: string): string[] => rows.filter(r => r.type === t).map(r => r.fact_id)

  return [
    component('accepted_contributions', active.map(r => r.fact_id)),
    component('reviews_provided', ofType(active, 'audit')),
    component('maintenance_actions', ofType(active, 'maintenance')),
    component('impact_observed', []),                        // no evidence source in v1 models (not fabricated)
    component('reverted_penalty', []),                       // no status-events overlay source yet — NOT read from fact.status (append-only)
  ]
}
