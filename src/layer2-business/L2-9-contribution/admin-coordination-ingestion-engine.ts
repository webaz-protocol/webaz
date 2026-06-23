/**
 * Admin / Agent coordination → RFC-017 contribution_fact ingestion (Phase 1).
 * Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md.
 *
 * Turns an ALLOWLISTED admin_audit_log coordination action into a row in the EXISTING RFC-017
 * `contribution_facts` ledger (no second ledger) + an evidence link row. Sync (better-sqlite3) so the
 * fact + link insert are one atomic transaction with no await-gap.
 *
 * ANCHORED ON THE AUDIT ROW (the evidence truth). The caller passes ONLY the `auditId` + a few display
 * params; EVERYTHING that decides eligibility/attribution is read from the audit row itself:
 *   - the row must EXIST (else `audit_row_not_found`);
 *   - `action`     ← row.action, and must be allowlisted (else `unknown_action`);
 *   - `adminAccountId` ← row.admin_id;  `occurred_at` ← row.created_at;
 *   - actor/agent/provenance ← row.detail._ctx (written by logAdminAction).
 * A legacy / context-less row reads back as actor_type `unknown_agent` → `not_eligible_context`
 * (fail-closed). The caller can NOT smuggle a different action/admin/time than the audit row records.
 *
 * Fail-closed gates (NOTHING is written unless ALL pass): row exists · action allowlisted · context is
 * an eligible actor · a valid attribution exists AS OF the row's occurred_at (admin → approved operator
 * claim; agent → a mandate covering occurred_at whose allowed_actions include the action).
 *
 * The resolved contributor is NOT written onto the fact — `accountable_ref` stays NULL, resolved at read
 * time (as-of). There is NO value/reward field on this layer. Idempotent: re-ingesting the same audit
 * row → `already_present`.
 */
import type Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { coordinationActionSpec } from './admin-coordination-store.js'
import { resolveOperatorClaimAsOf, resolveAgentMandateAsOf } from './admin-coordination-resolver.js'
import { readAdminActionContext, type Provenance } from '../../pwa/admin-audit.js'

export type Visibility = 'private' | 'governance_only' | 'public'

export interface IngestCoordinationInput {
  auditId: string
  visibility?: Visibility
  redactionSummary?: string
}
export type IngestRefusal =
  | 'invalid_input' | 'audit_row_not_found' | 'unknown_action' | 'not_eligible_context'
  | 'no_attribution' | 'agent_action_not_in_mandate'
export type IngestCoordinationResult =
  | { ok: true; status: 'ingested' | 'already_present'; factId: string; sourceEventKey: string; executorRef: string; contributorAccountId: string; via: 'operator_claim' | 'agent_mandate' }
  | { ok: false; reason: IngestRefusal; detail?: string }

/* eslint-disable @typescript-eslint/no-explicit-any */

function deriveProvenance(ctx: any): Provenance {
  const p = ctx.provenance
  if (p === 'human' || p === 'ai_assisted' || p === 'ai_authored' || p === 'unknown') return p
  if (ctx.actor_type === 'agent') return ctx.agent_mode === 'agent_assisted' ? 'ai_assisted' : 'ai_authored'
  if (ctx.actor_type === 'human' || ctx.actor_type === 'admin_account') return ctx.agent_mode === 'human_direct' ? 'human' : 'unknown'
  return 'unknown'
}

