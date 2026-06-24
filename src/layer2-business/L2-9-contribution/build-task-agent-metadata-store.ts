/**
 * PR9B — Future Task Board v1 storage (SCHEMA + STORE only; no API/MCP/PWA/UI).
 *
 * An ADDITIVE satellite table that carries the agent-ready execution-boundary / acceptance / estimate /
 * attribution fields for a `build_tasks` row (design contract: docs/FUTURE-TASK-BOARD-V1-DESIGN.md, #326;
 * field set: docs/PRELAUNCH-DOGFOOD-CASE-PACK.md, #325). It does NOT touch the RFC-006 `build_tasks` core
 * state machine (open → claimed → in_review → done | abandoned; atomic claim / TTL / WIP / human
 * acceptance are unchanged). 1:1 with `build_tasks` (PK = task_id FK).
 *
 * The DB enforces the contract invariants as CHECK/FK/NOT NULL (defense-in-depth backstop); the store
 * helpers below are the FIRST guard — they validate enums + cross-field invariants and own the JSON
 * stringify/parse for the list fields, so a future route/API NEVER hand-builds the JSON. All contribution
 * value is `value_state: uncommitted` (RFC-017 I-12) — no amount / reward / payout / settlement here.
 *
 * NB: the SQL string carries NO inline `--` comments (gen-pg-schema strips them → trailing whitespace).
 */
import type Database from 'better-sqlite3'

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export const AUDIENCES = ['public', 'restricted', 'internal'] as const
export const AUTONOMIES = ['autonomous', 'supervised', 'human_in_the_loop', 'human_only'] as const
export const CONTEXT_SIZES = ['small', 'medium', 'large'] as const
export const AGENT_BUDGETS = ['minimal', 'small', 'moderate', 'large', 'xlarge'] as const
export const TASK_TYPES = ['docs', 'i18n', 'tests', 'sdk_example', 'ui', 'code', 'api', 'schema', 'infra', 'governance', 'audit', 'other'] as const   // aligned with spec/agent-task/agent-task.schema.ts
const HUMAN_AUTONOMY = new Set(['human_in_the_loop', 'human_only'])

export type RiskLevel = typeof RISK_LEVELS[number]
export type Audience = typeof AUDIENCES[number]
export type Autonomy = typeof AUTONOMIES[number]
export type ContextSize = typeof CONTEXT_SIZES[number]
export type AgentBudget = typeof AGENT_BUDGETS[number]

