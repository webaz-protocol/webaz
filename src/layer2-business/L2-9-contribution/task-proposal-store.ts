/**
 * Task Proposal Inbox v1 — SCHEMA + STORE. A low-friction "suggest a task" inbox for strangers / agents.
 *
 * A proposal is a SUGGESTION, not a contribution record / reward / score / formal participation. It does
 * NOT become a build_task and NEVER appears on the public task board; a maintainer reviews it
 * (needs_info / rejected / converted) and only later, manually, turns an approved one into an agent-ready
 * build_task (PR9B/9C) — there is NO auto-conversion here (a high-risk/money/admin/secret suggestion can
 * only ever stop at review). `source_ref` is a reference only; the canonical contribution target stays in
 * trusted config. All value is uncommitted (RFC-017 I-12). Additive table; the RFC-006 build_tasks flow
 * and #329/#330 task-board behavior are untouched.
 *
 * EVIDENCE-CHAIN principle (no reward/score implemented here): a proposal by itself is NOT a contribution
 * fact. But once a maintainer marks it `converted` and links it (`converted_ref`) to a real task / PR /
 * release / product decision, the chain { proposer → reviewer → converted_ref } MAY later be read by a
 * future system as **non-code contribution evidence**. This PR only RECORDS that chain — it computes no
 * reward, score, or economic value.
 *
 * NB: the SQL string carries NO inline `--` comments (gen-pg-schema strips them → trailing whitespace).
 */
import type Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'

export const PROPOSAL_STATUSES = ['new', 'needs_info', 'rejected', 'converted'] as const
export const REVIEW_TARGETS = ['needs_info', 'rejected', 'converted'] as const   // 'new' is the initial state only

const TITLE_MIN = 3, TITLE_MAX = 200, SUMMARY_MAX = 2000, AREA_MAX = 64, OUTCOME_MAX = 2000, SOURCE_MAX = 500, LOGIN_MAX = 100, NOTE_MAX = 2000, CONVERTED_REF_MAX = 500

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS task_proposals (
    id                    TEXT PRIMARY KEY,
    title                 TEXT NOT NULL CHECK (length(trim(title)) >= 3 AND length(title) <= 200),
    summary               TEXT NOT NULL CHECK (length(trim(summary)) >= 1 AND length(summary) <= 2000),
    suggested_area        TEXT CHECK (suggested_area IS NULL OR length(suggested_area) <= 64),
    expected_outcome      TEXT CHECK (expected_outcome IS NULL OR length(expected_outcome) <= 2000),
    source_ref            TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 500),
    proposer_account_id   TEXT,
    proposer_github_login TEXT CHECK (proposer_github_login IS NULL OR length(proposer_github_login) <= 100),
    status                TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','needs_info','rejected','converted')),
    reviewer_id           TEXT,
    review_note           TEXT CHECK (review_note IS NULL OR length(review_note) <= 2000),
    converted_ref         TEXT CHECK (converted_ref IS NULL OR length(converted_ref) <= 500),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  )
`
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_task_proposals_status ON task_proposals(status, created_at DESC)`

export function initTaskProposalSchema(db: Database.Database): void {
  db.exec(CREATE_TABLE)
  db.exec(CREATE_INDEX)
}

export interface ProposalInput {
  title: string
  summary: string
  suggested_area?: string | null
  expected_outcome?: string | null
  source_ref?: string | null
  proposer_github_login?: string | null
}

/** Validate a public submission — fail-closed: bad/oversized fields are rejected, never silently truncated. */
export function validateProposalInput(body: unknown): { ok: true; input: ProposalInput } | { ok: false; code: string; message: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const bad = (code: string, message: string) => ({ ok: false as const, code, message })
  const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : '__invalid__')

  const titleRaw = asStr(b.title); if (titleRaw === '__invalid__') return bad('INVALID_TITLE', 'title must be a string')
  const title = (titleRaw ?? '').trim()
  if (title.length < TITLE_MIN) return bad('TITLE_TOO_SHORT', `title must be at least ${TITLE_MIN} chars`)
  if (title.length > TITLE_MAX) return bad('TITLE_TOO_LONG', `title must be at most ${TITLE_MAX} chars`)

  const summaryRaw = asStr(b.summary ?? b.reason); if (summaryRaw === '__invalid__') return bad('INVALID_SUMMARY', 'summary must be a string')
  const summary = (summaryRaw ?? '').trim()
  if (summary.length < 1) return bad('SUMMARY_REQUIRED', 'summary (reason) is required')
  if (summary.length > SUMMARY_MAX) return bad('SUMMARY_TOO_LONG', `summary must be at most ${SUMMARY_MAX} chars`)

  const optLen = (v: unknown, max: number, code: string): string | null | { code: string } => {
    if (v == null) return null
    if (typeof v !== 'string') return { code }
    if (v.length > max) return { code }
    return v
  }
  const area = optLen(b.suggested_area, AREA_MAX, 'SUGGESTED_AREA_TOO_LONG'); if (area && typeof area === 'object') return bad(area.code, 'suggested_area invalid/too long')
  const outcome = optLen(b.expected_outcome, OUTCOME_MAX, 'EXPECTED_OUTCOME_TOO_LONG'); if (outcome && typeof outcome === 'object') return bad(outcome.code, 'expected_outcome invalid/too long')
  const source = optLen(b.source_ref, SOURCE_MAX, 'SOURCE_REF_TOO_LONG'); if (source && typeof source === 'object') return bad(source.code, 'source_ref invalid/too long')
  const login = optLen(b.proposer_github_login, LOGIN_MAX, 'GITHUB_LOGIN_TOO_LONG'); if (login && typeof login === 'object') return bad(login.code, 'proposer_github_login invalid/too long')

  return { ok: true, input: { title, summary, suggested_area: area as string | null, expected_outcome: outcome as string | null, source_ref: source as string | null, proposer_github_login: login as string | null } }
}

