/**
 * build_tasks engine (RFC-006 — Gap 1: coordination layer) — "who's doing what".
 *
 * 协调层:防止 N 个贡献者各改各的撞车。RFC 管【大改动先对齐】,这张表管【日常小改动的认领】。
 * 状态机:open → claimed → in_review → done | abandoned
 *   - claimed 有 TTL(claim_expires_at),过期自动回 open(防"占坑不做")。
 *   - in_review 有 PR,不自动释放。
 *   - done / abandoned = 验收终态,**只由 admin/maintainer 置**(验收=真人,RFC-006 不变量 2)。
 *
 * 边界(RFC-006):本层只【协调 + 记录】,不发奖励、不改信誉、不 merge。
 *   贡献被采纳记入 build_reputation 是 stage 3/4 的事(独立池),本文件不碰。
 * provenance = 自报(human | ai_assisted | ai_authored),问责而非检测。
 *
 * 关联:RFC-006 / MCP webaz_contribute(双模)/ routes/build-tasks.ts
 */
import type Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { creditBuildReputation, BUILD_POINTS } from './build-reputation-engine.js'

export const TASK_STATUS = new Set(['open', 'claimed', 'in_review', 'done', 'abandoned'])
export const TASK_PROVENANCE = new Set(['human', 'ai_assisted', 'ai_authored'])
const CLAIM_TTL_DAYS = 7          // 认领后多久没进 in_review 自动回 open
const CREATE_RATE_PER_DAY = 10    // 每人每日建任务上限(反灌水)
const MAX_ACTIVE_CLAIMS = 5       // 单人同时持有的 claimed+in_review 上限(防"全占坑")
const TITLE_MAX = 200
const TEXT_MAX = 4000

export function initBuildTasksSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_tasks (
      id                 TEXT PRIMARY KEY,            -- bt_xxx
      title              TEXT NOT NULL,
      area               TEXT,                        -- search / docs / mcp / dispute / ...(自由建议枚举)
      description        TEXT,
      rfc_ref            TEXT,                        -- 关联 RFC(如 RFC-006)
      status             TEXT NOT NULL DEFAULT 'open',-- open | claimed | in_review | done | abandoned
      claimer_id         TEXT,
      claimer_provenance TEXT,                        -- human | ai_assisted | ai_authored(自报)
      pr_ref             TEXT,                        -- submit 时填(PR 链接 / 编号)
      claimed_at         TEXT,
      claim_expires_at   TEXT,                        -- claimed 的 TTL,过期自动回 open
      created_by         TEXT NOT NULL,
      resolution         TEXT,                        -- admin 验收说明(done/abandoned)
      resolved_by        TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_build_tasks_status ON build_tasks(status, updated_at DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_build_tasks_area   ON build_tasks(area, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_build_tasks_claimer ON build_tasks(claimer_id, status)`)
  // 状态变更审计(可追溯谁在何时改了什么)
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_task_events (
      id          TEXT PRIMARY KEY,              -- btev_xxx
      task_id     TEXT NOT NULL,
      actor_id    TEXT,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_build_task_events ON build_task_events(task_id, created_at)`)
}

export function logTaskEvent(db: Database.Database, taskId: string, actorId: string | null, from: string | null, to: string, note: string | null): void {
  db.prepare(`INSERT INTO build_task_events (id, task_id, actor_id, from_status, to_status, note) VALUES (?,?,?,?,?,?)`)
    .run(generateId('btev'), taskId, actorId, from, to, note)
}

// 惰性释放过期认领:claimed 且 claim_expires_at 已过 → 回 open(in_review 不动,它有 PR)。
// 在每次 list / claim 前调用,无需 cron。
export function releaseExpiredClaims(db: Database.Database): number {
  const expired = db.prepare(
    `SELECT id FROM build_tasks WHERE status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at < datetime('now')`
  ).all() as Array<{ id: string }>
  for (const t of expired) {
    db.prepare(`UPDATE build_tasks SET status='open', claimer_id=NULL, claimer_provenance=NULL,
      claimed_at=NULL, claim_expires_at=NULL, updated_at=datetime('now') WHERE id = ? AND status='claimed'`).run(t.id)
    logTaskEvent(db, t.id, null, 'claimed', 'open', 'auto-release: claim expired')
  }
  return expired.length
}

type CreateInput = { creatorId: string; title: string; area?: string; description?: string; rfcRef?: string }

export function createBuildTask(db: Database.Database, input: CreateInput):
  { id: string; status: string } | { error: string; error_code?: string } {
  const title = String(input.title || '').trim()
  if (title.length < 3) return { error: '标题太短(至少 3 字)', error_code: 'TITLE_TOO_SHORT' }
  if (title.length > TITLE_MAX) return { error: `标题过长(上限 ${TITLE_MAX})`, error_code: 'TITLE_TOO_LONG' }
  const description = input.description ? String(input.description).slice(0, TEXT_MAX) : null
  const area = input.area ? String(input.area).slice(0, 64) : null
  const rfcRef = input.rfcRef ? String(input.rfcRef).slice(0, 64) : null

  const todayCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM build_tasks WHERE created_by = ? AND created_at > datetime('now','-1 day')`
  ).get(input.creatorId) as { n: number }).n
  if (todayCount >= CREATE_RATE_PER_DAY) {
    return { error: `今日建任务已达上限(${CREATE_RATE_PER_DAY}/天)`, error_code: 'RATE_LIMITED' }
  }

  const id = generateId('bt')
  db.prepare(`INSERT INTO build_tasks (id, title, area, description, rfc_ref, status, created_by)
    VALUES (?,?,?,?,?, 'open', ?)`).run(id, title, area, description, rfcRef, input.creatorId)
  logTaskEvent(db, id, input.creatorId, null, 'open', 'created')
  return { id, status: 'open' }
}

type ListFilter = { status?: string; area?: string; claimerId?: string }

export function listBuildTasks(db: Database.Database, f: ListFilter = {}): Array<Record<string, unknown>> {
  releaseExpiredClaims(db)   // 先回收过期占坑,列表才准
  const where: string[] = []
  const params: unknown[] = []
  if (f.status && TASK_STATUS.has(f.status)) { where.push('status = ?'); params.push(f.status) }
  if (f.area) { where.push('area = ?'); params.push(String(f.area).slice(0, 64)) }
  if (f.claimerId) { where.push('claimer_id = ?'); params.push(f.claimerId) }
  const sql = `SELECT id, title, area, description, rfc_ref, status, claimer_id, claimer_provenance,
    pr_ref, claimed_at, claim_expires_at, created_by, resolution, created_at, updated_at
    FROM build_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (status='open') DESC, updated_at DESC LIMIT 200`
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>
}

export function getBuildTask(db: Database.Database, id: string): Record<string, unknown> | null {
  releaseExpiredClaims(db)
  const row = db.prepare(`SELECT * FROM build_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!row) return null
  row.events = db.prepare(`SELECT actor_id, from_status, to_status, note, created_at FROM build_task_events WHERE task_id = ? ORDER BY created_at`).all(id)
  return row
}

