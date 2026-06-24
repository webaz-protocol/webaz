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
import { coordinationActionSpec, LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS } from './admin-coordination-store.js'
import { resolveOperatorClaimAsOf, resolveAgentMandateAsOf } from './admin-coordination-resolver.js'
import { readAdminActionContext, type Provenance } from '../../pwa/admin-audit.js'

export type Visibility = 'private' | 'governance_only' | 'public'

export interface IngestCoordinationInput {
  auditId: string
  visibility?: Visibility
  redactionSummary?: string
  /** Evaluate every gate but DO NOT write (read-only preview). Returns status 'would_ingest' /
   *  'already_present'. Used by the operator dry-run path so a dry run can never touch the DB. */
  dryRun?: boolean
}
export type IngestRefusal =
  | 'invalid_input' | 'audit_row_not_found' | 'unknown_action' | 'not_eligible_context'
  | 'no_attribution' | 'agent_action_not_in_mandate' | 'self_related_not_disclosed'
export type IngestCoordinationResult =
  | { ok: true; status: 'ingested' | 'already_present' | 'would_ingest'; factId: string; sourceEventKey: string; executorRef: string; contributorAccountId: string; via: 'operator_claim' | 'agent_mandate' }
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
    // A self/related (root/founder bootstrap) approval that is NOT honestly disclosed must NOT enter
    // production evidence — fail closed until an append-only marking correction discloses self_or_related.
    if (c.self_related && !c.honestly_disclosed) {
      return { ok: false, reason: 'self_related_not_disclosed', detail: `claim ${c.claim_event_id} is self/related but marked ${c.approval_kind}/${c.conflict_disclosure}; needs a governance-marking correction` }
    }
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

  // dry-run: all gates passed; report what WOULD happen without writing (read-only — no insert, no tx).
  if (input.dryRun) {
    const existing = db.prepare('SELECT fact_id FROM contribution_facts WHERE source_event_key = ?').get(sourceEventKey) as any
    return { ok: true, status: existing ? 'already_present' : 'would_ingest', factId: existing?.fact_id ?? '(dry-run)', sourceEventKey, executorRef, contributorAccountId, via }
  }

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

// ───────────────────────────── batch / operator entry ─────────────────────────────
// Small, bounded, manual-run batch over ALLOWLISTED audit rows. NOT a historical backfill: the operator
// scopes it with sinceTime / sinceId + a hard limit, and it is DRY-RUN unless `commit` is set. Each row
// goes through the SAME single-row engine above (same fail-closed gates, same idempotency), so the batch
// adds no new attribution logic — it only selects candidates and aggregates the per-row outcomes.

export const DEFAULT_INGEST_LIMIT = 50
export const MAX_INGEST_LIMIT = 500

/**
 * Parse the `--commit` switch at the production write entry. Accept ONLY a bare flag (`raw === ''`) or
 * `--commit=true`. Anything else (`false`, `0`, `no`, …) THROWS — an explicit dry-run intent must never
 * be misread as a write. `undefined` (flag absent) → false (dry-run).
 */
export function parseCommitSwitch(raw: string | undefined): boolean {
  if (raw === undefined) return false
  if (raw === '' || raw === 'true') return true
  throw new Error(`invalid_commit_flag: --commit takes no value (or =true); got ${JSON.stringify(raw)}`)
}

export interface IngestSinceOptions {
  /** Only rows with created_at strictly after this audit row's (created_at, id) — resume cursor. */
  sinceId?: string
  /** Only rows with created_at strictly greater than this ISO/SQLite timestamp. */
  sinceTime?: string
  /** Hard cap on candidate rows scanned (default DEFAULT_INGEST_LIMIT, clamped to MAX_INGEST_LIMIT). */
  limit?: number
  /** Write facts. Default false → dry-run (read-only). */
  commit?: boolean
  visibility?: Visibility
}
export type RowOutcome = 'ingested' | 'would_ingest' | 'already_present' | 'skipped'
export interface IngestBatchRow {
  auditId: string
  action: string
  adminId: string
  occurredAt: string
  outcome: RowOutcome
  reason?: string
  contributorAccountId?: string
  via?: string
  factId?: string
}
export interface IngestBatchReport {
  committed: boolean
  scanned: number
  ingested: number
  wouldIngest: number
  alreadyPresent: number
  skipped: number
  limit: number
  rows: IngestBatchRow[]
}

