/**
 * Task Proposal → Formal Task Draft (productization, human-gated).
 *
 * Turns a reviewed task proposal into an UNPUBLISHED formal build_task "draft", lets admins list drafts,
 * and PUBLISHES a draft into a normal open task — every state change an explicit human/admin action.
 *
 * Draft mechanism (reuse, no new status / no state-machine change): a draft is a real build_task
 * (status 'open') carrying agent_metadata with audience='internal' + auto_claimable=false. The existing
 * read layer hides internal tasks from the board and the participation guard blocks claiming them — so an
 * internal task is effectively an unpublished, unclaimable draft. PUBLISH = flip audience → 'public'.
 *
 * Boundaries: NO auto-publish (drafts are internal until an explicit publish), NO reward/credit/contribution
 * fact at draft creation, formal task still goes through the trusted createBuildTask path.
 *
 * Proposal status semantics (deliberate): creating a draft does NOT mark the proposal 'converted' — draft
 * creation is not contribution acceptance, so the proposal stays non-terminal. The source proposal ↔ draft
 * link is held in a lightweight `task_proposal_draft_links` row (preserving the proposer/admin chain). Only an
 * explicit human PUBLISH marks the proposal 'converted' (converted_ref=task id) — i.e. acceptance happens at
 * publish, when the work actually enters the board.
 */
import type Database from 'better-sqlite3'
import { createBuildTask, logTaskEvent, releaseExpiredClaims } from './build-tasks-engine.js'
import { insertBuildTaskAgentMetadata, getBuildTaskAgentMetadata, setBuildTaskAudience,
  type BuildTaskAgentMetadata, RISK_LEVELS, TASK_TYPES } from './build-task-agent-metadata-store.js'
import { reviewTaskProposal } from './task-proposal-store.js'

/** Source-proposal ↔ draft-task link (lets a draft preserve its origin WITHOUT marking the proposal terminal). */
export function initTaskProposalDraftLinkSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_proposal_draft_links (
    task_id      TEXT PRIMARY KEY,
    proposal_id  TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    discarded_by TEXT,
    discarded_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  // Additive migration for pre-existing DBs (ALTER after CREATE; fresh DBs already have these columns).
  // status = 'active' | 'discarded'. A discarded link is SOFT-deleted: the row is retained for provenance
  // (retroactive reward / anchor-side traceability / dispute), and it frees the proposal's draft slot.
  try {
    const cols = db.prepare('PRAGMA table_info(task_proposal_draft_links)').all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'status')) db.exec("ALTER TABLE task_proposal_draft_links ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    if (!cols.some(c => c.name === 'discarded_by')) db.exec('ALTER TABLE task_proposal_draft_links ADD COLUMN discarded_by TEXT')
    if (!cols.some(c => c.name === 'discarded_at')) db.exec('ALTER TABLE task_proposal_draft_links ADD COLUMN discarded_at TEXT')
  } catch { /* best-effort additive migration */ }
  // PARTIAL UNIQUE: at most one ACTIVE draft per proposal (discarded links are retained but excluded), so a
  // discarded draft truly frees the slot. Replaces the old full unique index on proposal_id.
  try { db.exec('DROP INDEX IF EXISTS idx_tpdl_proposal') } catch { /* noop */ }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tpdl_proposal_active ON task_proposal_draft_links(proposal_id) WHERE status = 'active'")
}

/**
 * case_id threads a case end to end: proposal → task → PR. For a task converted from a proposal it is that
 * source proposal id (so proposer + contributor + PR all quote the same id); for a directly-created task it
 * is the task id itself. Guarded: the link table may be absent in minimal setups → fall back to the task id.
 */
export function caseIdForTask(db: Database.Database, taskId: string): string {
  try {
    const link = db.prepare('SELECT proposal_id FROM task_proposal_draft_links WHERE task_id = ?').get(taskId) as { proposal_id: string } | undefined
    if (link?.proposal_id) return link.proposal_id
  } catch { /* link table absent → case_id is the task id */ }
  return taskId
}

type DraftArgs = {
  proposalId: string
  adminId: string
  title: string
  area?: string | null
  description?: string | null
  sourceRef?: string | null
  acceptanceCriteria?: string[]
  verificationCommands?: string[]
  deliverables?: string[]
  allowedPaths?: string[]
  forbiddenPaths?: string[]
  forbiddenActions?: string[]
  requiredCapabilities?: string[]
  definitionOfDone?: string | null
  expectedResults?: string | null
  autoClaimable?: boolean
  taskType?: string
  riskLevel?: string
  note?: string | null
}