export function claimBuildTask(db: Database.Database, taskId: string, userId: string, provenance?: string):
  { id: string; status: string; claim_expires_at: string } | { error: string; error_code?: string } {
  releaseExpiredClaims(db)
  const prov = provenance && TASK_PROVENANCE.has(provenance) ? provenance : 'human'
  const active = (db.prepare(
    `SELECT COUNT(*) AS n FROM build_tasks WHERE claimer_id = ? AND status IN ('claimed','in_review')`
  ).get(userId) as { n: number }).n
  if (active >= MAX_ACTIVE_CLAIMS) {
    return { error: `你已持有 ${active} 个进行中的任务(上限 ${MAX_ACTIVE_CLAIMS}),先完成或释放再认领`, error_code: 'TOO_MANY_CLAIMS' }
  }
  // 原子认领:只有 open 才能被领;并发下只有一个成功
  const expiresExpr = `datetime('now','+${CLAIM_TTL_DAYS} days')`
  const upd = db.prepare(`UPDATE build_tasks SET status='claimed', claimer_id=?, claimer_provenance=?,
    claimed_at=datetime('now'), claim_expires_at=${expiresExpr}, updated_at=datetime('now')
    WHERE id = ? AND status='open'`).run(userId, prov, taskId)
  if (upd.changes === 0) {
    const exist = db.prepare(`SELECT status FROM build_tasks WHERE id = ?`).get(taskId) as { status: string } | undefined
    if (!exist) return { error: '任务不存在', error_code: 'NOT_FOUND' }
    return { error: `任务当前状态为 ${exist.status},不可认领(只有 open 可领)`, error_code: 'NOT_OPEN' }
  }
  logTaskEvent(db, taskId, userId, 'open', 'claimed', `provenance=${prov}`)
  const row = db.prepare(`SELECT claim_expires_at FROM build_tasks WHERE id = ?`).get(taskId) as { claim_expires_at: string }
  return { id: taskId, status: 'claimed', claim_expires_at: row.claim_expires_at }
}