export interface BuildTaskAgentMetadata {
  task_type: typeof TASK_TYPES[number]
  source_ref?: string | null
  version?: string | null
  allowed_paths: string[]
  forbidden_paths?: string[]
  prohibited_actions: string[]
  risk_level: RiskLevel
  audience: Audience
  agent_autonomy: Autonomy
  auto_claimable: boolean
  human_confirmation_points?: string[]
  required_capabilities: string[]
  acceptance_criteria: string[]
  verification_commands: string[]
  expected_results: string
  deliverables: string[]
  definition_of_done: string
  estimated_duration_min_minutes: number
  estimated_duration_max_minutes: number
  estimated_context_size: ContextSize
  estimated_agent_budget: AgentBudget
  dependencies?: string[]
  blocking_conditions?: string[]
  value_state?: 'uncommitted'
  contribution_type: string
  accountable_party_required: boolean
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS build_task_agent_metadata (
    task_id                        TEXT PRIMARY KEY REFERENCES build_tasks(id),
    task_type                      TEXT NOT NULL CHECK (task_type IN ('docs','i18n','tests','sdk_example','ui','code','api','schema','infra','governance','audit','other')),
    source_ref                     TEXT,
    version                        TEXT,
    allowed_paths                  TEXT NOT NULL CHECK (allowed_paths <> '' AND allowed_paths <> '[]'),
    forbidden_paths                TEXT NOT NULL DEFAULT '[]',
    prohibited_actions             TEXT NOT NULL CHECK (prohibited_actions <> '' AND prohibited_actions <> '[]'),
    risk_level                     TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
    audience                       TEXT NOT NULL CHECK (audience IN ('public','restricted','internal')),
    agent_autonomy                 TEXT NOT NULL CHECK (agent_autonomy IN ('autonomous','supervised','human_in_the_loop','human_only')),
    auto_claimable                 INTEGER NOT NULL CHECK (auto_claimable IN (0,1)),
    human_confirmation_points      TEXT NOT NULL DEFAULT '[]',
    required_capabilities          TEXT NOT NULL CHECK (required_capabilities <> '' AND required_capabilities <> '[]'),
    acceptance_criteria            TEXT NOT NULL CHECK (acceptance_criteria <> '' AND acceptance_criteria <> '[]'),
    verification_commands          TEXT NOT NULL CHECK (verification_commands <> '' AND verification_commands <> '[]'),
    expected_results               TEXT NOT NULL CHECK (length(trim(expected_results)) > 0),
    deliverables                   TEXT NOT NULL CHECK (deliverables <> '' AND deliverables <> '[]'),
    definition_of_done             TEXT NOT NULL CHECK (length(trim(definition_of_done)) > 0),
    estimated_duration_min_minutes INTEGER NOT NULL CHECK (estimated_duration_min_minutes >= 0),
    estimated_duration_max_minutes INTEGER NOT NULL,
    estimated_context_size         TEXT NOT NULL CHECK (estimated_context_size IN ('small','medium','large')),
    estimated_agent_budget         TEXT NOT NULL CHECK (estimated_agent_budget IN ('minimal','small','moderate','large','xlarge')),
    dependencies                   TEXT NOT NULL DEFAULT '[]',
    blocking_conditions            TEXT NOT NULL DEFAULT '[]',
    value_state                    TEXT NOT NULL DEFAULT 'uncommitted' CHECK (value_state = 'uncommitted'),
    contribution_type              TEXT NOT NULL CHECK (length(trim(contribution_type)) > 0),
    accountable_party_required     INTEGER NOT NULL CHECK (accountable_party_required IN (0,1)),
    created_at                     TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (estimated_duration_max_minutes >= estimated_duration_min_minutes),
    CHECK (risk_level NOT IN ('high','critical') OR auto_claimable = 0),
    CHECK (risk_level NOT IN ('high','critical') OR agent_autonomy IN ('human_in_the_loop','human_only')),
    CHECK (risk_level NOT IN ('high','critical') OR (human_confirmation_points <> '[]' AND human_confirmation_points <> '')),
    CHECK (risk_level <> 'critical' OR audience <> 'public')
  )
`
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_btam_discovery ON build_task_agent_metadata(risk_level, audience, auto_claimable)`

export function initBuildTaskAgentMetadataSchema(db: Database.Database): void {
  db.exec(CREATE_TABLE)
  db.exec(CREATE_INDEX)
}

// ── JSON list helpers (the ONLY place list fields are stringified/parsed) ──
function toJsonList(field: string, v: unknown, { allowEmpty }: { allowEmpty: boolean }): string {
  if (!Array.isArray(v)) throw new Error(`${field} must be a string[]`)
  // Every entry must be a non-blank string — a list with an empty/whitespace element is an unexecutable
  // boundary (Codex P1: ['']/['   '] previously slipped past the coarse DB CHECK). This holds even for
  // allowEmpty fields: the array may be empty, but it may not contain an empty element.
  for (const x of v) {
    if (typeof x !== 'string' || x.trim().length === 0) throw new Error(`${field} entries must be non-empty strings`)
  }
  if (!allowEmpty && v.length === 0) throw new Error(`${field} must be non-empty`)
  return JSON.stringify(v)
}
export function parseJsonList(v: string | null | undefined): string[] {
  if (!v) return []
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [] } catch { return [] }
}

