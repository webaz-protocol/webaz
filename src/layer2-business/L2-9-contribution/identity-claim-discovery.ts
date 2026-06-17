/**
 * F10 — claimable GitHub contribution DISCOVERY (read-only). Lets a logged-in account see which
 * credential-backed GitHub contribution facts are currently CLAIMABLE — i.e. their GitHub actor is not
 * yet bound by ANY account — so the F9 claim UI no longer depends on a maintainer hand-delivering
 * `source_event_key` / `github_actor_id` (dogfood R3 finding F10, proposal tp_ce110fed).
 *
 * Trust / safety boundaries (mirrors identity-claim-read.ts, PR-F4):
 *   - READ-ONLY: this module issues SELECT only — it never writes identity_bindings_active /
 *     identity_binding_events / contribution_facts / github_fact_credentials /
 *     identity_claim_challenges, never issues a challenge, never touches accountable_ref.
 *   - Same credential-backed trust root as F2/F3b/F4: a fact is surfaced only when it is
 *     `source='github'` + `status='active'` + linked to a credential whose actor matches the fact's
 *     `executor_ref` ('github:' || actor) — a forged executor_ref without a credential never appears.
 *   - CLAIMABLE = the actor has NO active binding (LEFT JOIN … IS NULL): an actor bound by another
 *     account is excluded (it is theirs), and an actor bound by the CALLER is also excluded here —
 *     those facts already appear in /github/me's attributable_facts (the F4 surface).
 *   - No secret in the output: no account_id, credential_id, core_json/digest, token, nonce,
 *     nonce_hash, proof material. Only minimal display fields + what the claim form needs
 *     (source_event_key + github_actor_id — both already disclosed-by-design at claim-challenge).
 *   - `accountId` is accepted for interface parity with the other read engines (the route always passes
 *     the SESSION user) and reserved for future per-account filtering; discovery output is currently
 *     account-independent by construction (unbound actors only).
 *
 * Visibility posture: same as claim-challenge (#311, by design) — an unclaimed, credential-backed
 * contribution is discoverable and claimable; that is the point of the GitHub-first promise.
 * No reward / score / valuation anywhere; the route wraps the response in the uncommitted-value boundary.
 */
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 async read seam

export interface ClaimableGithubFact {
  fact_id: string
  source_event_key: string
  source: string
  type: string | null
  artifact_ref: string
  occurred_at: string | null
  created_at: string
  github_actor_id: string
  repository_id: string
  pr_number: number
  merge_commit_sha: string
  merged_at: string
  lifecycle_event: string
}

export interface ClaimableGithubFactsSurface {
  claimable_facts: ClaimableGithubFact[]
}

// Active, credential-backed, executor-matching GitHub facts whose actor is NOT bound by any account.
// DISTINCT collapses credential-version upgrade chains (multiple credentials → the same fact carry the
// same PR identity fields). Newest merged work first; bounded.
const CLAIMABLE_SQL = `
  SELECT DISTINCT f.fact_id, f.source_event_key, f.source, f.type, f.artifact_ref, f.occurred_at,
         f.created_at, c.github_actor_id, c.repository_id, c.pr_number, c.merge_commit_sha,
         c.merged_at, c.lifecycle_event
  FROM contribution_facts f
  JOIN github_fact_credentials l
    ON l.fact_id = f.fact_id AND l.source_event_key = f.source_event_key
  JOIN github_contribution_credentials c
    ON c.credential_id = l.credential_id AND c.source_event_key = l.source_event_key
  LEFT JOIN identity_bindings_active b
    ON b.github_actor_id = c.github_actor_id
  WHERE f.source = 'github'
    AND f.status = 'active'
    AND f.executor_ref = 'github:' || c.github_actor_id
    AND b.github_actor_id IS NULL
  ORDER BY COALESCE(c.merged_at, f.created_at) DESC, f.fact_id
  LIMIT 50`

/** List the currently claimable (unbound-actor) credential-backed GitHub facts. Read-only. */
export async function listClaimableGithubIdentityFacts(accountId: string): Promise<ClaimableGithubFactsSurface> {
  if (!accountId || typeof accountId !== 'string') return { claimable_facts: [] }
  const rows = await dbAll<ClaimableGithubFact>(CLAIMABLE_SQL, [])
  return { claimable_facts: rows }
}