// `verificationSummary` (what the contributor ran/verified) is the submit evidence — stored in the
// existing build_task_events.note (no schema churn). The ROUTE requires it; the engine stores it if
// present, staying backward-compatible for any direct caller.
export function submitBuildTask(db: Database.Database, taskId: string, userId: string, prRef?: string, note?: string, verificationSummary?: string):
  { id: string; status: string } | { error: string; error_code?: string } {
  const t = db.prepare(`SELECT status, claimer_id FROM build_tasks WHERE id = ?`).get(taskId) as { status: string; claimer_id: string | null } | undefined
  if (!t) return { error: '任务不存在', error_code: 'NOT_FOUND' }
  if (t.claimer_id !== userId) return { error: '只有认领者可提交', error_code: 'NOT_CLAIMER' }
  if (t.status !== 'claimed') return { error: `任务状态为 ${t.status},仅 claimed 可提交进 in_review`, error_code: 'BAD_STATE' }
  const pr = prRef ? String(prRef).slice(0, 300) : null
  db.prepare(`UPDATE build_tasks SET status='in_review', pr_ref=?, updated_at=datetime('now') WHERE id = ? AND status='claimed'`).run(pr, taskId)
  const parts = [`pr=${pr || '?'}`]
  if (verificationSummary) parts.push(`verify=${String(verificationSummary).slice(0, 500)}`)
  if (note) parts.push(`note=${String(note).slice(0, 200)}`)
  logTaskEvent(db, taskId, userId, 'claimed', 'in_review', parts.join(' '))
  return { id: taskId, status: 'in_review' }
}

// 认领者主动放弃 → 回 open(让别人接)
export function releaseBuildTask(db: Database.Database, taskId: string, userId: string):
  { id: string; status: string } | { error: string; error_code?: string } {
  const t = db.prepare(`SELECT status, claimer_id FROM build_tasks WHERE id = ?`).get(taskId) as { status: string; claimer_id: string | null } | undefined
  if (!t) return { error: '任务不存在', error_code: 'NOT_FOUND' }
  if (t.claimer_id !== userId) return { error: '只有认领者可释放', error_code: 'NOT_CLAIMER' }
  if (t.status !== 'claimed' && t.status !== 'in_review') return { error: `任务状态为 ${t.status},无可释放`, error_code: 'BAD_STATE' }
  db.prepare(`UPDATE build_tasks SET status='open', claimer_id=NULL, claimer_provenance=NULL,
    claimed_at=NULL, claim_expires_at=NULL, pr_ref=NULL, updated_at=datetime('now') WHERE id = ?`).run(taskId)
  logTaskEvent(db, taskId, userId, t.status, 'open', 'released by claimer')
  return { id: taskId, status: 'open' }
}

// 验收终态 done / abandoned —— **仅 admin/maintainer**(验收=真人,RFC-006 不变量 2)。
// 注:此处不发奖励/不记 build_reputation;那是 stage 4(独立池)的事。
export function resolveBuildTask(db: Database.Database, taskId: string, status: string, adminId: string, note?: string):
  { id: string; status: string } | { error: string; error_code?: string } {
  if (status !== 'done' && status !== 'abandoned') return { error: "status 必须是 done | abandoned", error_code: 'BAD_STATUS' }
  const t = db.prepare(`SELECT status, claimer_id FROM build_tasks WHERE id = ?`).get(taskId) as { status: string; claimer_id: string | null } | undefined
  if (!t) return { error: '任务不存在', error_code: 'NOT_FOUND' }
  db.prepare(`UPDATE build_tasks SET status=?, resolution=?, resolved_by=?, updated_at=datetime('now') WHERE id = ?`)
    .run(status, note ? String(note).slice(0, TEXT_MAX) : null, adminId, taskId)
  logTaskEvent(db, taskId, adminId, t.status, status, note ? String(note).slice(0, 200) : null)
  // 验收 done → 给认领者记【建设】信誉(独立池;奖励锚真人:仅 Passkey 用户记分)。防重复见 creditBuildReputation。
  if (status === 'done' && t.claimer_id && t.status !== 'done') {
    const hasAnchor = (((db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?')
      .get(t.claimer_id) as { n: number } | undefined)?.n) || 0) > 0
    if (hasAnchor) creditBuildReputation(db, t.claimer_id, 'task_done', BUILD_POINTS.task_done, taskId, `task ${taskId} done`)
  }
  return { id: taskId, status }
}