export function ingestAdminCoordinationFact(db: Database.Database, input: IngestCoordinationInput): IngestCoordinationResult {
  const { auditId, redactionSummary } = input
  if (!auditId) return { ok: false, reason: 'invalid_input', detail: 'auditId is required' }

  // ── anchor: the audit row is the evidence truth; read EVERYTHING from it (incl. the coordinated
  // object target_id) so the fact can NEVER point at a different object than the audit row records ──
  const row = db.prepare('SELECT id, admin_id, action, detail, created_at, target_type, target_id FROM admin_audit_log WHERE id = ?').get(auditId) as any
  if (!row) return { ok: false, reason: 'audit_row_not_found', detail: auditId }

  const action: string = row.action
  const spec = coordinationActionSpec(action)
  if (!spec) return { ok: false, reason: 'unknown_action', detail: action }   // allowlist fail-closed

  const ctx = readAdminActionContext(row.detail)
  const actorType = ctx.actor_type
  const adminAccountId: string = row.admin_id
  const occurredAt: string = row.created_at
  // legacy / context-less / system rows are NOT contribution-eligible.
  if (actorType !== 'human' && actorType !== 'admin_account' && actorType !== 'agent') {
    return { ok: false, reason: 'not_eligible_context', detail: `actor_type=${String(actorType)}` }
  }

  // ── attribution gate (as-of) — NOT written onto the fact; only proves the work is attributable ──
  let contributorAccountId: string
  let via: 'operator_claim' | 'agent_mandate'
  let executorRef: string
  if (actorType === 'agent') {
    const actorRef = String(ctx.actor_ref || '')
    const agentRef = actorRef.startsWith('agent:') ? actorRef.slice('agent:'.length) : actorRef
    const mandateId = ctx.mandate_id ? String(ctx.mandate_id) : ''
    // The audit row's mandate_id is REQUIRED and DECIDES attribution — resolve by (agent_ref, mandate_id),
    // never by agent_ref alone (one agent_ref may hold several mandates → wrong-account错账 otherwise).
    if (!agentRef || !mandateId) return { ok: false, reason: 'not_eligible_context', detail: 'agent action requires _ctx.actor_ref + _ctx.mandate_id' }
    const m = resolveAgentMandateAsOf(db, agentRef, mandateId, occurredAt)
    if (!m) return { ok: false, reason: 'no_attribution', detail: `no valid mandate (agent_ref=${agentRef}, mandate_id=${mandateId}) as-of occurred_at` }
    if (!m.allowed_actions.includes(action)) return { ok: false, reason: 'agent_action_not_in_mandate', detail: action }
    contributorAccountId = m.owner_contributor_account_id
    via = 'agent_mandate'
    executorRef = `agent:${agentRef}#${mandateId}`   // mandate encoded → deterministic read-time resolution
  } else {
    const c = resolveOperatorClaimAsOf(db, adminAccountId, occurredAt)
    if (!c) return { ok: false, reason: 'no_attribution', detail: 'no approved operator claim as-of occurred_at' }
    contributorAccountId = c.contributor_account_id
    via = 'operator_claim'
    executorRef = `admin:${adminAccountId}`
  }

  const provenance = deriveProvenance(ctx)
  const visibility: Visibility = input.visibility ?? 'governance_only'
  const sourceEventKey = `admin:${auditId}:coordination`
  // The coordinated object is the audit row's target_id (NOT a caller-supplied value). artifact_ref is
  // NOT NULL → fall back to the action when the row has no target_id; source_id mirrors it (or NULL).
  const targetId: string | null = row.target_id ?? null
  const artifactRef = targetId || action

  const run = db.transaction(() => {
    const existing = db.prepare('SELECT fact_id FROM contribution_facts WHERE source_event_key = ?').get(sourceEventKey) as any
    if (existing) return { factId: existing.fact_id as string, status: 'already_present' as const }
    const factId = generateId('cfact')
    db.prepare(
      `INSERT INTO contribution_facts (fact_id, source_event_key, source, type, artifact_ref, occurred_at, executor_ref, accountable_ref, provenance, status, immutable)
       VALUES (?,?,?,?,?,?,?, NULL, ?, 'active', 1)`,
    ).run(factId, sourceEventKey, spec.factSource, spec.factType, artifactRef, occurredAt, executorRef, provenance)
    db.prepare(
      `INSERT INTO admin_coordination_fact_sources (fact_id, admin_audit_log_id, source_type, source_id, visibility, redaction_summary)
       VALUES (?,?,?,?,?,?)`,
    ).run(factId, auditId, action, targetId, visibility, redactionSummary ?? null)
    return { factId, status: 'ingested' as const }
  })
  const out = run.immediate()
  return { ok: true, status: out.status, factId: out.factId, sourceEventKey, executorRef, contributorAccountId, via }
}