const strList = (v: unknown): string[] => Array.isArray(v) ? v.slice(0, 50).map(s => String(s).slice(0, 500)).filter(s => s.trim()) : []
const txt = (v: string | null | undefined): string => (v ?? '').trim()

/** Handoff fields an executable agent task must carry. Returns the list of missing ones (empty = complete). */
function missingHandoff(f: {
  title: string; description: string; allowed_paths: string[]; prohibited_actions: string[]
  acceptance_criteria: string[]; verification_commands: string[]; deliverables: string[]
  expected_results: string; definition_of_done: string
}): string[] {
  const missing: string[] = []
  if (!txt(f.title)) missing.push('title')
  if (!txt(f.description)) missing.push('summary/description (reason)')
  if (f.allowed_paths.length === 0) missing.push('allowed_paths (execution boundary)')
  if (f.prohibited_actions.length === 0) missing.push('forbidden_actions')
  if (f.acceptance_criteria.length === 0) missing.push('acceptance_criteria')
  if (f.verification_commands.length === 0) missing.push('verification_commands')
  if (f.deliverables.length === 0) missing.push('deliverables')
  if (!txt(f.expected_results)) missing.push('expected_results')
  if (!txt(f.definition_of_done)) missing.push('definition_of_done')
  return missing
}

/**
 * Create an UNPUBLISHED draft (internal build_task) from a non-terminal proposal and record the
 * source-proposal ↔ draft link. Does NOT mark the proposal 'converted' (acceptance happens at publish).
 * Returns the new draft task id.
 */
export function createDraftFromProposal(db: Database.Database, a: DraftArgs):
  { draft_task_id: string } | { error: string; error_code: string; missing?: string[] } {
  // 1) proposal must exist + be non-terminal (only new / needs_info → draft). Pre-check before creating anything.
  const prop = db.prepare('SELECT id, status FROM task_proposals WHERE id = ?').get(a.proposalId) as { id: string; status: string } | undefined
  if (!prop) return { error: 'proposal not found', error_code: 'PROPOSAL_NOT_FOUND' }
  if (prop.status === 'rejected' || prop.status === 'converted') return { error: `proposal already ${prop.status}`, error_code: 'PROPOSAL_TERMINAL' }
  // one ACTIVE draft per proposal (a discarded draft is soft-deleted and frees the slot; not terminal-status based)
  const existingLink = db.prepare("SELECT task_id FROM task_proposal_draft_links WHERE proposal_id = ? AND status != 'discarded'").get(a.proposalId) as { task_id: string } | undefined
  if (existingLink) return { error: `a task draft already exists for this proposal (${existingLink.task_id})`, error_code: 'PROPOSAL_HAS_DRAFT' }

  // draft risk stays low/medium (high/critical metadata rules are out of scope for this PR)
  const riskLevel = (a.riskLevel === 'medium') ? 'medium' : 'low'
  if (a.riskLevel && !(RISK_LEVELS as readonly string[]).includes(a.riskLevel)) return { error: 'invalid risk_level', error_code: 'BAD_RISK_LEVEL' }
  if (a.riskLevel === 'high' || a.riskLevel === 'critical') return { error: 'draft risk_level must be low or medium (high/critical deferred)', error_code: 'RISK_TOO_HIGH_FOR_DRAFT' }
  const taskType = (a.taskType && (TASK_TYPES as readonly string[]).includes(a.taskType)) ? a.taskType : 'other'

  // 2) assemble the agent-handoff fields and VALIDATE completeness BEFORE creating anything — the existing
  //    task model requires these to be executable, so we never create an incomplete/orphan task.
  const allowed = strList(a.allowedPaths)
  const prohibited = strList(a.forbiddenActions)
  const accept = strList(a.acceptanceCriteria)
  const verify = strList(a.verificationCommands)
  const deliver = strList(a.deliverables)
  const description = txt(a.description)
  const dod = txt(a.definitionOfDone).slice(0, 1000)
  const expected = (txt(a.expectedResults) || description).slice(0, 1000)
  const missing = missingHandoff({ title: txt(a.title), description, allowed_paths: allowed, prohibited_actions: prohibited, acceptance_criteria: accept, verification_commands: verify, deliverables: deliver, expected_results: expected, definition_of_done: dod })
  if (missing.length > 0) return { error: `draft incomplete — provide: ${missing.join(', ')}`, error_code: 'DRAFT_INCOMPLETE', missing }

  // 3) create the formal task via the trusted path (creator = admin → accountability)
  const created = createBuildTask(db, { creatorId: a.adminId, title: a.title, area: a.area ?? undefined, description: a.description ?? undefined, rfcRef: a.sourceRef ?? undefined })
  if ('error' in created) return created as { error: string; error_code: string }
  const taskId = created.id

  // 4) attach agent_metadata as an INTERNAL draft (hidden + unclaimable via the existing read/participation
  //    guards). auto_claimable defaults TRUE so once published the task enters the normal agent claim flow
  //    (maintainer may opt human-only with autoClaimable:false). While audience='internal' it is unclaimable.
  const caps = strList(a.requiredCapabilities); if (caps.length === 0) caps.push('general')
  const meta: BuildTaskAgentMetadata = {
    task_type: taskType as BuildTaskAgentMetadata['task_type'],
    source_ref: a.sourceRef ?? null,
    allowed_paths: allowed,
    forbidden_paths: strList(a.forbiddenPaths),
    prohibited_actions: prohibited,
    risk_level: riskLevel as BuildTaskAgentMetadata['risk_level'],
    audience: 'internal',
    agent_autonomy: 'human_in_the_loop',
    auto_claimable: a.autoClaimable !== false,
    required_capabilities: caps,
    acceptance_criteria: accept,
    verification_commands: verify,
    expected_results: expected,
    deliverables: deliver,
    definition_of_done: dod,
    estimated_duration_min_minutes: 0,
    estimated_duration_max_minutes: 0,
    estimated_context_size: 'small',
    estimated_agent_budget: 'minimal',
    value_state: 'uncommitted',
    contribution_type: 'task',
    accountable_party_required: true,
  }
  insertBuildTaskAgentMetadata(db, taskId, meta)

  // 5) record the source-proposal ↔ draft link (accountability) — WITHOUT marking the proposal converted;
  //    the proposal stays non-terminal until an explicit human publish.
  db.prepare('INSERT INTO task_proposal_draft_links (task_id, proposal_id, created_by) VALUES (?,?,?)').run(taskId, a.proposalId, a.adminId)
  return { draft_task_id: taskId }
}

