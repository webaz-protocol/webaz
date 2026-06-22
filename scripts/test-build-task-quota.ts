#!/usr/bin/env tsx
/**
 * build_task quota-increase requests — engine + store (no HTTP). Fresh in-memory DB.
 *   用法:npm run test:build-task-quota
 *
 * Covers: request validation (positive count / max / reason required / one-pending), approve/reject
 * (incl. self-decision rejected), and ATOMIC consume — a capped non-root creator can create exactly the
 * granted count and no more; failed validation never consumes; an exhausted/expired grant stops working;
 * fail-closed when the quota table is missing.
 */
import Database from 'better-sqlite3'
import { initBuildTasksSchema, createBuildTask } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import {
  initBuildTaskQuotaSchema, createQuotaRequest, approveQuotaRequest, rejectQuotaRequest,
  getQuotaRequest, listMyQuotaRequests, remainingQuota,
} from '../src/layer2-business/L2-9-contribution/build-task-quota.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function dbBase(withQuota = true): any {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, admin_type TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_root','Root','admin','root','kr')`).run()
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_member','Member','member',NULL,'km')`).run()
  initBuildTasksSchema(db)
  if (withQuota) initBuildTaskQuotaSchema(db)
  return db
}
const isErr = (r: any) => !!r && 'error' in r
const isRL = (r: any) => isErr(r) && r.error_code === 'RATE_LIMITED'
function fillCap(db: any, who: string, n = 10): number {
  let okN = 0
  for (let i = 0; i < n; i++) { const r: any = createBuildTask(db, { creatorId: who, title: `cap ${who} ${i}`, area: 'docs' }); if (!isErr(r)) okN++ }
  return okN
}

