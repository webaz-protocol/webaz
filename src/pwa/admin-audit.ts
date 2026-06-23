/**
 * Centralized admin-audit writer (Phase 1 of admin coordination contribution).
 * Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md.
 *
 * One place to write `admin_audit_log` WITH the actor/accountability context the coordination layer
 * needs (actor_type / agent_mode / human_authorization_id / mandate_id / approval_kind /
 * conflict_disclosure / …). The new context rides inside the existing `detail` JSON under `_ctx`, so
 * this is ADDITIVE — no schema migration, fully compatible with the legacy
 * `INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail)` shape.
 *
 * Legacy rows (and any current INSERT that bypasses this helper) carry NO `_ctx`; a reader MUST treat
 * absent context as `actor_type='unknown_agent'` and NOT contribution-eligible. Migration of existing
 * call sites onto this helper is a later, additive step (see design doc "Deferred").
 *
 * This helper ONLY writes the audit row. It does NOT ingest a contribution fact — that is an explicit,
 * separate, allowlist-gated call to the ingestion engine.
 */
import type Database from 'better-sqlite3'
import { generateId } from '../layer0-foundation/L0-1-database/schema.js'

export type ActorType = 'human' | 'admin_account' | 'agent' | 'system'
export type AgentMode = 'human_direct' | 'agent_assisted' | 'agent_delegated' | 'platform_batch' | 'unknown_agent'
export type ApprovalKind = 'independent_governance' | 'root_approval' | 'founder_bootstrap_override'
export type ConflictDisclosure = 'none' | 'self_or_related' | 'unknown'

export type Provenance = 'human' | 'ai_assisted' | 'ai_authored' | 'unknown'

export interface AdminActionContext {
  actorType?: ActorType
  actorRef?: string
  agentMode?: AgentMode
  humanAuthorizationId?: string
  mandateId?: string
  approvalKind?: ApprovalKind
  conflictDisclosure?: ConflictDisclosure
  provenance?: Provenance
}
export interface LogAdminActionInput {
  adminId: string
  action: string
  targetType?: string | null
  targetId?: string | null
  detail?: Record<string, unknown>
  context?: AdminActionContext
}

/** Default context for an action logged without explicit accountability — NOT contribution-eligible. */
function normalizeContext(ctx?: AdminActionContext): Record<string, unknown> {
  return {
    actor_type: ctx?.actorType ?? 'unknown_agent',
    actor_ref: ctx?.actorRef ?? null,
    agent_mode: ctx?.agentMode ?? 'unknown_agent',
    human_authorization_id: ctx?.humanAuthorizationId ?? null,
    mandate_id: ctx?.mandateId ?? null,
    approval_kind: ctx?.approvalKind ?? null,
    conflict_disclosure: ctx?.conflictDisclosure ?? 'unknown',
    provenance: ctx?.provenance ?? null,
  }
}

/**
 * Write one admin_audit_log row (with `detail._ctx` accountability context) and return its id. The id
 * is what the coordination ingestion engine references as `admin_audit_log_id`.
 */
export function logAdminAction(db: Database.Database, input: LogAdminActionInput): string {
  const id = generateId('audit')
  const detail = JSON.stringify({ ...(input.detail ?? {}), _ctx: normalizeContext(input.context) })
  db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
    .run(id, input.adminId, input.action, input.targetType ?? null, input.targetId ?? null, detail)
  return id
}

/** Read back the accountability context of an audit row. Absent `_ctx` → unknown / not eligible. */
export function readAdminActionContext(detailJson: string | null | undefined): Record<string, unknown> {
  if (!detailJson) return normalizeContext()
  try {
    const parsed = JSON.parse(detailJson)
    const ctx = parsed && typeof parsed === 'object' ? parsed._ctx : undefined
    return ctx && typeof ctx === 'object' ? ctx : normalizeContext()
  } catch { return normalizeContext() }
}
