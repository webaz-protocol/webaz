/**
 * Admin / Agent coordination — read-time accountable resolver (Phase 1).
 * Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md.
 *
 * Maps a contribution_fact's `executor_ref` to the real CONTRIBUTOR, AS OF the fact's `occurred_at`.
 * The contributor is NEVER frozen onto the fact (accountable_ref stays NULL) — it is resolved here from
 * the append-only claim / mandate event logs, so a later rotation/revocation does not strand the fact.
 *
 * Sync (better-sqlite3 handle) by design: this is an internal/operator-side resolver, not a hot request
 * path, and staying sync avoids the await-gap class of bugs in attribution logic. A future async/HTTP
 * read surface can wrap these.
 *
 * As-of rule: the claim/mandate whose effective window covers `asOf` decides attribution. Normal
 * rotation does not rewrite history; fraud/void is handled append-only on the fact (status), not here.
 */
import type Database from 'better-sqlite3'

export interface OperatorClaimResolution {
  contributor_account_id: string
  approval_kind: string | null
  conflict_disclosure: string
  claim_event_id: string
}
export interface MandateResolution {
  owner_contributor_account_id: string
  mandate_id: string
  allowed_actions: string[]
  grant_event_id: string
}
export interface CoordinationResolution {
  contributor_account_id: string
  via: 'github_binding' | 'operator_claim' | 'agent_mandate'
  detail: Record<string, unknown>
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** As-of resolution of which contributor a non-root admin SEAT was attributed to at `asOf`. */
export function resolveOperatorClaimAsOf(db: Database.Database, adminAccountId: string, asOf: string): OperatorClaimResolution | null {
  const events = db.prepare(
    `SELECT event_type, contributor_account_id, approval_kind, conflict_disclosure, event_id, effective_from, supersedes_event_id, created_at
     FROM admin_operator_claim_events WHERE admin_account_id = ? ORDER BY effective_from ASC, created_at ASC, rowid ASC`,
  ).all(adminAccountId) as any[]
  // An approval is terminated as-of `asOf` iff a revoked/superseded event that is EFFECTIVE by then
  // LINKS to it (supersedes_event_id). Link-based (not a timestamp window) so a same-second
  // approve→revoke and a same-instant rotation both resolve deterministically.
  const terminatedIds = new Set(events
    .filter(e => (e.event_type === 'revoked' || e.event_type === 'superseded') && e.effective_from && e.effective_from <= asOf && e.supersedes_event_id)
    .map(e => e.supersedes_event_id as string))
  const active = events.filter(e => e.event_type === 'approved' && e.effective_from && e.effective_from <= asOf && !terminatedIds.has(e.event_id))
  if (active.length === 0) return null
  const latest = active[active.length - 1]   // latest effective approval still active as-of asOf
  return {
    contributor_account_id: latest.contributor_account_id,
    approval_kind: latest.approval_kind ?? null,
    conflict_disclosure: latest.conflict_disclosure,
    claim_event_id: latest.event_id,
  }
}

/**
 * As-of resolution of a SPECIFIC agent mandate (agent_ref + mandate_id) effective at `asOf` (→ owner
 * contributor). Keyed on BOTH agent_ref AND mandate_id: when one agent_ref has several mandates, the
 * audit row's mandate_id decides attribution — never "whichever mandate is latest" (which would
 * mis-credit). A mandate_id belonging to a different agent_ref does not match.
 */
export function resolveAgentMandateAsOf(db: Database.Database, agentRef: string, mandateId: string, asOf: string): MandateResolution | null {
  if (!agentRef || !mandateId) return null
  const events = db.prepare(
    `SELECT event_type, mandate_id, owner_contributor_account_id, allowed_actions, effective_from, expires_at, revoked_at, event_id, created_at
     FROM agent_execution_mandate_events WHERE agent_ref = ? AND mandate_id = ? ORDER BY effective_from ASC, created_at ASC`,
  ).all(agentRef, mandateId) as any[]
  const grants = events.filter(e =>
    e.event_type === 'granted' &&
    e.effective_from && e.effective_from <= asOf &&
    (!e.expires_at || e.expires_at >= asOf) &&
    (!e.revoked_at || e.revoked_at > asOf))
  if (grants.length === 0) return null
  const latest = grants[grants.length - 1]
  const terminated = events.some(e =>
    (e.event_type === 'revoked' || e.event_type === 'superseded') &&
    e.effective_from && e.effective_from > latest.effective_from && e.effective_from <= asOf)
  if (terminated) return null
  let allowed: string[] = []
  try { const p = JSON.parse(latest.allowed_actions); if (Array.isArray(p)) allowed = p.map(String) } catch { allowed = [] }
  return { owner_contributor_account_id: latest.owner_contributor_account_id, mandate_id: latest.mandate_id, allowed_actions: allowed, grant_event_id: latest.event_id }
}

/**
 * Unified resolver. `github:<id>` → current identity binding; `admin:<id>` / `agent:<ref>` → as-of
 * claim/mandate at `occurredAt`. Returns null when no valid attribution exists (the fact then has no
 * resolvable contributor — it stays evidence only).
 */
export function resolveCoordinationContributor(db: Database.Database, executorRef: string, occurredAt: string): CoordinationResolution | null {
  if (executorRef.startsWith('github:')) {
    const githubActorId = executorRef.slice('github:'.length)
    if (!githubActorId) return null
    const row = db.prepare('SELECT account_id FROM identity_bindings_active WHERE github_actor_id = ?').get(githubActorId) as any
    if (!row) return null
    return { contributor_account_id: row.account_id, via: 'github_binding', detail: {} }
  }
  if (executorRef.startsWith('admin:')) {
    const adminAccountId = executorRef.slice('admin:'.length)
    if (!adminAccountId) return null
    const r = resolveOperatorClaimAsOf(db, adminAccountId, occurredAt)
    if (!r) return null
    return { contributor_account_id: r.contributor_account_id, via: 'operator_claim', detail: { approval_kind: r.approval_kind, conflict_disclosure: r.conflict_disclosure, claim_event_id: r.claim_event_id } }
  }
  if (executorRef.startsWith('agent:')) {
    // executor_ref for agents is `agent:<agent_ref>#<mandate_id>` — the mandate is encoded so read-time
    // resolution is as deterministic as ingest-time (no "latest mandate wins" ambiguity).
    const rest = executorRef.slice('agent:'.length)
    const hash = rest.indexOf('#')
    if (hash < 0) return null   // no mandate encoded → not resolvable (refuse rather than guess)
    const agentRef = rest.slice(0, hash)
    const mandateId = rest.slice(hash + 1)
    if (!agentRef || !mandateId) return null
    const r = resolveAgentMandateAsOf(db, agentRef, mandateId, occurredAt)
    if (!r) return null
    return { contributor_account_id: r.owner_contributor_account_id, via: 'agent_mandate', detail: { mandate_id: r.mandate_id } }
  }
  return null
}
