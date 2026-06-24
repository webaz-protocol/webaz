/**
 * PR9C-1 — Future Task Board READ helpers (read/filter only; NO create/claim/submit, no state-machine
 * change). Joins `build_tasks` core (RFC-006) with the PR9B `build_task_agent_metadata` satellite (#327)
 * and shapes a list (lightweight triage) or detail (full execution boundary + acceptance) view, per the
 * #328 gap report. List JSON fields are parsed back to arrays here (callers/agents never see raw JSON).
 * Tasks with no metadata return `agent_metadata: null` (old RFC-006 tasks stay compatible).
 *
 * Visibility scope (never leak restricted/internal to an unauthorized reader):
 *   - 'public'  : INNER JOIN — only metadata-bearing tasks with audience='public' AND status='open'.
 *   - 'member'  : LEFT JOIN — audience IS NULL (old tasks) OR audience='public'; restricted/internal hidden.
 * (An authorized restricted/internal read surface is deferred — there are no such tasks pre-launch.)
 *
 * All value stays uncommitted (RFC-017 I-12); the route wraps every response in the PR5A value_boundary.
 */
import type Database from 'better-sqlite3'
import { RISK_LEVELS, AUDIENCES, CONTEXT_SIZES, AGENT_BUDGETS, parseJsonList } from './build-task-agent-metadata-store.js'
import { TASK_STATUS, releaseExpiredClaims } from './build-tasks-engine.js'
import { getCanonicalContributionTarget } from './canonical-contribution-target.js'
import { withUncommittedValueBoundary } from './contribution-display-envelope.js'

/**
 * The single read envelope: stamps the SAME trusted canonical_contribution_target (anti GitHub-target
 * confusion) AND the uncommitted value_boundary onto every task-board read response (public + member), so
 * an agent always gets the identical, config-sourced target — never one derived from task metadata.
 */
export function withContributionReadEnvelope<T extends object>(payload: T): T & { canonical_contribution_target: ReturnType<typeof getCanonicalContributionTarget>; value_boundary: unknown } {
  return withUncommittedValueBoundary({ ...payload, canonical_contribution_target: getCanonicalContributionTarget() }) as any
}

export type VisibilityScope = 'public' | 'member'

export interface TaskFilters { status?: string; area?: string; risk_level?: string; audience?: string; auto_claimable?: boolean; claimerId?: string; requiredCapabilities?: string[]; agentCapabilities?: string[]; maxDurationMinutes?: number; estimated_context_size?: string; estimated_agent_budget?: string }

