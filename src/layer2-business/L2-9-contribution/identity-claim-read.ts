/**
 * PR-F4 — GitHub identity-claim READ surface (contribution attribution visibility). INTERNAL read-only.
 *
 * Lets a logged-in account see (a) its OWN current GitHub identity bindings and (b) the contribution
 * facts that are currently attributable to it via those bindings — the accountable READ-OVERLAY. This
 * does NOT change `contribution_facts.accountable_ref` (which stays NULL — facts are immutable; the
 * accountable party is resolved at read time from `identity_bindings_active`, per RFC-017 I-3 and the
 * 4a engine's `resolveAccountable`).
 *
 * Scope is the WHOLE security argument here: every query is anchored on `account_id = <the caller>`, so
 * a row for any OTHER account is never selected. No other account's id is returned; no token / email /
 * nonce / nonce_hash / gist content is read or returned. No reward / score / KYC — visibility only.
 *
 * A fact is "mine" iff it is an ACTIVE GitHub credential-BACKED fact (same trust root as the F2/F3b
 * precondition: contribution_facts ⋈ github_fact_credentials ⋈ github_contribution_credentials) AND its
 * `executor_ref` is `github:<actor>` for an `<actor>` CURRENTLY bound to me. The credential join means a
 * fact with a merely-matching generic `executor_ref` but no authenticated credential is NOT shown (the
 * #308 lesson), and the executor-match means a credential for my actor on a fact executed by someone else
 * is NOT shown either.
 *
 * Read path: the async seam (dbAll) — no transaction, backend-agnostic. spec: docs/IDENTITY-CLAIM-DESIGN.md §8.7.
 */
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface MyGithubBinding {
  github_actor_id: string
  visibility: 'private' | 'public'
  bound_at: string
}

export interface MyAttributableFact {
  fact_id: string
  source_event_key: string
  source: string
  type: string | null
  artifact_ref: string
  occurred_at: string | null
  executor_ref: string
  provenance: string
  status: string
  created_at: string
  github_actor_id: string   // the bound actor this fact is attributed THROUGH (always one of my bindings)
}

export interface MyGithubIdentitySurface {
  bindings: MyGithubBinding[]
  attributable_facts: MyAttributableFact[]
}

// SELECT only the caller's OWN active bindings — never another account's. account_id is NOT returned
// (the surface is the caller's own); visibility is shown to its OWNER only (this endpoint never serves
// another account), so a `private` binding is never disclosed to anyone else.
const BINDINGS_SQL = `
  SELECT github_actor_id, visibility, bound_at
  FROM identity_bindings_active
  WHERE account_id = ?
  ORDER BY bound_at DESC, github_actor_id`

// Accountable overlay, anchored on the caller's bindings: a fact is attributable to me iff it is an
// active GitHub credential-BACKED fact whose executor is an actor I currently hold a binding for. The
// b.account_id = ? anchor + identity_bindings_active's actor PK mean only MY facts can be returned.
const FACTS_SQL = `
  SELECT DISTINCT f.fact_id, f.source_event_key, f.source, f.type, f.artifact_ref, f.occurred_at,
         f.executor_ref, f.provenance, f.status, f.created_at, b.github_actor_id
  FROM identity_bindings_active b
  JOIN github_contribution_credentials c
    ON c.github_actor_id = b.github_actor_id
  JOIN github_fact_credentials l
    ON l.credential_id = c.credential_id AND l.source_event_key = c.source_event_key
  JOIN contribution_facts f
    ON f.fact_id = l.fact_id AND f.source_event_key = l.source_event_key
  WHERE b.account_id = ?
    AND f.source = 'github'
    AND f.status = 'active'
    AND f.executor_ref = 'github:' || b.github_actor_id
  ORDER BY f.created_at DESC, f.fact_id`

/** The caller's OWN GitHub identity bindings + the contribution facts currently attributable to them. */
export async function getMyGithubIdentitySurface(accountId: string): Promise<MyGithubIdentitySurface> {
  if (!accountId) return { bindings: [], attributable_facts: [] }   // defensive — route always passes the session user
  const [bindings, attributable_facts] = await Promise.all([
    dbAll<MyGithubBinding>(BINDINGS_SQL, [accountId]),
    dbAll<MyAttributableFact>(FACTS_SQL, [accountId]),
  ])
  return { bindings, attributable_facts }
}