const DEDUP_WINDOW = '-1 hours'   // SQLite datetime modifier — a recent-window duplicate guard

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Insert a new proposal (status='new'). proposer_account_id is NEVER taken from the body (anti-spoof).
 * Dedup (anti-flood): if an identical proposal already exists in the recent window — same non-empty
 * `source_ref`, OR same (title, summary) — NO new row is inserted; returns `{ duplicate, existing_id }`.
 */
export function insertTaskProposal(db: Database.Database, input: ProposalInput, proposerAccountId: string | null = null): { id: string; status: string } | { duplicate: true; existing_id: string } {
  const src = input.source_ref ?? null
  const dup = db.prepare(`SELECT id FROM task_proposals
    WHERE created_at > datetime('now', ?)
      AND (((? IS NOT NULL) AND source_ref = ?) OR (title = ? AND summary = ?))
    ORDER BY created_at DESC LIMIT 1`).get(DEDUP_WINDOW, src, src, input.title, input.summary) as { id: string } | undefined
  if (dup) return { duplicate: true, existing_id: dup.id }

  const id = generateId('tp')
  db.prepare(`INSERT INTO task_proposals (id, title, summary, suggested_area, expected_outcome, source_ref, proposer_account_id, proposer_github_login, status)
    VALUES (@id, @title, @summary, @suggested_area, @expected_outcome, @source_ref, @proposer_account_id, @proposer_github_login, 'new')`).run({
    id, title: input.title, summary: input.summary,
    suggested_area: input.suggested_area ?? null, expected_outcome: input.expected_outcome ?? null,
    source_ref: src, proposer_account_id: proposerAccountId,
    proposer_github_login: input.proposer_github_login ?? null,
  })
  return { id, status: 'new' }
}

export function listTaskProposals(db: Database.Database, filter: { status?: string } = {}): Array<Record<string, unknown>> {
  const where: string[] = []; const params: unknown[] = []
  if (filter.status && (PROPOSAL_STATUSES as readonly string[]).includes(filter.status)) { where.push('status = ?'); params.push(filter.status) }
  return db.prepare(`SELECT id, title, summary, suggested_area, expected_outcome, source_ref, proposer_account_id,
    proposer_github_login, status, reviewer_id, review_note, converted_ref, created_at, updated_at FROM task_proposals
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`).all(...params) as any[]
}

/**
 * Review a proposal: needs_info / rejected / converted. NO build_task is created here (conversion is a
 * later manual maintainer step — deferred). Terminal states (rejected/converted) cannot be re-reviewed.
 * `convertedRef` (only meaningful for `converted`) records the link to the real task / PR / release /
 * product decision — the non-code contribution evidence chain { proposer → reviewer → converted_ref }.
 * Recording only; no reward/score is computed.
 */
export function reviewTaskProposal(db: Database.Database, id: string, reviewerId: string, status: string, note?: string, convertedRef?: string | null):
  { id: string; status: string; converted_ref: string | null } | { error: string; code: string } {
  if (!(REVIEW_TARGETS as readonly string[]).includes(status)) return { error: 'status must be needs_info | rejected | converted', code: 'BAD_STATUS' }
  if (convertedRef != null && (typeof convertedRef !== 'string' || convertedRef.length > CONVERTED_REF_MAX)) return { error: 'converted_ref invalid/too long', code: 'CONVERTED_REF_TOO_LONG' }
  const cur = db.prepare('SELECT status FROM task_proposals WHERE id = ?').get(id) as { status: string } | undefined
  if (!cur) return { error: 'proposal not found', code: 'NOT_FOUND' }
  if (cur.status === 'rejected' || cur.status === 'converted') return { error: `proposal already ${cur.status}`, code: 'ALREADY_TERMINAL' }
  const ref = status === 'converted' && typeof convertedRef === 'string' && convertedRef.trim() ? convertedRef.trim() : null
  db.prepare(`UPDATE task_proposals SET status = ?, reviewer_id = ?, review_note = ?, converted_ref = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, reviewerId, note ? String(note).slice(0, NOTE_MAX) : null, ref, id)
  return { id, status, converted_ref: ref }
}