async function main() {
  // ── request validation ────────────────────────────────────────────────────
  {
    const db = dbBase()
    ok('reject: non-positive count', isErr(createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 0, reason: 'need more please' })) && (createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: -3, reason: 'need more please' }) as any).error_code === 'BAD_COUNT')
  }
  {
    const db = dbBase()
    ok('reject: count over max (50)', (createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 51, reason: 'need more please' }) as any).error_code === 'COUNT_TOO_LARGE')
  }
  {
    const db = dbBase()
    ok('reject: empty reason', (createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 5, reason: '' }) as any).error_code === 'REASON_REQUIRED')
  }
  {
    const db = dbBase()
    ok('reject: duration over max (72h)', (createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 5, reason: 'valid reason', requestedDurationHours: 999 }) as any).error_code === 'DURATION_TOO_LARGE')
  }
  {
    const db = dbBase()
    const r1: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 5, reason: 'first request' })
    ok('accept: valid request → pending', !isErr(r1) && r1.status === 'pending')
    const r2: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 3, reason: 'second request' })
    ok('reject: one pending per requester', r2.error_code === 'ALREADY_PENDING')
  }

  // ── approve / reject ───────────────────────────────────────────────────────
  {
    const db = dbBase()
    const req: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 5, reason: 'need headroom', requestedDurationHours: 24 })
    ok('reject: self-decision (approver === requester)', (approveQuotaRequest(db, req.id, 'usr_member', {}) as any).error_code === 'SELF_DECISION')
    const ap: any = approveQuotaRequest(db, req.id, 'usr_root', { grantedCount: 3, durationHours: 24, decisionNote: 'ok' })
    ok('approve: ok by root', !isErr(ap) && ap.granted_count === 3 && !!ap.expires_at)
    ok('approve: re-approve blocked (not pending)', (approveQuotaRequest(db, req.id, 'usr_root', {}) as any).error_code === 'BAD_STATE')
    const got: any = getQuotaRequest(db, req.id)
    ok('approved row: status=approved, granted=3, consumed=0', got.status === 'approved' && got.granted_count === 3 && got.consumed_count === 0)
  }
  {
    const db = dbBase()
    const req: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 5, reason: 'need headroom' })
    const rj: any = rejectQuotaRequest(db, req.id, 'usr_root', { decisionNote: 'not now' })
    ok('reject: ok by root', !isErr(rj))
    ok('rejected row carries decision_note + decided_by', (() => { const g: any = getQuotaRequest(db, req.id); return g.status === 'rejected' && g.decision_note === 'not now' && g.decided_by === 'usr_root' })())
  }

  // ── atomic consume ─────────────────────────────────────────────────────────
  {
    const db = dbBase()
    ok('member fills the 10/day cap', fillCap(db, 'usr_member') === 10)
    ok('11th create RATE_LIMITED + structured affordance', (() => { const r: any = createBuildTask(db, { creatorId: 'usr_member', title: 'over cap', area: 'docs' }); return isRL(r) && r.can_request === true && r.limit === 10 && r.used >= 10 })())

    const req: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 3, reason: 'need 3 more', requestedDurationHours: 24 })
    approveQuotaRequest(db, req.id, 'usr_root', { grantedCount: 3, durationHours: 24 })
    ok('remainingQuota = 3 after approval', remainingQuota(db, 'usr_member') === 3)

    const c1: any = createBuildTask(db, { creatorId: 'usr_member', title: 'grant 1', area: 'docs' })
    ok('grant create #1 ok, via_grant, remaining 2', !isErr(c1) && c1.via_grant === true && c1.remaining_quota === 2)
    const c2: any = createBuildTask(db, { creatorId: 'usr_member', title: 'grant 2', area: 'docs' })
    const c3: any = createBuildTask(db, { creatorId: 'usr_member', title: 'grant 3', area: 'docs' })
    ok('grant create #2,#3 ok, remaining 1 then 0', !isErr(c2) && c2.remaining_quota === 1 && !isErr(c3) && c3.remaining_quota === 0)
    ok('grant exhausted → next create RATE_LIMITED again', isRL(createBuildTask(db, { creatorId: 'usr_member', title: 'over grant', area: 'docs' })))
    ok('grant row marked exhausted', getQuotaRequest(db, req.id)!.status === 'exhausted')
  }

  // failed validation must NOT consume a grant
  {
    const db = dbBase()
    fillCap(db, 'usr_member')
    const req: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 2, reason: 'need 2', requestedDurationHours: 24 })
    approveQuotaRequest(db, req.id, 'usr_root', { grantedCount: 2, durationHours: 24 })
    const bad: any = createBuildTask(db, { creatorId: 'usr_member', title: 'x' })   // too short → validation error before consume
    ok('failed validation returns TITLE_TOO_SHORT (not consume)', bad.error_code === 'TITLE_TOO_SHORT')
    ok('grant still has full 2 remaining after failed create', remainingQuota(db, 'usr_member') === 2)
  }

  // expired grant must not be consumable
  {
    const db = dbBase()
    fillCap(db, 'usr_member')
    const req: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 5, reason: 'need 5' })
    approveQuotaRequest(db, req.id, 'usr_root', { grantedCount: 5, durationHours: 24 })
    // force the grant into the past
    db.prepare(`UPDATE build_task_quota_requests SET expires_at = datetime('now','-1 hour') WHERE id = ?`).run(req.id)
    ok('expired grant: create RATE_LIMITED', isRL(createBuildTask(db, { creatorId: 'usr_member', title: 'after expiry', area: 'docs' })))
    ok('expired grant: status flipped to expired', getQuotaRequest(db, req.id)!.status === 'expired')
    ok('expired grant: remainingQuota 0', remainingQuota(db, 'usr_member') === 0)
  }

  // fail-closed: no quota table at all → capped, no throw
  {
    const db = dbBase(false)   // no initBuildTaskQuotaSchema
    fillCap(db, 'usr_member')
    ok('no quota table: create RATE_LIMITED (fail-closed, no throw)', isRL(createBuildTask(db, { creatorId: 'usr_member', title: 'no quota table', area: 'docs' })))
  }

  // listMyQuotaRequests returns the requester's rows newest-first
  {
    const db = dbBase()
    const a: any = createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 1, reason: 'first one' })
    rejectQuotaRequest(db, a.id, 'usr_root', {})
    createQuotaRequest(db, { requesterId: 'usr_member', requestedExtraCount: 2, reason: 'second one' })
    const mine = listMyQuotaRequests(db, 'usr_member')
    ok('listMyQuotaRequests returns 2 rows', mine.length === 2)
  }

  console.log('\ntest:build-task-quota')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ quota requests: validation + one-pending + approve/reject(self-decision blocked) + ATOMIC consume (granted count exactly, no consume on failed create, exhausted/expired stop, fail-closed without table)\n')
}

main()
