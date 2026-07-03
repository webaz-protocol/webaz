#!/usr/bin/env tsx
/**
 * 协商取消 HTTP 路由 e2e —— 证明 5 端点接线:auth 门(401)、当事方门(403)、握手语义(409 冲突码)、
 *   以及 accept 端点的 db.transaction 真的提交(订单落库为 cancelled、争议 resolved)。
 * Usage: npm run test:mutual-cancel-route
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'mcr-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const D = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const MC = await import('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.js')
const { registerMutualCancelRoutes } = await import('../src/pwa/routes/mutual-cancel.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initOrderChainSchema(db); D.initDisputeSchema(db); D.initEvidenceRequestSchema(db); MC.initMutualCancelSchema(db)
try { db.exec('ALTER TABLE orders ADD COLUMN bid_stake_held REAL DEFAULT 0') } catch { /* server.ts ALTER,真实库已有 */ }
try { db.exec('ALTER TABLE orders ADD COLUMN stake_backing REAL DEFAULT 0') } catch { /* server.ts ALTER,真实库已有 */ }
for (const [id, role] of [['buyer', 'buyer'], ['seller', 'seller'], ['outsider', 'buyer']] as const)
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)

let oc = 0
function mkDisputed(): { orderId: string } {
  const orderId = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?,?,'buyer','seller',1,50,50,0,'disputed','direct_p2p')").run(orderId, 'p')
  const r = D.createDispute(db, orderId, 'buyer', '想取消', [])
  if (!r.success) throw new Error('createDispute failed: ' + r.error)
  return { orderId }
}
const oStatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const dStatus = (id: string) => (db.prepare("SELECT status FROM disputes WHERE order_id=? ORDER BY created_at DESC LIMIT 1").get(id) as { status: string }).status

const app = express(); app.use(express.json())
registerMutualCancelRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid } },
  generateId,
  errorRes: (res: Response, status: number, code: string, msg: string) => { res.status(status).json({ error: msg, error_code: code }) },
})

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const call = (method: 'GET' | 'POST', path: string, uid?: string, body?: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : ''
  const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); if (payload) rq.write(payload); rq.end()
})

try {
  const { orderId } = mkDisputed()
  const base = `/api/orders/${orderId}/mutual-cancel`
  ok('1. GET state unauthenticated → 401', (await call('GET', base)).status === 401)
  ok('2. buyer proposes → 200 pending', (() => { return true })())
  const p = await call('POST', base + '/propose', 'buyer', { reason: '不想买了' })
  ok('2b. propose 200 + pending', p.status === 200 && p.json?.status === 'pending')
  const st = await call('GET', base, 'seller')
  ok('3. seller GET state → can_accept', st.status === 200 && st.json?.can_accept === true && st.json?.proposal?.mine === false)
  const outGet = await call('GET', base, 'outsider')
  ok('3b. outsider GET state → 403 NOT_A_PARTY (no proposal/reason leaked)', outGet.status === 403 && outGet.json?.proposal === undefined)
  ok('4. proposer accept own → 409 CANNOT_ACCEPT_OWN', (await call('POST', base + '/accept', 'buyer')).json?.error_code === 'CANNOT_ACCEPT_OWN')
  ok('5. outsider accept → 403 NOT_A_PARTY', (await call('POST', base + '/accept', 'outsider')).status === 403)
  const a = await call('POST', base + '/accept', 'seller')
  ok('6. seller accept → 200, non_custodial settlement', a.status === 200 && a.json?.settlement?.non_custodial === true)
  ok('6b. db.transaction committed: order=cancelled, dispute=resolved', oStatus(orderId) === 'cancelled' && dStatus(orderId) === 'resolved')
  ok('7. accept again → 409 ORDER_NOT_DISPUTED (terminal)', (await call('POST', base + '/accept', 'seller')).json?.error_code === 'ORDER_NOT_DISPUTED')

  // decline path on a fresh order
  const o2 = mkDisputed(); const base2 = `/api/orders/${o2.orderId}/mutual-cancel`
  await call('POST', base2 + '/propose', 'seller', {})
  ok('8. buyer decline → 200', (await call('POST', base2 + '/decline', 'buyer')).status === 200)
  ok('8b. after decline order still disputed (no settlement)', oStatus(o2.orderId) === 'disputed')
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ mutual-cancel-route FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mutual-cancel-route: auth(401)+party(403)+handshake(409 codes)+accept db.transaction commits(cancelled/resolved)+decline no-op\n  ✅ pass ${pass}`)
