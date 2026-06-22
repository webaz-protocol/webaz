/**
 * build_task quota-increase requests (PR #18) — non-root maintainers / contributors who hit the
 * per-user create cap (CREATE_RATE_PER_DAY in build-tasks-engine.ts) request extra headroom; a ROOT
 * admin approves a time-boxed, counted grant. Root admins are exempt from the cap and never need this.
 *
 * Single-table model (build_task_quota_requests): one row carries the request AND, once approved, the
 * grant (granted_count / consumed_count / expires_at). Immutable history lives in build_task_quota_events.
 *
 * Status machine: pending → approved → (exhausted | expired) | rejected ; approved → revoked (root).
 *   - exhausted is also derivable (consumed_count >= granted_count) but stored so it is set
 *     transactionally together with the consuming INSERT.
 * Constraint: at most ONE pending request per requester per quota_type (partial unique index).
 *
 * Consumption (consumeQuotaForCreate) is called INSIDE createBuildTask's db.transaction so a unit is
 * spent atomically with the task INSERT — failed validation / failed INSERT never consumes quota.
 * Fail-closed everywhere: a missing table / bad lookup yields "no grant" (caller stays rate-limited),
 * never a thrown 500.
 *
 * 关联:RFC-006 build-tasks-engine.ts / PR #17 root-admin exemption / routes/build-task-quota.ts
 */
import type Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'

export const QUOTA_TYPE_BUILD_TASK_CREATE = 'build_task.create'
export const QUOTA_TYPES = new Set([QUOTA_TYPE_BUILD_TASK_CREATE])
export const URGENCIES = new Set(['low', 'normal', 'high'])

// fallbacks when protocol_params is absent — kept in sync with DEFAULT_PARAMS in server.ts
const DEFAULT_MAX_EXTRA_COUNT = 50
const DEFAULT_MAX_DURATION_HOURS = 72
const REASON_MIN = 5
const REASON_MAX = 2000
const MAX_LINKED_REFS = 20
const REF_MAX_LEN = 200

type Req = Record<string, unknown>
type Err = { error: string; error_code: string }
const isErr = (x: unknown): x is Err => !!x && typeof x === 'object' && 'error' in (x as object)

function paramNum(db: Database.Database, key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(key) as { value?: string } | undefined
    if (!row || row.value == null) return fallback
    const n = Number(row.value)
    return Number.isFinite(n) ? n : fallback
  } catch { return fallback }
}
export const maxQuotaExtraCount = (db: Database.Database): number => paramNum(db, 'max_quota_extra_count', DEFAULT_MAX_EXTRA_COUNT)
export const maxQuotaDurationHours = (db: Database.Database): number => paramNum(db, 'max_quota_duration_hours', DEFAULT_MAX_DURATION_HOURS)

