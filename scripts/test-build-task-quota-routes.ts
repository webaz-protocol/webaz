#!/usr/bin/env tsx
/**
 * build_task quota-increase requests — route + role tests (real express, node:http). Fresh DB.
 *   用法:npm run test:build-task-quota-routes
 *
 * Verifies end-to-end: a capped non-root creator gets a structured RATE_LIMITED (429) with the
 * request affordance; the requester can submit + view; ROOT can list/detail/approve/reject; a non-root
 * admin is 403 on the review surface; self-approval is rejected; and an approved grant is consumed only
 * on a successful create (and only up to the granted count).
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildTasksSchema } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildTaskQuotaSchema } from '../src/layer2-business/L2-9-contribution/build-task-quota.js'
import { registerBuildTasksRoutes } from '../src/pwa/routes/build-tasks.js'
import { registerBuildTaskQuotaRoutes } from '../src/pwa/routes/build-task-quota.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any
function freshDb(): void {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, admin_type TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_root','Root','admin','root','kr')`).run()
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_regional','Regional','admin','regional','kg')`).run()
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_member','Member','member',NULL,'km')`).run()
  initBuildTasksSchema(db); initBuildTaskQuotaSchema(db); setSeamDb(db)
}
const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => { res.status(status).json({ error: message, error_code: code, ...(extra || {}) }) }
// auth: Authorization: Bearer <api_key> → user row
const auth = (req: Request, res: Response): Record<string, unknown> | null => {
  const k = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const u = db.prepare('SELECT id, role, admin_type FROM users WHERE api_key = ?').get(k) as any
  if (!u) { res.status(401).json({ error: 'unauthorized', error_code: 'UNAUTHORIZED' }); return null }
  return u
}
const requireRootAdmin = (req: Request, res: Response): Record<string, unknown> | null => {
  const u = auth(req, res); if (!u) return null
  if (u.role !== 'admin' || u.admin_type !== 'root') { res.status(403).json({ error: 'root admin only', error_code: 'FORBIDDEN' }); return null }
  return u
}

let server: Server, port = 0
function reqHttp(method: string, path: string, opts: { key?: string; body?: any } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (opts.key) headers['authorization'] = 'Bearer ' + opts.key
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
    })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
const create = (key: string, title: string) => reqHttp('POST', '/api/build-tasks', { key, body: { title, area: 'docs' } })

async function main() {
  freshDb()
  const app = express(); app.use(express.json())
  registerBuildTasksRoutes(app, { db, auth, requireSupportAdmin: requireRootAdmin })
  registerBuildTaskQuotaRoutes(app, { db, errorRes, auth, requireRootAdmin })
  server = createServer(app)
  port = await new Promise<number>(r => server.listen(0, () => r((server.address() as any).port)))

  // member fills the 10/day cap
  let okN = 0
  for (let i = 0; i < 10; i++) { const r = await create('km', `cap ${i}`); if (r.status === 200) okN++ }
  ok('member: 10 creates succeed', okN === 10, `okN=${okN}`)

  // 11th → 429 with structured affordance
  const over = await create('km', 'over cap')
  ok('member: 11th create → 429 RATE_LIMITED', over.status === 429 && over.json?.error_code === 'RATE_LIMITED')
  ok('member: response carries can_request + limit + used', over.json?.can_request === true && over.json?.limit === 10 && over.json?.used >= 10, JSON.stringify(over.json))

  // requester submits a request
  const sub = await reqHttp('POST', '/api/me/quota-requests', { key: 'km', body: { requested_extra_count: 3, reason: 'finishing the docs sweep', linked_refs: ['#17'], urgency: 'high', requested_duration_hours: 24 } })
  ok('member: submit request → 200 pending', sub.status === 200 && sub.json?.request?.status === 'pending')
  const reqId = sub.json?.request?.id

  // requester view
  const mine = await reqHttp('GET', '/api/me/quota-requests', { key: 'km' })
  ok('member: GET own requests shows 1, remaining 0', mine.status === 200 && mine.json?.requests?.length === 1 && mine.json?.remaining_quota === 0)
  ok('member: linked_refs parsed to array', Array.isArray(mine.json?.requests?.[0]?.linked_refs) && mine.json.requests[0].linked_refs[0] === '#17')

  // one pending per requester
  const dupe = await reqHttp('POST', '/api/me/quota-requests', { key: 'km', body: { requested_extra_count: 1, reason: 'another one' } })
  ok('member: second pending → 409 ALREADY_PENDING', dupe.status === 409 && dupe.json?.error_code === 'ALREADY_PENDING')

  // non-root admin cannot access the review surface
  const regList = await reqHttp('GET', '/api/admin/quota-requests', { key: 'kg' })
  ok('regional admin: review list → 403', regList.status === 403)
  const regApprove = await reqHttp('POST', `/api/admin/quota-requests/${reqId}/approve`, { key: 'kg', body: { extra_count: 3 } })
  ok('regional admin: approve → 403', regApprove.status === 403)

  // root lists + detail (with requester 24h usage)
  const rootList = await reqHttp('GET', '/api/admin/quota-requests?status=pending', { key: 'kr' })
  ok('root: list pending → 200 with 1', rootList.status === 200 && rootList.json?.requests?.length === 1)
  const detail = await reqHttp('GET', `/api/admin/quota-requests/${reqId}`, { key: 'kr' })
  ok('root: detail shows requester_usage_24h ~10', detail.status === 200 && detail.json?.requester_usage_24h >= 10)

  // self-approval rejected: root submits + tries to approve own
  const rootReq = await reqHttp('POST', '/api/me/quota-requests', { key: 'kr', body: { requested_extra_count: 2, reason: 'root own request test' } })
  const selfApprove = await reqHttp('POST', `/api/admin/quota-requests/${rootReq.json?.request?.id}/approve`, { key: 'kr', body: { extra_count: 2 } })
  ok('root: self-approval → 403 SELF_DECISION', selfApprove.status === 403 && selfApprove.json?.error_code === 'SELF_DECISION')

  // root approves the member request
  const approve = await reqHttp('POST', `/api/admin/quota-requests/${reqId}/approve`, { key: 'kr', body: { extra_count: 3, duration_hours: 24, approval_note: 'approved for docs sweep' } })
  ok('root: approve member request → 200', approve.status === 200 && approve.json?.approved?.granted_count === 3)

  // grant is consumed only on successful create, up to granted count
  const g1 = await create('km', 'grant create 1')
  ok('member: create via grant #1 → 200 remaining 2', g1.status === 200 && g1.json?.via_grant === true && g1.json?.remaining_quota === 2)
  const g2 = await create('km', 'grant create 2'); const g3 = await create('km', 'grant create 3')
  ok('member: create via grant #2,#3 → remaining 1 then 0', g2.json?.remaining_quota === 1 && g3.json?.remaining_quota === 0)
  const g4 = await create('km', 'over grant')
  ok('member: 4th over grant → 429 again', g4.status === 429 && g4.json?.error_code === 'RATE_LIMITED')

  // reject path (root)
  const memReq2 = await reqHttp('POST', '/api/me/quota-requests', { key: 'km', body: { requested_extra_count: 2, reason: 'second round of work' } })
  const reject = await reqHttp('POST', `/api/admin/quota-requests/${memReq2.json?.request?.id}/reject`, { key: 'kr', body: { rejection_note: 'batch later' } })
  ok('root: reject → 200', reject.status === 200)
  const mine2 = await reqHttp('GET', '/api/me/quota-requests', { key: 'km' })
  ok('member: rejected request shows decision_note', (mine2.json?.requests || []).some((r: any) => r.status === 'rejected' && r.decision_note === 'batch later'))

  await new Promise<void>(r => server.close(() => r()))

  console.log('\ntest:build-task-quota-routes')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ quota routes: capped non-root → 429 + affordance · requester submit/view (one pending) · ROOT list/detail/approve/reject · non-root 403 · self-approval blocked · grant consumed only on successful create up to granted count\n')
}

main().catch(e => { console.error(e); process.exit(1) })