function assertEnum(field: string, v: unknown, allowed: readonly string[]): string {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error(`${field} must be one of ${allowed.join('|')} (got ${String(v)})`)
  return v
}
function assertNonEmptyText(field: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new Error(`${field} must be non-empty text`)
  return v
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Validate + insert a task's agent metadata. The store is the FIRST guard (throws on any contract
 * violation); the DB CHECK/FK are the backstop. Lists are stringified to JSON here — callers pass arrays,
 * never raw JSON.
 */
export function insertBuildTaskAgentMetadata(db: Database.Database, taskId: string, m: BuildTaskAgentMetadata): void {
  if (!taskId) throw new Error('taskId required')
  const task_type = assertEnum('task_type', m.task_type, TASK_TYPES)
  const risk_level = assertEnum('risk_level', m.risk_level, RISK_LEVELS) as RiskLevel
  const audience = assertEnum('audience', m.audience, AUDIENCES)
  const agent_autonomy = assertEnum('agent_autonomy', m.agent_autonomy, AUTONOMIES)
  const estimated_context_size = assertEnum('estimated_context_size', m.estimated_context_size, CONTEXT_SIZES)
  const estimated_agent_budget = assertEnum('estimated_agent_budget', m.estimated_agent_budget, AGENT_BUDGETS)
  if ((m.value_state ?? 'uncommitted') !== 'uncommitted') throw new Error('value_state must be uncommitted')
  const expected_results = assertNonEmptyText('expected_results', m.expected_results)
  const definition_of_done = assertNonEmptyText('definition_of_done', m.definition_of_done)
  const contribution_type = assertNonEmptyText('contribution_type', m.contribution_type)

  const min = m.estimated_duration_min_minutes, max = m.estimated_duration_max_minutes
  if (!Number.isInteger(min) || min < 0) throw new Error('estimated_duration_min_minutes must be a non-negative integer')
  if (!Number.isInteger(max) || max < min) throw new Error('estimated_duration_max_minutes must be an integer >= min')

  const isHigh = risk_level === 'high' || risk_level === 'critical'
  if (isHigh && m.auto_claimable === true) throw new Error('high/critical risk_level requires auto_claimable=false')
  if (isHigh && !HUMAN_AUTONOMY.has(agent_autonomy)) throw new Error('high/critical risk_level requires agent_autonomy human_in_the_loop|human_only')
  if (risk_level === 'critical' && audience === 'public') throw new Error('critical risk_level cannot have audience=public')
  const hcp = m.human_confirmation_points ?? []
  if (isHigh && hcp.length === 0) throw new Error('high/critical risk_level requires >=1 human_confirmation_points')

  db.prepare(`INSERT INTO build_task_agent_metadata (
      task_id, task_type, source_ref, version, allowed_paths, forbidden_paths, prohibited_actions,
      risk_level, audience, agent_autonomy, auto_claimable, human_confirmation_points, required_capabilities,
      acceptance_criteria, verification_commands, expected_results, deliverables, definition_of_done,
      estimated_duration_min_minutes, estimated_duration_max_minutes, estimated_context_size,
      estimated_agent_budget, dependencies, blocking_conditions, value_state, contribution_type,
      accountable_party_required
    ) VALUES (
      @task_id, @task_type, @source_ref, @version, @allowed_paths, @forbidden_paths, @prohibited_actions,
      @risk_level, @audience, @agent_autonomy, @auto_claimable, @human_confirmation_points, @required_capabilities,
      @acceptance_criteria, @verification_commands, @expected_results, @deliverables, @definition_of_done,
      @estimated_duration_min_minutes, @estimated_duration_max_minutes, @estimated_context_size,
      @estimated_agent_budget, @dependencies, @blocking_conditions, 'uncommitted', @contribution_type,
      @accountable_party_required
    )`).run({
    task_id: taskId,
    task_type,
    source_ref: m.source_ref ?? null,
    version: m.version ?? null,
    allowed_paths: toJsonList('allowed_paths', m.allowed_paths, { allowEmpty: false }),
    forbidden_paths: toJsonList('forbidden_paths', m.forbidden_paths ?? [], { allowEmpty: true }),
    prohibited_actions: toJsonList('prohibited_actions', m.prohibited_actions, { allowEmpty: false }),
    risk_level, audience, agent_autonomy,
    auto_claimable: m.auto_claimable ? 1 : 0,
    human_confirmation_points: toJsonList('human_confirmation_points', hcp, { allowEmpty: true }),
    required_capabilities: toJsonList('required_capabilities', m.required_capabilities, { allowEmpty: false }),
    acceptance_criteria: toJsonList('acceptance_criteria', m.acceptance_criteria, { allowEmpty: false }),
    verification_commands: toJsonList('verification_commands', m.verification_commands, { allowEmpty: false }),
    expected_results,
    deliverables: toJsonList('deliverables', m.deliverables, { allowEmpty: false }),
    definition_of_done,
    estimated_duration_min_minutes: min,
    estimated_duration_max_minutes: max,
    estimated_context_size, estimated_agent_budget,
    dependencies: toJsonList('dependencies', m.dependencies ?? [], { allowEmpty: true }),
    blocking_conditions: toJsonList('blocking_conditions', m.blocking_conditions ?? [], { allowEmpty: true }),
    contribution_type,
    accountable_party_required: m.accountable_party_required ? 1 : 0,
  })
}