export function initBuildTaskQuotaSchema(db: Database.Database): void {
  // requests + grant (single row); status drives the lifecycle
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_task_quota_requests (
      id                       TEXT PRIMARY KEY,
      quota_type               TEXT NOT NULL DEFAULT 'build_task.create',
      requester_user_id        TEXT NOT NULL,
      requested_extra_count    INTEGER NOT NULL,
      reason                   TEXT NOT NULL,
      linked_refs              TEXT,                                  -- JSON array of strings
      urgency                  TEXT NOT NULL DEFAULT 'normal',        -- low | normal | high
      requested_duration_hours INTEGER,
      requested_expires_at     TEXT,
      status                   TEXT NOT NULL DEFAULT 'pending',       -- pending|approved|rejected|expired|exhausted|revoked
      decided_at               TEXT,
      decided_by               TEXT,
      decision_note            TEXT,
      granted_count            INTEGER,
      consumed_count           INTEGER NOT NULL DEFAULT 0,
      expires_at               TEXT,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bqr_status ON build_task_quota_requests(status, updated_at DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bqr_requester ON build_task_quota_requests(requester_user_id, status)`)
  // at most one PENDING request per requester per quota type (a decided one frees the slot)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bqr_one_pending ON build_task_quota_requests(requester_user_id, quota_type) WHERE status = 'pending'`)

  // immutable audit/event history (append-only)
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_task_quota_events (
      id          TEXT PRIMARY KEY,
      request_id  TEXT NOT NULL,
      actor_id    TEXT,
      action      TEXT NOT NULL,   -- request_created|request_approved|request_rejected|grant_consumed|grant_expired|request_revoked
      detail      TEXT,            -- JSON
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bqe_request ON build_task_quota_events(request_id, created_at)`)
}

export function logQuotaEvent(db: Database.Database, requestId: string, actorId: string | null, action: string, detail?: Record<string, unknown> | null): void {
  db.prepare(`INSERT INTO build_task_quota_events (id, request_id, actor_id, action, detail) VALUES (?,?,?,?,?)`)
    .run(generateId('bqev'), requestId, actorId, action, detail ? JSON.stringify(detail) : null)
}

function parseRefs(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : []
  return arr.map(r => String(r ?? '').trim()).filter(Boolean).slice(0, MAX_LINKED_REFS).map(r => r.slice(0, REF_MAX_LEN))
}

/** Lazily flip approved grants whose window has passed to 'expired' (audited). Best-effort, fail-closed. */
export function expireStaleGrants(db: Database.Database): void {
  try {
    const stale = db.prepare(
      `SELECT id FROM build_task_quota_requests
       WHERE status = 'approved' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`
    ).all() as Array<{ id: string }>
    for (const s of stale) {
      db.prepare(`UPDATE build_task_quota_requests SET status='expired', updated_at=datetime('now') WHERE id = ? AND status='approved'`).run(s.id)
      logQuotaEvent(db, s.id, null, 'grant_expired', null)
    }
  } catch { /* table missing / fresh DB — nothing to expire */ }
}

export type CreateRequestInput = {
  requesterId: string
  requestedExtraCount: number
  reason: string
  linkedRefs?: unknown
  urgency?: string
  requestedDurationHours?: number | null
  quotaType?: string
}

export function createQuotaRequest(db: Database.Database, a: CreateRequestInput): { id: string; status: 'pending' } | Err {
  const quotaType = a.quotaType && QUOTA_TYPES.has(a.quotaType) ? a.quotaType : QUOTA_TYPE_BUILD_TASK_CREATE
  if (a.quotaType && !QUOTA_TYPES.has(a.quotaType)) return { error: 'unknown quota_type', error_code: 'BAD_QUOTA_TYPE' }
  if (!a.requesterId) return { error: 'requester required', error_code: 'REQUESTER_REQUIRED' }

  const count = Math.trunc(Number(a.requestedExtraCount))
  if (!Number.isFinite(count) || count <= 0) return { error: 'requested_extra_count must be a positive integer', error_code: 'BAD_COUNT' }
  const maxCount = maxQuotaExtraCount(db)
  if (count > maxCount) return { error: `requested_extra_count exceeds the max (${maxCount})`, error_code: 'COUNT_TOO_LARGE' }

  const reason = String(a.reason ?? '').trim()
  if (reason.length < REASON_MIN) return { error: `reason is required (>= ${REASON_MIN} chars)`, error_code: 'REASON_REQUIRED' }
  const reasonClamped = reason.slice(0, REASON_MAX)

  const urgency = a.urgency && URGENCIES.has(a.urgency) ? a.urgency : 'normal'
  if (a.urgency && !URGENCIES.has(a.urgency)) return { error: 'bad urgency', error_code: 'BAD_URGENCY' }

  const maxDur = maxQuotaDurationHours(db)
  let durationHours: number | null = null
  if (a.requestedDurationHours != null) {
    durationHours = Math.trunc(Number(a.requestedDurationHours))
    if (!Number.isFinite(durationHours) || durationHours <= 0) return { error: 'requested_duration_hours must be a positive integer', error_code: 'BAD_DURATION' }
    if (durationHours > maxDur) return { error: `requested_duration_hours exceeds the max (${maxDur})`, error_code: 'DURATION_TOO_LARGE' }
  }

  const refs = JSON.stringify(parseRefs(a.linkedRefs))
  const id = generateId('bqr')
  try {
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO build_task_quota_requests
           (id, quota_type, requester_user_id, requested_extra_count, reason, linked_refs, urgency, requested_duration_hours, requested_expires_at, status)
         VALUES (?,?,?,?,?,?,?,?, ${durationHours != null ? `datetime('now','+${durationHours} hours')` : 'NULL'}, 'pending')`
      ).run(id, quotaType, a.requesterId, count, reasonClamped, refs, urgency, durationHours)
      logQuotaEvent(db, id, a.requesterId, 'request_created', { quota_type: quotaType, requested_extra_count: count, urgency })
    })
    tx()
  } catch (e) {
    // partial unique index → an open pending request already exists
    if (String((e as Error).message || '').includes('idx_bqr_one_pending') || String((e as Error).message || '').toUpperCase().includes('UNIQUE'))
      return { error: 'you already have a pending quota request of this type', error_code: 'ALREADY_PENDING' }
    return { error: 'failed to create quota request', error_code: 'CREATE_FAILED' }
  }
  return { id, status: 'pending' }
}