/** Validate raw query filters — fail-closed: an unknown value is rejected, never silently ignored. */
export function validateTaskFilters(q: Record<string, unknown>): { ok: true; filters: TaskFilters } | { ok: false; code: string; detail: string } {
  const f: TaskFilters = {}
  const bad = (code: string, detail: string) => ({ ok: false as const, code, detail })
  if (q.status !== undefined) { if (typeof q.status !== 'string' || !TASK_STATUS.has(q.status)) return bad('INVALID_FILTER_STATUS', 'status must be open|claimed|in_review|done|abandoned'); f.status = q.status }
  if (q.area !== undefined) { if (typeof q.area !== 'string' || q.area.trim().length === 0) return bad('INVALID_FILTER_AREA', 'area must be a non-empty string'); f.area = q.area.slice(0, 64) }
  if (q.risk_level !== undefined) { if (typeof q.risk_level !== 'string' || !RISK_LEVELS.includes(q.risk_level as any)) return bad('INVALID_FILTER_RISK_LEVEL', `risk_level must be ${RISK_LEVELS.join('|')}`); f.risk_level = q.risk_level }
  if (q.audience !== undefined) { if (typeof q.audience !== 'string' || !AUDIENCES.includes(q.audience as any)) return bad('INVALID_FILTER_AUDIENCE', `audience must be ${AUDIENCES.join('|')}`); f.audience = q.audience }
  if (q.auto_claimable !== undefined) { if (q.auto_claimable !== 'true' && q.auto_claimable !== 'false') return bad('INVALID_FILTER_AUTO_CLAIMABLE', 'auto_claimable must be true|false'); f.auto_claimable = q.auto_claimable === 'true' }
  // required_capabilities: comma-separated; a task matches if it requires ALL of them (AND). Capped to keep
  // the WHERE bounded; fail-closed on a non-string / empty list.
  if (q.required_capabilities !== undefined) {
    if (typeof q.required_capabilities !== 'string') return bad('INVALID_FILTER_REQUIRED_CAPABILITIES', 'required_capabilities must be a comma-separated string')
    const caps = q.required_capabilities.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10).map(c => c.slice(0, 64))
    if (caps.length === 0) return bad('INVALID_FILTER_REQUIRED_CAPABILITIES', 'required_capabilities must list at least one non-empty capability')
    f.requiredCapabilities = caps
  }
  // agent_capabilities: the agent's OWN capability set — match tasks whose required_capabilities are a
  // SUBSET (tasks the agent can actually do). Distinct from required_capabilities (which is AND/superset:
  // "task requires all listed"). Same 10-item / 64-char caps; fail-closed on non-string / empty.
  if (q.agent_capabilities !== undefined) {
    if (typeof q.agent_capabilities !== 'string') return bad('INVALID_FILTER_AGENT_CAPABILITIES', 'agent_capabilities must be a comma-separated string')
    const caps = q.agent_capabilities.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10).map(c => c.slice(0, 64))
    if (caps.length === 0) return bad('INVALID_FILTER_AGENT_CAPABILITIES', 'agent_capabilities must list at least one non-empty capability')
    f.agentCapabilities = caps
  }
  // max_duration_minutes: only tasks whose estimated max duration fits within this many minutes. Fail-closed
  // on non-string / non-positive-integer / out-of-range.
  if (q.max_duration_minutes !== undefined) {
    if (typeof q.max_duration_minutes !== 'string') return bad('INVALID_FILTER_MAX_DURATION', 'max_duration_minutes must be a positive integer')
    const n = Number(q.max_duration_minutes)
    if (!Number.isInteger(n) || n <= 0 || n > 100000) return bad('INVALID_FILTER_MAX_DURATION', 'max_duration_minutes must be a positive integer (1..100000)')
    f.maxDurationMinutes = n
  }
  if (q.estimated_context_size !== undefined) { if (typeof q.estimated_context_size !== 'string' || !CONTEXT_SIZES.includes(q.estimated_context_size as any)) return bad('INVALID_FILTER_CONTEXT_SIZE', `estimated_context_size must be ${CONTEXT_SIZES.join('|')}`); f.estimated_context_size = q.estimated_context_size }
  if (q.estimated_agent_budget !== undefined) { if (typeof q.estimated_agent_budget !== 'string' || !AGENT_BUDGETS.includes(q.estimated_agent_budget as any)) return bad('INVALID_FILTER_AGENT_BUDGET', `estimated_agent_budget must be ${AGENT_BUDGETS.join('|')}`); f.estimated_agent_budget = q.estimated_agent_budget }
  return { ok: true, filters: f }
}

const LIST_ARRAY_FIELDS = ['required_capabilities', 'dependencies', 'blocking_conditions']

