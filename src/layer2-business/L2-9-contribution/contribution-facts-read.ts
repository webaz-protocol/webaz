/**
 * Contribution read-out V1 — the caller's OWN attributable contribution facts (visibility only).
 * Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md · RFC-017 contribution_facts.
 *
 * Read-only overlay across BOTH attribution paths, anchored on the session account:
 *   - github:<actor>   → facts attributed through a GitHub binding the caller CURRENTLY holds (the same
 *                        credential-backed join as identity-claim-read.ts — a merely-matching executor_ref
 *                        with no authenticated credential is NOT shown).
 *   - admin:<seat>     → admin-coordination evidence facts whose operator claim resolves AS-OF the fact's
 *                        occurred_at to the caller (resolveOperatorClaimAsOf). accountable_ref stays NULL
 *                        on the fact — attribution is resolved here at read time, never written back.
 *   - agent:<ref>#…    → reserved (future); this surface returns an empty agent group and implements NO
 *                        mandate logic.
 *
 * Scope IS the security model: a fact is returned ONLY when it resolves to `accountId` (the session user).
 * No other account's id is returned; no admin_audit_log.detail is read or exposed (the evidence_ref carries
 * only the opaque audit id + the action source_type). NO reward / payout / amount / valuation — the route
 * wraps the payload in the RFC-017 uncommitted-value boundary, and each item carries `notice:'evidence_only'`.
 *
 * Sync (better-sqlite3 handle) by design — it calls the sync as-of resolver; this is an internal self-view
 * read, not a hot write path.
 */
import type Database from 'better-sqlite3'
import { resolveOperatorClaimAsOf } from './admin-coordination-resolver.js'

export type AttributionVia = 'github_binding' | 'operator_claim' | 'agent_mandate'

export interface MyContributionFact {
  fact_id: string
  source_event_key: string
  source: string
  type: string | null
  occurred_at: string | null
  executor_ref: string
  attribution_via: AttributionVia
  contributor_account_id: string
  artifact_ref: string
  status: string
  provenance: string
  display_source_label: string
  display_source_label_en: string
  display_summary: string
  evidence_ref: { source_type: string; admin_audit_log_id: string } | null
  notice: 'evidence_only'
}
export interface MyContributionFactsSurface {
  total: number
  groups: {
    github: MyContributionFact[]
    admin_coordination: MyContributionFact[]
    agent: MyContributionFact[]   // reserved / always empty in V1
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const dateOf = (ts: string | null): string => (ts ? String(ts).slice(0, 10) : '')

// GitHub: credential-backed facts whose executor is an actor the caller currently binds (same trust-root
// join as identity-claim-read.ts FACTS_SQL). The b.account_id = ? anchor means only MY facts return.
const GITHUB_FACTS_SQL = `
  SELECT DISTINCT f.fact_id, f.source_event_key, f.source, f.type, f.artifact_ref, f.occurred_at,
         f.executor_ref, f.provenance, f.status
  FROM identity_bindings_active b
  JOIN github_contribution_credentials c
    ON c.github_actor_id = b.github_actor_id
  JOIN github_fact_credentials l
    ON l.credential_id = c.credential_id AND l.source_event_key = c.source_event_key
  JOIN contribution_facts f
    ON f.fact_id = l.fact_id AND f.source_event_key = l.source_event_key
  WHERE b.account_id = ?
    AND f.source = 'github'
    AND f.executor_ref = 'github:' || b.github_actor_id
  ORDER BY f.occurred_at DESC, f.fact_id`

// Admin coordination: every evidence-linked fact (executor admin:<seat>). Attribution is decided per-row
// by the AS-OF resolver below — never by a stored accountable_ref. The link join also yields the
// evidence_ref (source_type + opaque audit id); admin_audit_log.detail is never selected.
const ADMIN_FACTS_SQL = `
  SELECT f.fact_id, f.source_event_key, f.source, f.type, f.artifact_ref, f.occurred_at,
         f.executor_ref, f.provenance, f.status, s.source_type, s.admin_audit_log_id
  FROM admin_coordination_fact_sources s
  JOIN contribution_facts f ON f.fact_id = s.fact_id
  WHERE f.executor_ref LIKE 'admin:%'
  ORDER BY f.occurred_at DESC, f.fact_id`

/** The caller's OWN attributable contribution facts (GitHub + admin coordination). Read-only; writes nothing. */
export function getMyContributionFacts(db: Database.Database, accountId: string): MyContributionFactsSurface {
  const github: MyContributionFact[] = []
  const admin_coordination: MyContributionFact[] = []
  if (!accountId) return { total: 0, groups: { github, admin_coordination, agent: [] } }

  for (const r of db.prepare(GITHUB_FACTS_SQL).all(accountId) as any[]) {
    github.push({
      fact_id: r.fact_id, source_event_key: r.source_event_key, source: r.source, type: r.type ?? null,
      occurred_at: r.occurred_at ?? null, executor_ref: r.executor_ref, attribution_via: 'github_binding',
      contributor_account_id: accountId, artifact_ref: r.artifact_ref, status: r.status, provenance: r.provenance,
      display_source_label: 'GitHub', display_source_label_en: 'GitHub',
      display_summary: `GitHub · ${r.type || 'contribution'}${dateOf(r.occurred_at) ? ' · ' + dateOf(r.occurred_at) : ''}`,
      evidence_ref: null, notice: 'evidence_only',
    } as MyContributionFact)
  }

  for (const r of db.prepare(ADMIN_FACTS_SQL).all() as any[]) {
    const adminAccountId = String(r.executor_ref).slice('admin:'.length)
    if (!adminAccountId || !r.occurred_at) continue
    // AS-OF attribution: the operator claim effective when the work occurred decides the contributor.
    const resolved = resolveOperatorClaimAsOf(db, adminAccountId, r.occurred_at)
    if (!resolved || resolved.contributor_account_id !== accountId) continue   // not mine → never shown
    admin_coordination.push({
      fact_id: r.fact_id, source_event_key: r.source_event_key, source: r.source, type: r.type ?? null,
      occurred_at: r.occurred_at ?? null, executor_ref: r.executor_ref, attribution_via: 'operator_claim',
      contributor_account_id: accountId, artifact_ref: r.artifact_ref, status: r.status, provenance: r.provenance,
      display_source_label: '管理协调', display_source_label_en: 'Admin coordination',
      display_summary: `管理协调 · ${r.source_type}${dateOf(r.occurred_at) ? ' · ' + dateOf(r.occurred_at) : ''}`,
      // evidence_ref: opaque audit id + the action only — NEVER admin_audit_log.detail.
      evidence_ref: { source_type: r.source_type, admin_audit_log_id: r.admin_audit_log_id },
      notice: 'evidence_only',
    } as MyContributionFact)
  }

  return { total: github.length + admin_coordination.length, groups: { github, admin_coordination, agent: [] } }
}