/**
 * Select rows whose action is in the LIVE production set (only the real `operator_claim.*` actions —
 * NOT the reserved concept names), run each through the single-row engine, and aggregate. Dry-run by
 * default (NOTHING written unless `commit: true`). The candidate query filters to the live set so
 * non-coordination AND reserved-concept rows are never even scanned; unknown/uneligible/no-claim rows
 * that DO match still fail closed per-row and are reported as `skipped` with a reason.
 *
 * THROWS `invalid_cursor` when `sinceId` is supplied but matches no audit row — a fail-closed guard so a
 * typo'd cursor can NEVER silently degrade into a from-the-beginning (backfill) scan.
 *
 * THROWS `commit_requires_cursor` when `commit` is true but NEITHER `sinceTime` nor `sinceId` is given —
 * a no-cursor commit would write from the earliest live row, i.e. a small historical backfill. This
 * pipeline is "from the present, cursor + limit scoped", so a write MUST be cursor-bounded. A no-cursor
 * DRY-RUN is still allowed (preview from the earliest row writes nothing).
 */
export function ingestAdminCoordinationSince(db: Database.Database, options: IngestSinceOptions = {}): IngestBatchReport {
  const commit = options.commit === true
  if (commit && !options.sinceTime && !options.sinceId) {
    throw new Error('commit_requires_cursor: --commit requires --since-time or --since-id (no-cursor commit would backfill history); run a dry-run first to find a cursor')
  }
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_INGEST_LIMIT), MAX_INGEST_LIMIT)
  const actions = [...LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS]
  const placeholders = actions.map(() => '?').join(',')
  const where: string[] = [`action IN (${placeholders})`]
  const params: any[] = [...actions]

  // resume cursor: rows strictly after (cursorTime, cursorId) in (created_at ASC, id ASC) order.
  let cursorTime = options.sinceTime
  let cursorId: string | undefined
  if (options.sinceId) {
    const c = db.prepare('SELECT id, created_at FROM admin_audit_log WHERE id = ?').get(options.sinceId) as any
    // fail-closed: an explicit-but-unknown cursor must NOT degrade into a full from-earliest scan.
    if (!c) throw new Error(`invalid_cursor: no admin_audit_log row with id=${options.sinceId}`)
    cursorTime = c.created_at; cursorId = c.id
  }
  if (cursorTime && cursorId) { where.push('(created_at > ? OR (created_at = ? AND id > ?))'); params.push(cursorTime, cursorTime, cursorId) }
  else if (cursorTime) { where.push('created_at > ?'); params.push(cursorTime) }

  params.push(limit)
  const candidates = db.prepare(
    `SELECT id, action, admin_id, created_at FROM admin_audit_log WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(...params) as any[]

  const rows: IngestBatchRow[] = []
  let ingested = 0, wouldIngest = 0, alreadyPresent = 0, skipped = 0
  for (const cand of candidates) {
    const r = ingestAdminCoordinationFact(db, { auditId: cand.id, visibility: options.visibility, dryRun: !commit })
    const base = { auditId: cand.id as string, action: cand.action as string, adminId: cand.admin_id as string, occurredAt: cand.created_at as string }
    if (!r.ok) { skipped++; rows.push({ ...base, outcome: 'skipped', reason: r.reason + (r.detail ? `: ${r.detail}` : '') }); continue }
    if (r.status === 'ingested') ingested++
    else if (r.status === 'would_ingest') wouldIngest++
    else alreadyPresent++
    rows.push({ ...base, outcome: r.status, contributorAccountId: r.contributorAccountId, via: r.via, factId: r.factId })
  }
  return { committed: commit, scanned: candidates.length, ingested, wouldIngest, alreadyPresent, skipped, limit, rows }
}