/* eslint-disable @typescript-eslint/no-explicit-any */
function shapeMetadata(row: any, shape: 'list' | 'detail'): Record<string, unknown> | null {
  if (row.task_type == null) return null   // no satellite row → old task, compatible
  const m: Record<string, unknown> = {
    task_type: row.task_type, risk_level: row.risk_level, audience: row.audience,
    agent_autonomy: row.agent_autonomy, auto_claimable: row.auto_claimable === 1,
    estimated_duration: { min_minutes: row.estimated_duration_min_minutes, max_minutes: row.estimated_duration_max_minutes },
    estimated_context_size: row.estimated_context_size, estimated_agent_budget: row.estimated_agent_budget,
    value_state: row.value_state,
  }
  // Honest estimate signal (#5): a proposal→draft conversion (task-proposal-draft.ts) seeds duration 0–0 +
  // budget 'minimal' as a "no real estimate yet" placeholder — NOT a claim the task is instant / zero-cost.
  // Surface a typed status so an agent never reads the placeholder as a real estimate. The raw
  // estimated_duration / estimated_agent_budget / auto_claimable fields above are left untouched (no storage
  // change); these are derived, advisory fields. estimate_status='unknown' means BOTH duration and budget are
  // placeholders. A 0–0/placeholder task that is nominally auto_claimable is downgraded to manual_review so a
  // missing estimate is reviewed before the task is treated as routine.
  const durMin = row.estimated_duration_min_minutes, durMax = row.estimated_duration_max_minutes
  const estimateUnknown = durMin == null || durMax == null || (durMin === 0 && durMax === 0)
  const autoClaimable = row.auto_claimable === 1
  m.estimate_status = estimateUnknown ? 'unknown' : 'provided'
  m.claimability = !autoClaimable || estimateUnknown ? 'manual_review' : 'auto_claimable'
  m.human_review_required = m.claimability === 'manual_review'
  for (const k of LIST_ARRAY_FIELDS) m[k] = parseJsonList(row[k])
  if (shape === 'detail') {
    m.source_ref = row.source_ref; m.version = row.version
    m.expected_results = row.expected_results; m.definition_of_done = row.definition_of_done
    m.contribution_type = row.contribution_type; m.accountable_party_required = row.accountable_party_required === 1
    for (const k of ['allowed_paths', 'forbidden_paths', 'prohibited_actions', 'human_confirmation_points', 'acceptance_criteria', 'verification_commands', 'deliverables']) m[k] = parseJsonList(row[k])
  }
  return m
}

// FULL legacy build_tasks core — the member (logged-in) endpoint MUST keep every old field for backward
// compatibility (Codex regression): only agent_metadata / value_boundary / canonical_contribution_target
// are APPENDED. The public endpoint uses the lighter task_id shape.
const FULL_CORE = ['id', 'title', 'area', 'description', 'rfc_ref', 'status', 'claimer_id', 'claimer_provenance',
  'pr_ref', 'claimed_at', 'claim_expires_at', 'created_by', 'resolution', 'resolved_by', 'created_at', 'updated_at']
function shapeCoreFull(row: any): Record<string, unknown> { const o: Record<string, unknown> = {}; for (const k of FULL_CORE) o[k] = row[k]; return o }
function shapeCoreLight(row: any): Record<string, unknown> {
  return { task_id: row.id, title: row.title, area: row.area, status: row.status, claimer_id: row.claimer_id, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at }
}

function buildWhere(scope: VisibilityScope, f: TaskFilters): { where: string[]; params: unknown[]; join: string } {
  const where: string[] = []; const params: unknown[] = []
  const join = scope === 'public' ? 'JOIN' : 'LEFT JOIN'
  if (scope === 'public') { where.push("m.audience = 'public'", "t.status = 'open'") }
  else { where.push("(m.audience IS NULL OR m.audience = 'public')") }   // member: hide restricted/internal
  if (f.status) { where.push('t.status = ?'); params.push(f.status) }
  if (f.area) { where.push('t.area = ?'); params.push(f.area) }
  if (f.claimerId) { where.push('t.claimer_id = ?'); params.push(f.claimerId) }
  if (f.risk_level) { where.push('m.risk_level = ?'); params.push(f.risk_level) }
  if (f.audience) { where.push('m.audience = ?'); params.push(f.audience) }
  if (f.auto_claimable !== undefined) { where.push('m.auto_claimable = ?'); params.push(f.auto_claimable ? 1 : 0) }
  // required_capabilities (AND): required_capabilities is a JSON array of strings; match an exact element
  // via a quoted LIKE (dialect-agnostic; no json_each). ESCAPE so %/_ in a capability stay literal. This
  // ANDs with the scope clause above, so restricted/internal never leak even when a filter matches.
  if (f.requiredCapabilities) for (const cap of f.requiredCapabilities) {
    where.push("m.required_capabilities LIKE ? ESCAPE '\\'")
    params.push('%"' + cap.replace(/[\\%_]/g, c => '\\' + c) + '"%')
  }
  // max_duration_minutes: the task's estimated max duration must be known AND fit within the requested time.
  if (f.maxDurationMinutes !== undefined) { where.push('m.estimated_duration_max_minutes IS NOT NULL AND m.estimated_duration_max_minutes <= ?'); params.push(f.maxDurationMinutes) }
  if (f.estimated_context_size) { where.push('m.estimated_context_size = ?'); params.push(f.estimated_context_size) }
  if (f.estimated_agent_budget) { where.push('m.estimated_agent_budget = ?'); params.push(f.estimated_agent_budget) }
  return { where, params, join }
}

