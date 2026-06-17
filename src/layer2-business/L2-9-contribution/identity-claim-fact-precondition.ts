/**
 * PR-F3b — shared GitHub credential-backed fact precondition (extracted from the #308 claim engine,
 * behavior-zero) so both the claim engine (F2) and the challenge issuance engine (F3b) require the
 * SAME trust root: a claim/issuance is only valid for an ACTIVE, GitHub credential-BACKED contribution
 * fact whose AUTHENTICATED credential names this actor — never a fact with a merely-matching generic
 * `executor_ref` (lesson from #308).
 *
 * Sync, runs inside a caller-supplied transaction. Returns a coarse reason (fact_not_found /
 * actor_mismatch); each caller maps it to its own outcome type.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type FactPreconditionResult = { ok: true } | { ok: false; reason: 'fact_not_found' | 'actor_mismatch'; detail: string }

export function assertGithubCredentialBackedFact(db: any, sourceEventKey: string, githubActorId: string): FactPreconditionResult {
  const backed = db.prepare(`
    SELECT 1 AS ok
    FROM contribution_facts f
    JOIN github_fact_credentials l ON l.fact_id = f.fact_id AND l.source_event_key = f.source_event_key
    JOIN github_contribution_credentials c ON c.credential_id = l.credential_id AND c.source_event_key = l.source_event_key
    WHERE f.source_event_key = ? AND f.source = 'github' AND f.status = 'active'
      AND f.executor_ref = ? AND c.github_actor_id = ?
    LIMIT 1`).get(sourceEventKey, `github:${githubActorId}`, githubActorId) as { ok: number } | undefined
  if (backed) return { ok: true }
  // Not credential-backed. Distinguish actor_mismatch (a github fact exists but its generic executor
  // names another actor) from fact_not_found (everything else: no fact / not active / wrong source /
  // no link / credential names another actor).
  const f = db.prepare('SELECT executor_ref FROM contribution_facts WHERE source_event_key = ?')
    .get(sourceEventKey) as { executor_ref: string } | undefined
  if (!f) return { ok: false, reason: 'fact_not_found', detail: sourceEventKey }
  if (f.executor_ref !== `github:${githubActorId}`) return { ok: false, reason: 'actor_mismatch', detail: `fact executor ${f.executor_ref} != github:${githubActorId}` }
  return { ok: false, reason: 'fact_not_found', detail: 'no active GitHub credential-backed fact for this actor/source' }
}