/** Read + parse a task's agent metadata (list fields parsed back to arrays). */
export function getBuildTaskAgentMetadata(db: Database.Database, taskId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM build_task_agent_metadata WHERE task_id = ?').get(taskId) as any
  if (!row) return null
  for (const k of ['allowed_paths', 'forbidden_paths', 'prohibited_actions', 'human_confirmation_points',
    'required_capabilities', 'acceptance_criteria', 'verification_commands', 'deliverables', 'dependencies',
    'blocking_conditions']) row[k] = parseJsonList(row[k])
  row.auto_claimable = row.auto_claimable === 1
  row.accountable_party_required = row.accountable_party_required === 1
  return row
}

/**
 * Flip a task's audience (used to PUBLISH an internal draft → 'public'). Validated against AUDIENCES.
 * Returns the number of rows changed (0 = no metadata row for that task).
 */
export function setBuildTaskAudience(db: Database.Database, taskId: string, audience: Audience): number {
  const a = assertEnum('audience', audience, AUDIENCES)
  const r = db.prepare(`UPDATE build_task_agent_metadata SET audience = ? WHERE task_id = ?`).run(a, taskId)
  return r.changes
}

/**
 * Set a task's real effort estimate (publish gate, #34/#5). Validates a non-zero duration (max >= min,
 * max >= 1 — i.e. NOT the 0–0 placeholder) and optional budget / context-size enums. Used by the
 * proposal→draft publish path so a placeholder draft can be given a real estimate before going public.
 */
export function setBuildTaskEstimate(db: Database.Database, taskId: string, e: { minMinutes: number; maxMinutes: number; budget?: string; contextSize?: string }): number {
  if (!Number.isInteger(e.minMinutes) || !Number.isInteger(e.maxMinutes) || e.minMinutes < 0 || e.maxMinutes < e.minMinutes || e.maxMinutes < 1) {
    throw new Error('estimated_duration must be integer minutes with max >= min and max >= 1 (a real, non-zero estimate)')
  }
  const budget = e.budget !== undefined ? assertEnum('estimated_agent_budget', e.budget, AGENT_BUDGETS) : null
  const context = e.contextSize !== undefined ? assertEnum('estimated_context_size', e.contextSize, CONTEXT_SIZES) : null
  const sets = ['estimated_duration_min_minutes = ?', 'estimated_duration_max_minutes = ?']
  const params: unknown[] = [e.minMinutes, e.maxMinutes]
  if (budget !== null) { sets.push('estimated_agent_budget = ?'); params.push(budget) }
  if (context !== null) { sets.push('estimated_context_size = ?'); params.push(context) }
  params.push(taskId)
  return db.prepare(`UPDATE build_task_agent_metadata SET ${sets.join(', ')} WHERE task_id = ?`).run(...params).changes
}