// SELECT t.* (every legacy build_tasks column) + the explicit metadata columns (NOT m.created_at, to
// avoid colliding with t.created_at; m.* names are otherwise disjoint from t.*).
const META_COLS = `m.task_type, m.source_ref, m.version, m.allowed_paths, m.forbidden_paths, m.prohibited_actions,
  m.risk_level, m.audience, m.agent_autonomy, m.auto_claimable, m.human_confirmation_points,
  m.required_capabilities, m.acceptance_criteria, m.verification_commands, m.expected_results,
  m.deliverables, m.definition_of_done, m.estimated_duration_min_minutes, m.estimated_duration_max_minutes,
  m.estimated_context_size, m.estimated_agent_budget, m.dependencies, m.blocking_conditions, m.value_state,
  m.contribution_type, m.accountable_party_required`

/** List tasks visible in `scope` (member = full legacy core; public = light), with parsed agent_metadata or null. */
export function listBuildTasksWithAgentMetadata(db: Database.Database, filters: TaskFilters, scope: VisibilityScope): Array<Record<string, unknown>> {
  releaseExpiredClaims(db)   // RFC-006 TTL: recycle expired claims before reading (parity with listBuildTasks)
  const LIST_LIMIT = 200
  const { where, params, join } = buildWhere(scope, filters)
  // agent_capabilities is a JS subset filter, so it must run BEFORE the cap — applying SQL LIMIT first would
  // drop a doable task that sorted past row 200 (Codex P2: a real false-negative). When it is active we fetch
  // the full SCOPED candidate set (already bounded by the scope/other WHERE clauses) and cap after filtering.
  const limitSql = filters.agentCapabilities ? '' : ` LIMIT ${LIST_LIMIT}`
  let rows = db.prepare(`SELECT t.*, ${META_COLS} FROM build_tasks t ${join} build_task_agent_metadata m ON m.task_id = t.id
    WHERE ${where.join(' AND ')}
    ORDER BY (t.status='open') DESC, t.updated_at DESC${limitSql}`).all(...params) as any[]
  // agent_capabilities (SUBSET): keep tasks whose required_capabilities are all within the agent's set —
  // i.e. tasks the agent can do — then cap. Dialect-agnostic (no json_each). No-leak intact: the scope WHERE
  // already excluded restricted/internal, so this can only narrow. A no-metadata task (member scope) has no
  // required_capabilities → [] → vacuously a subset (no skills required).
  if (filters.agentCapabilities) {
    const have = new Set(filters.agentCapabilities)
    rows = rows.filter(r => parseJsonList(r.required_capabilities).every(c => have.has(c))).slice(0, LIST_LIMIT)
  }
  return rows.map(r => ({ ...(scope === 'public' ? shapeCoreLight(r) : shapeCoreFull(r)), agent_metadata: shapeMetadata(r, 'list') }))
}

/** Detail for one task visible in `scope`, else null (no leak). Member keeps the full legacy core + events. */
export function getBuildTaskWithAgentMetadata(db: Database.Database, id: string, scope: VisibilityScope): Record<string, unknown> | null {
  releaseExpiredClaims(db)   // RFC-006 TTL parity with getBuildTask
  const { where, params, join } = buildWhere(scope, {})
  const row = db.prepare(`SELECT t.*, ${META_COLS} FROM build_tasks t ${join} build_task_agent_metadata m ON m.task_id = t.id
    WHERE ${where.join(' AND ')} AND t.id = ?`).get(...params, id) as any
  if (!row) return null
  const core = scope === 'public' ? shapeCoreLight(row) : shapeCoreFull(row)
  const out: Record<string, unknown> = { ...core, agent_metadata: shapeMetadata(row, 'detail') }
  if (scope !== 'public') {   // member detail keeps the build_task_events list (old getBuildTask behavior)
    out.events = db.prepare(`SELECT actor_id, from_status, to_status, note, created_at FROM build_task_events WHERE task_id = ? ORDER BY created_at`).all(id)
  }
  return out
}