/** Admin list of UNPUBLISHED drafts (internal, open) + their source proposal id (via the draft-link table). */
export function listDraftBuildTasks(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT t.id, t.title, t.area, t.description, t.rfc_ref, t.status, t.created_by, t.created_at,
           m.risk_level, m.audience, m.auto_claimable,
           l.proposal_id AS source_proposal_id
    FROM build_tasks t
    JOIN build_task_agent_metadata m ON m.task_id = t.id
    LEFT JOIN task_proposal_draft_links l ON l.task_id = t.id
    WHERE m.audience = 'internal' AND t.status = 'open' AND (l.status IS NULL OR l.status != 'discarded')
    ORDER BY t.created_at DESC LIMIT 200
  `).all() as Array<Record<string, unknown>>
}

/**
 * Validate that a draft carries enough agent-handoff info to be executed by another participant's agent.
 * Returns the list of missing fields (empty = complete). Gate for publish — never publish an incomplete task.
 */
export function validateDraftForPublish(task: { title?: string | null; description?: string | null }, meta: BuildTaskAgentMetadata): string[] {
  return missingHandoff({
    title: txt(task.title), description: txt(task.description),
    allowed_paths: meta.allowed_paths ?? [], prohibited_actions: meta.prohibited_actions ?? [],
    acceptance_criteria: meta.acceptance_criteria ?? [], verification_commands: meta.verification_commands ?? [],
    deliverables: meta.deliverables ?? [], expected_results: txt(meta.expected_results), definition_of_done: txt(meta.definition_of_done),
  })
}

/**
 * PUBLISH a draft → audience 'public' (now on the board / claimable via the existing flow). Explicit
 * human/admin action only; validates agent-handoff completeness first (never publishes an incomplete task).
 * This is also where the source proposal is marked 'converted' (converted_ref=task id, reviewer=actor) —
 * acceptance happens at publish, not at draft creation. The canonical repo / PR target is the protocol-wide
 * canonical contribution target enforced by the existing submit path — it is not stored per-task.
 *
 * Evidence-chain guard: the linked proposal is validated BEFORE anything is published. If it was rejected (or
 * converted to a different task) since draft creation, publish is refused (409) and the task stays internal —
 * so a public, claimable task can never coexist with a rejected source proposal. The audience flip + proposal
 * conversion run in one transaction (both or neither).
 */
export function publishDraftBuildTask(db: Database.Database, taskId: string, adminId: string):
  { ok: true; task_id: string } | { error: string; error_code: string; missing?: string[] } {
  const meta = getBuildTaskAgentMetadata(db, taskId)
  if (!meta) return { error: 'task has no draft metadata', error_code: 'NOT_A_DRAFT' }
  if (meta.audience !== 'internal') return { error: 'task is not an internal draft', error_code: 'NOT_DRAFT_AUDIENCE' }
  const t = db.prepare('SELECT status, title, description FROM build_tasks WHERE id = ?').get(taskId) as { status: string; title: string; description: string | null } | undefined
  if (!t) return { error: 'task not found', error_code: 'NOT_FOUND' }
  const missing = validateDraftForPublish(t, meta as unknown as BuildTaskAgentMetadata)
  if (missing.length > 0) return { error: `draft incomplete — fill before publish: ${missing.join(', ')}`, error_code: 'DRAFT_INCOMPLETE', missing }

  // validate the linked proposal FIRST — do not publish on top of a rejected / elsewhere-converted proposal.
  const link = db.prepare('SELECT proposal_id, status FROM task_proposal_draft_links WHERE task_id = ?').get(taskId) as { proposal_id: string; status: string } | undefined
  let proposalToConvert: string | null = null
  if (link) {
    if (link.status === 'discarded') return { error: 'draft was discarded — cannot publish', error_code: 'DRAFT_DISCARDED' }
    const prop = db.prepare('SELECT status, converted_ref FROM task_proposals WHERE id = ?').get(link.proposal_id) as { status: string; converted_ref: string | null } | undefined
    if (prop) {
      if (prop.status === 'rejected') return { error: 'source proposal was rejected — cannot publish', error_code: 'PROPOSAL_REJECTED' }
      if (prop.status === 'converted' && prop.converted_ref !== taskId) return { error: 'source proposal already converted to a different task', error_code: 'PROPOSAL_CONVERTED_ELSEWHERE' }
      if (prop.status === 'new' || prop.status === 'needs_info') proposalToConvert = link.proposal_id
    }
  }

  // all validation passed → publish atomically: flip audience + (if applicable) mark the proposal converted.
  db.transaction(() => {
    setBuildTaskAudience(db, taskId, 'public')
    logTaskEvent(db, taskId, adminId, t.status, t.status, 'published from draft (audience → public)')
    if (proposalToConvert) {
      const rv = reviewTaskProposal(db, proposalToConvert, adminId, 'converted', `published as formal task ${taskId}`, taskId)
      if ('error' in rv) throw new Error(`proposal conversion failed: ${rv.code}`)   // rollback the audience flip
    }
  })()
  return { ok: true, task_id: taskId }
}

/**
 * DISCARD an unpublished internal draft — SOFT-delete (status='discarded'); the link row is RETAINED for
 * provenance (retroactive reward / anchor-side traceability / dispute). Discarding frees the proposal's draft
 * slot (createDraftFromProposal counts only non-discarded links), so a fresh draft can be created.
 *
 * Fail-closed: ONLY an internal, unpublished, unclaimed draft may be discarded. A published draft (audience
 * flipped to public), a claimed task, or an already-converted source proposal is REFUSED — discard never
 * touches anything that's live on the board or already accepted. Scope is discard only (NOT a generic edit).
 */
export function discardDraft(db: Database.Database, taskId: string, adminId: string):
  { ok: true; task_id: string; already_discarded?: boolean } | { error: string; error_code: string } {
  const link = db.prepare('SELECT proposal_id, status FROM task_proposal_draft_links WHERE task_id = ?').get(taskId) as { proposal_id: string; status: string } | undefined
  if (!link) return { error: 'no draft link for this task', error_code: 'NOT_FOUND' }
  if (link.status === 'discarded') return { ok: true, task_id: taskId, already_discarded: true }   // idempotent
  // fail-closed guards — only an internal, unpublished, unclaimed draft of a non-converted proposal
  const meta = getBuildTaskAgentMetadata(db, taskId)
  if (!meta) return { error: 'task has no draft metadata', error_code: 'NOT_A_DRAFT' }
  if (meta.audience !== 'internal') return { error: 'task is published (audience is not internal) — cannot discard', error_code: 'ALREADY_PUBLISHED' }
  const t = db.prepare('SELECT status, claimer_id FROM build_tasks WHERE id = ?').get(taskId) as { status: string; claimer_id: string | null } | undefined
  if (!t) return { error: 'task not found', error_code: 'NOT_FOUND' }
  if (t.claimer_id) return { error: 'task is claimed — cannot discard', error_code: 'DRAFT_CLAIMED' }
  const prop = db.prepare('SELECT status FROM task_proposals WHERE id = ?').get(link.proposal_id) as { status: string } | undefined
  if (prop && prop.status === 'converted') return { error: 'source proposal already converted — cannot discard', error_code: 'ALREADY_CONVERTED' }
  db.prepare("UPDATE task_proposal_draft_links SET status = 'discarded', discarded_by = ?, discarded_at = datetime('now') WHERE task_id = ?").run(adminId, taskId)
  return { ok: true, task_id: taskId }
}

/**
 * Full stored body of an UNPUBLISHED internal draft — for pre-publish PREVIEW so a maintainer publishes
 * against the exact content that will go live (not a blind button). Returns null unless the task is an
 * internal-audience draft (getBuildTaskWithAgentMetadata's member/public scopes deliberately hide internal,
 * so this admin-only read exists). Read-only — does not change publish behavior.
 */
export function getDraftBuildTaskDetail(db: Database.Database, taskId: string): Record<string, unknown> | null {
  const meta = getBuildTaskAgentMetadata(db, taskId)
  if (!meta || meta.audience !== 'internal') return null   // only unpublished internal drafts are previewable here
  const t = db.prepare('SELECT id, title, area, description, rfc_ref, status, created_by, created_at FROM build_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!t) return null
  const link = db.prepare('SELECT proposal_id, status FROM task_proposal_draft_links WHERE task_id = ?').get(taskId) as { proposal_id: string; status: string } | undefined
  return {
    ...t,
    source_proposal_id: link?.proposal_id ?? null,
    draft_link_status: link?.status ?? null,
    agent_metadata: meta,   // full body: allowed/forbidden paths, prohibited_actions, acceptance_criteria, verification_commands, deliverables, definition_of_done, expected_results, risk_level, auto_claimable, …
  }
}

/**
 * Recovery: WITHDRAW a published task that was converted from a proposal — pull it off the public board and
 * REOPEN the source proposal so a corrected draft can be built. Fail-closed: only an UNCLAIMED, open,
 * published task (audience='public') may be withdrawn (a claimed / in_review / done task is refused).
 *
 * Soft-delete semantics (provenance retained): the build_task is set status='abandoned' (off the board, row
 * kept), the draft link is marked 'discarded' (kept, frees the slot), and the proposal is un-converted
 * (status='new', converted_ref cleared) so createDraftFromProposal works again. Scope = recovery only.
 */
export function withdrawPublishedTask(db: Database.Database, taskId: string, adminId: string):
  { ok: true; task_id: string; reopened_proposal_id: string | null } | { error: string; error_code: string } {
  releaseExpiredClaims(db)   // an expired claim is effectively unclaimed
  const meta = getBuildTaskAgentMetadata(db, taskId)
  if (!meta) return { error: 'task not found', error_code: 'NOT_FOUND' }
  if (meta.audience !== 'public') return { error: 'task is not published (use discard for an internal draft)', error_code: 'NOT_PUBLISHED' }
  const t = db.prepare('SELECT status, claimer_id FROM build_tasks WHERE id = ?').get(taskId) as { status: string; claimer_id: string | null } | undefined
  if (!t) return { error: 'task not found', error_code: 'NOT_FOUND' }
  if (t.claimer_id || t.status !== 'open') return { error: `task is ${t.status}${t.claimer_id ? ' (claimed)' : ''} — only an UNCLAIMED open task can be withdrawn`, error_code: 'TASK_CLAIMED' }
  const link = db.prepare('SELECT proposal_id, status FROM task_proposal_draft_links WHERE task_id = ?').get(taskId) as { proposal_id: string; status: string } | undefined
  let reopened: string | null = null
  db.transaction(() => {
    db.prepare("UPDATE build_tasks SET status = 'abandoned', updated_at = datetime('now') WHERE id = ?").run(taskId)
    logTaskEvent(db, taskId, adminId, t.status, 'abandoned', 'withdrawn by admin — published task pulled off the board (recovery)')
    if (link) {
      if (link.status !== 'discarded') db.prepare("UPDATE task_proposal_draft_links SET status = 'discarded', discarded_by = ?, discarded_at = datetime('now') WHERE task_id = ?").run(adminId, taskId)
      const prop = db.prepare('SELECT status, converted_ref FROM task_proposals WHERE id = ?').get(link.proposal_id) as { status: string; converted_ref: string | null } | undefined
      if (prop && prop.status === 'converted' && prop.converted_ref === taskId) {
        db.prepare("UPDATE task_proposals SET status = 'new', converted_ref = NULL, reviewer_id = NULL, review_note = ?, updated_at = datetime('now') WHERE id = ?")
          .run(`reopened: published task ${taskId} withdrawn by admin`, link.proposal_id)
        reopened = link.proposal_id
      }
    }
  })()
  return { ok: true, task_id: taskId, reopened_proposal_id: reopened }
}