export function getQuotaRequest(db: Database.Database, id: string): Req | undefined {
  expireStaleGrants(db)
  return db.prepare('SELECT * FROM build_task_quota_requests WHERE id = ?').get(id) as Req | undefined
}

export function listMyQuotaRequests(db: Database.Database, userId: string): Req[] {
  expireStaleGrants(db)
  return db.prepare('SELECT * FROM build_task_quota_requests WHERE requester_user_id = ? ORDER BY created_at DESC LIMIT 200').all(userId) as Req[]
}

export function listQuotaRequests(db: Database.Database, f: { status?: string } = {}): Req[] {
  expireStaleGrants(db)
  if (f.status) return db.prepare('SELECT * FROM build_task_quota_requests WHERE status = ? ORDER BY created_at DESC LIMIT 500').all(f.status) as Req[]
  return db.prepare('SELECT * FROM build_task_quota_requests ORDER BY created_at DESC LIMIT 500').all() as Req[]
}

/** Requester's create count over the trailing 24h — context for the root reviewer. */
export function requesterUsage24h(db: Database.Database, userId: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM build_tasks WHERE created_by = ? AND created_at > datetime('now','-1 day')`).get(userId) as { n: number }).n
  } catch { return 0 }
}

export type ApproveInput = { grantedCount?: number; durationHours?: number; expiresAt?: string; decisionNote?: string }

export function approveQuotaRequest(db: Database.Database, id: string, approverId: string, a: ApproveInput = {}): { ok: true; id: string; granted_count: number; expires_at: string | null } | Err {
  if (!approverId) return { error: 'approver required', error_code: 'APPROVER_REQUIRED' }
  expireStaleGrants(db)
  let result: { ok: true; id: string; granted_count: number; expires_at: string | null } | Err = { error: 'unknown', error_code: 'UNKNOWN' }
  try {
    db.transaction(() => {
      const r = db.prepare('SELECT * FROM build_task_quota_requests WHERE id = ?').get(id) as Req | undefined
      if (!r) { result = { error: 'request not found', error_code: 'NOT_FOUND' }; return }
      if (r.status !== 'pending') { result = { error: `request is ${String(r.status)}, not pending`, error_code: 'BAD_STATE' }; return }
      if (String(r.requester_user_id) === approverId) { result = { error: 'cannot decide your own quota request', error_code: 'SELF_DECISION' }; return }

      const maxCount = maxQuotaExtraCount(db)
      let granted = a.grantedCount != null ? Math.trunc(Number(a.grantedCount)) : Number(r.requested_extra_count)
      if (!Number.isFinite(granted) || granted <= 0) { result = { error: 'granted count must be a positive integer', error_code: 'BAD_COUNT' }; return }
      if (granted > maxCount) { result = { error: `granted count exceeds the max (${maxCount})`, error_code: 'COUNT_TOO_LARGE' }; return }

      const maxDur = maxQuotaDurationHours(db)
      // prefer an explicit duration; else fall back to the requested duration; else the max
      let durationHours = a.durationHours != null ? Math.trunc(Number(a.durationHours))
        : (r.requested_duration_hours != null ? Number(r.requested_duration_hours) : maxDur)
      if (!Number.isFinite(durationHours) || durationHours <= 0) { result = { error: 'duration must be a positive integer', error_code: 'BAD_DURATION' }; return }
      if (durationHours > maxDur) { result = { error: `duration exceeds the max (${maxDur})`, error_code: 'DURATION_TOO_LARGE' }; return }

      // compute the grant window. An explicit ISO expiresAt is normalized + range-checked via SQL.
      if (a.expiresAt) {
        const okFuture = db.prepare(`SELECT datetime(?) AS e, datetime('now') AS now, datetime('now','+${maxDur} hours') AS maxe`).get(a.expiresAt) as { e: string | null; now: string; maxe: string }
        if (!okFuture.e) { result = { error: 'bad expires_at', error_code: 'BAD_EXPIRES_AT' }; return }
        if (okFuture.e <= okFuture.now) { result = { error: 'expires_at must be in the future', error_code: 'EXPIRES_IN_PAST' }; return }
        if (okFuture.e > okFuture.maxe) { result = { error: `expires_at exceeds the max window (${maxDur}h)`, error_code: 'EXPIRES_TOO_FAR' }; return }
        db.prepare(`UPDATE build_task_quota_requests
          SET status='approved', decided_at=datetime('now'), decided_by=?, decision_note=?, granted_count=?, consumed_count=0, expires_at=datetime(?), updated_at=datetime('now')
          WHERE id = ?`).run(approverId, a.decisionNote ?? null, granted, a.expiresAt, id)
      } else {
        db.prepare(`UPDATE build_task_quota_requests
          SET status='approved', decided_at=datetime('now'), decided_by=?, decision_note=?, granted_count=?, consumed_count=0, expires_at=datetime('now','+${durationHours} hours'), updated_at=datetime('now')
          WHERE id = ?`).run(approverId, a.decisionNote ?? null, granted, id)
      }
      const after = db.prepare('SELECT expires_at FROM build_task_quota_requests WHERE id = ?').get(id) as { expires_at: string | null }
      logQuotaEvent(db, id, approverId, 'request_approved', { granted_count: granted, expires_at: after.expires_at, decision_note: a.decisionNote ?? null })
      result = { ok: true, id, granted_count: granted, expires_at: after.expires_at }
    })()
  } catch {
    return { error: 'failed to approve quota request', error_code: 'APPROVE_FAILED' }
  }
  return result
}

export function rejectQuotaRequest(db: Database.Database, id: string, approverId: string, a: { decisionNote?: string } = {}): { ok: true; id: string } | Err {
  if (!approverId) return { error: 'approver required', error_code: 'APPROVER_REQUIRED' }
  let result: { ok: true; id: string } | Err = { error: 'unknown', error_code: 'UNKNOWN' }
  try {
    db.transaction(() => {
      const r = db.prepare('SELECT * FROM build_task_quota_requests WHERE id = ?').get(id) as Req | undefined
      if (!r) { result = { error: 'request not found', error_code: 'NOT_FOUND' }; return }
      if (r.status !== 'pending') { result = { error: `request is ${String(r.status)}, not pending`, error_code: 'BAD_STATE' }; return }
      if (String(r.requester_user_id) === approverId) { result = { error: 'cannot decide your own quota request', error_code: 'SELF_DECISION' }; return }
      db.prepare(`UPDATE build_task_quota_requests SET status='rejected', decided_at=datetime('now'), decided_by=?, decision_note=?, updated_at=datetime('now') WHERE id = ?`)
        .run(approverId, a.decisionNote ?? null, id)
      logQuotaEvent(db, id, approverId, 'request_rejected', { decision_note: a.decisionNote ?? null })
      result = { ok: true, id }
    })()
  } catch {
    return { error: 'failed to reject quota request', error_code: 'REJECT_FAILED' }
  }
  return result
}

export function revokeQuotaRequest(db: Database.Database, id: string, approverId: string, a: { decisionNote?: string } = {}): { ok: true; id: string } | Err {
  if (!approverId) return { error: 'approver required', error_code: 'APPROVER_REQUIRED' }
  let result: { ok: true; id: string } | Err = { error: 'unknown', error_code: 'UNKNOWN' }
  try {
    db.transaction(() => {
      const r = db.prepare('SELECT * FROM build_task_quota_requests WHERE id = ?').get(id) as Req | undefined
      if (!r) { result = { error: 'request not found', error_code: 'NOT_FOUND' }; return }
      if (r.status !== 'approved') { result = { error: `request is ${String(r.status)}, not an active grant`, error_code: 'BAD_STATE' }; return }
      db.prepare(`UPDATE build_task_quota_requests SET status='revoked', decision_note=COALESCE(?, decision_note), updated_at=datetime('now') WHERE id = ?`)
        .run(a.decisionNote ?? null, id)
      logQuotaEvent(db, id, approverId, 'request_revoked', { decision_note: a.decisionNote ?? null })
      result = { ok: true, id }
    })()
  } catch {
    return { error: 'failed to revoke quota grant', error_code: 'REVOKE_FAILED' }
  }
  return result
}

/**
 * Consume ONE unit from the oldest still-valid grant for (user, quota_type). MUST be called inside the
 * caller's db.transaction so the unit is spent atomically with the task INSERT. Returns the grant id +
 * remaining units on success, or null when no valid grant exists (caller then stays rate-limited).
 * Fail-closed: any error (e.g. missing table) returns null. Expired grants are flipped + skipped.
 */
export function consumeQuotaForCreate(db: Database.Database, userId: string, quotaType: string = QUOTA_TYPE_BUILD_TASK_CREATE): { requestId: string; remaining: number } | null {
  try {
    // lazily expire stale grants for this user first (audited)
    const stale = db.prepare(
      `SELECT id FROM build_task_quota_requests
       WHERE requester_user_id = ? AND quota_type = ? AND status='approved'
         AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`
    ).all(userId, quotaType) as Array<{ id: string }>
    for (const s of stale) {
      db.prepare(`UPDATE build_task_quota_requests SET status='expired', updated_at=datetime('now') WHERE id = ? AND status='approved'`).run(s.id)
      logQuotaEvent(db, s.id, null, 'grant_expired', null)
    }

    const g = db.prepare(
      `SELECT id, granted_count, consumed_count FROM build_task_quota_requests
       WHERE requester_user_id = ? AND quota_type = ? AND status='approved'
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
         AND consumed_count < granted_count
       ORDER BY datetime(expires_at) ASC, created_at ASC
       LIMIT 1`
    ).get(userId, quotaType) as { id: string; granted_count: number; consumed_count: number } | undefined
    if (!g) return null

    const newConsumed = Number(g.consumed_count) + 1
    const exhausted = newConsumed >= Number(g.granted_count)
    db.prepare(`UPDATE build_task_quota_requests SET consumed_count = ?, status = ?, updated_at=datetime('now') WHERE id = ?`)
      .run(newConsumed, exhausted ? 'exhausted' : 'approved', g.id)
    logQuotaEvent(db, g.id, userId, 'grant_consumed', { consumed_count: newConsumed, granted_count: g.granted_count, exhausted })
    return { requestId: g.id, remaining: Number(g.granted_count) - newConsumed }
  } catch { return null }
}

/** Total remaining (unexpired, unexhausted) units across a user's active grants — for the UI affordance. */
export function remainingQuota(db: Database.Database, userId: string, quotaType: string = QUOTA_TYPE_BUILD_TASK_CREATE): number {
  try {
    expireStaleGrants(db)
    const row = db.prepare(
      `SELECT COALESCE(SUM(granted_count - consumed_count), 0) AS rem FROM build_task_quota_requests
       WHERE requester_user_id = ? AND quota_type = ? AND status='approved'
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
         AND consumed_count < granted_count`
    ).get(userId, quotaType) as { rem: number }
    return Number(row.rem) || 0
  } catch { return 0 }
}

export { isErr as isQuotaError }
