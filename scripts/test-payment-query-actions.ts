#!/usr/bin/env tsx
/**
 * PR-B1 route guard — Direct Pay 货款协商动作(争议≠仲裁,人驱动)。真 express + 真 transition。
 * report_nonpayment(卖家 accepted→payment_query,设响应宽限)· confirm_received(卖家→accepted 恢复)·
 * 买家 cancel(payment_query→cancelled)· pq_escalate(→disputed,需证据,建 dispute)· pq_withdraw(disputed→payment_query,已裁定拒)。
 * 均仅 direct_p2p + 角色/状态门;escrow 不可入。Usage: npm run test:payment-query-actions
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'pq-act-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderChainSchema(db); initSystemUser(db); initDisputeSchema(db)
try { db.exec("ALTER TABLE evidence ADD COLUMN flag_reasons TEXT") } catch {}  // runtime-helper column (bare initDatabase lacks it)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','b','buyer','kb')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','s','seller','ks')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('other','o','buyer','ko')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price) VALUES ('p1','seller1','T','d',50)").run()
let oc = 0, dc = 0, disputes: string[] = []
function mkOrder(status: string, rail = 'direct_p2p'): string {
  const id = `o_${++oc}`
  db.prepare(`INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p1','buyer1','seller1',1,50,50,0,?,?)`).run(id, status, rail)
  return id
}
const st = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const pqDeadline = (id: string) => (db.prepare('SELECT payment_query_deadline d FROM orders WHERE id=?').get(id) as { d: string | null }).d
const mkDisputeRow = (orderId: string, status = 'in_review') => { const id = `dsp_${++dc}`; db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status) VALUES (?,?, 'buyer1','seller1','t',?)").run(id, orderId, status); return id }

const app = express(); app.use(express.json())
let counter = 0
registerOrdersActionRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null }; return { id: uid, role: (req.headers['x-test-role'] as string) || 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++counter}`, transition, notifyTransition: () => {},
  settleOrder: () => {}, settleFault: () => {}, detectFraud: () => [],
  createDispute: (_db: any, orderId: string) => { disputes.push(orderId); return { success: true } },
  checkTimeouts: () => ({ details: [] }), recordViolationReputation: () => {}, broadcastSystemEvent: () => {}, consumeGateToken: () => ({ ok: true }),
} as any)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const call = (orderId: string, body: Record<string, unknown>, uid?: string, role?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid; if (role) headers['x-test-role'] = role
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/orders/${orderId}/action`, headers }, res => { let dt = ''; res.on('data', c => dt += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: dt ? JSON.parse(dt) : null }) } catch { resolve({ status: res.statusCode || 0, json: dt }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})

try {
  // 1. report_nonpayment: seller on accepted → payment_query + grace set
  const o1 = mkOrder('accepted')
  const r1 = await call(o1, { action: 'report_nonpayment' }, 'seller1', 'seller')
  ok('1a. seller report_nonpayment → 200 payment_query', r1.status === 200 && st(o1) === 'payment_query', JSON.stringify(r1))
  ok('1b. buyer response grace (payment_query_deadline) set', !!pqDeadline(o1))
  // 2. guards
  ok('2a. buyer CANNOT report_nonpayment (403)', (await call(mkOrder('accepted'), { action: 'report_nonpayment' }, 'buyer1', 'buyer')).status === 403)
  ok('2b. report_nonpayment only from accepted (409)', (await call(mkOrder('direct_pay_window'), { action: 'report_nonpayment' }, 'seller1', 'seller')).status === 409)
  ok('2c. escrow order → 409 NOT_DIRECT_PAY', (await call(mkOrder('accepted', 'escrow'), { action: 'report_nonpayment' }, 'seller1', 'seller')).json?.error_code === 'NOT_DIRECT_PAY')
  // 3. confirm_received: seller payment_query → accepted, grace cleared
  const o3 = mkOrder('accepted'); await call(o3, { action: 'report_nonpayment' }, 'seller1', 'seller')
  const r3 = await call(o3, { action: 'confirm_received' }, 'seller1', 'seller')
  ok('3a. seller confirm_received → 200 accepted (resume)', r3.status === 200 && st(o3) === 'accepted', JSON.stringify(r3))
  ok('3b. grace cleared on resume', pqDeadline(o3) === null)
  // 4. buyer cancel in payment_query
  const o4 = mkOrder('accepted'); await call(o4, { action: 'report_nonpayment' }, 'seller1', 'seller')
  ok('4a. buyer cancel in payment_query → cancelled', (await call(o4, { action: 'cancel' }, 'buyer1', 'buyer')).status === 200 && st(o4) === 'cancelled')
  // 5. escalate → disputed (evidence required + createDispute)
  const o5 = mkOrder('accepted'); await call(o5, { action: 'report_nonpayment' }, 'seller1', 'seller')
  ok('5a. escalate WITHOUT evidence → rejected (requiresEvidence)', !(await call(o5, { action: 'pq_escalate' }, 'buyer1', 'buyer')).json?.success && st(o5) === 'payment_query')
  const r5 = await call(o5, { action: 'pq_escalate', evidence_description: 'bank receipt #123' }, 'buyer1', 'buyer')
  ok('5b. escalate WITH evidence → disputed + createDispute fired', r5.status === 200 && st(o5) === 'disputed' && disputes.includes(o5), JSON.stringify(r5))
  const o5b = mkOrder('accepted'); await call(o5b, { action: 'report_nonpayment' }, 'seller1', 'seller')
  ok('5c. non-party CANNOT escalate (403)', (await call(o5b, { action: 'pq_escalate', evidence_description: 'x' }, 'other', 'buyer')).status === 403)
  // 6. withdraw: disputed → payment_query (before ruling); ruled → 409
  const o6 = mkOrder('accepted'); await call(o6, { action: 'report_nonpayment' }, 'seller1', 'seller'); await call(o6, { action: 'pq_escalate', evidence_description: 'x' }, 'buyer1', 'buyer'); const d6 = mkDisputeRow(o6, 'in_review')
  ok('6a. withdraw (disputed→payment_query) before ruling → 200', (await call(o6, { action: 'pq_withdraw' }, 'seller1', 'seller')).status === 200 && st(o6) === 'payment_query')
  ok('6a-P1. withdraw CLOSES the active dispute (dismissed) — no dirty active dispute left', (db.prepare('SELECT status FROM disputes WHERE id=?').get(d6) as { status: string }).status === 'dismissed')
  ok('6a-P2. withdraw REBUILDS the negotiation deadline (payment_query_deadline non-null)', !!pqDeadline(o6))
  const o7 = mkOrder('accepted'); await call(o7, { action: 'report_nonpayment' }, 'seller1', 'seller'); await call(o7, { action: 'pq_escalate', evidence_description: 'x' }, 'buyer1', 'buyer'); mkDisputeRow(o7, 'resolved')
  ok('6b. withdraw a RULED dispute → 409 DISPUTE_ALREADY_RULED', (await call(o7, { action: 'pq_withdraw' }, 'buyer1', 'buyer')).json?.error_code === 'DISPUTE_ALREADY_RULED')
  // 6c. P1 — pq_withdraw MUST NOT touch a FULFILLMENT dispute (delivered→disputed 货损/货不对版). Only payment_query→disputed is withdrawable.
  const o7b = mkOrder('delivered'); await call(o7b, { action: 'dispute', evidence_description: 'item damaged' }, 'buyer1', 'buyer'); mkDisputeRow(o7b, 'in_review')
  ok('6c-setup. fulfillment dispute reached disputed (delivered→disputed)', st(o7b) === 'disputed')
  ok('6c. pq_withdraw on a fulfillment dispute → 409 NOT_PAYMENT_QUERY_DISPUTE (stays disputed)', (await call(o7b, { action: 'pq_withdraw' }, 'buyer1', 'buyer')).json?.error_code === 'NOT_PAYMENT_QUERY_DISPUTE' && st(o7b) === 'disputed')
  ok('6c-P1. the fulfillment dispute row is NOT dismissed by the rejected withdraw', (db.prepare("SELECT status FROM disputes WHERE order_id=? ORDER BY created_at DESC LIMIT 1").get(o7b) as { status: string }).status === 'in_review')

  // 7. PR-B2 seller request_cancel (opens the 7-day buyer recourse window; only after the buyer-response grace elapsed)
  const cancelDl = (id: string) => (db.prepare('SELECT payment_query_cancel_deadline d FROM orders WHERE id=?').get(id) as { d: string | null }).d
  const o8 = mkOrder('accepted'); await call(o8, { action: 'report_nonpayment' }, 'seller1', 'seller')
  ok('7a. request_cancel BEFORE buyer grace elapsed → 409 GRACE_NOT_ELAPSED', (await call(o8, { action: 'request_cancel' }, 'seller1', 'seller')).json?.error_code === 'GRACE_NOT_ELAPSED')
  db.prepare("UPDATE orders SET payment_query_deadline = datetime('now','-1 hour') WHERE id=?").run(o8)   // buyer stayed silent past grace
  ok('7b. request_cancel AFTER grace → 200 + 7-day recourse deadline set', (await call(o8, { action: 'request_cancel' }, 'seller1', 'seller')).status === 200 && !!cancelDl(o8) && st(o8) === 'payment_query')
  ok('7c. buyer can still escalate DURING the recourse window (→ disputed)', (await call(o8, { action: 'pq_escalate', evidence_description: 'I did pay' }, 'buyer1', 'buyer')).status === 200 && st(o8) === 'disputed')
  const o9 = mkOrder('accepted'); await call(o9, { action: 'report_nonpayment' }, 'seller1', 'seller'); db.prepare("UPDATE orders SET payment_query_deadline = datetime('now','-1 hour') WHERE id=?").run(o9)
  ok('7d. buyer CANNOT request_cancel (403 NOT_ORDER_SELLER)', (await call(o9, { action: 'request_cancel' }, 'buyer1', 'buyer')).json?.error_code === 'NOT_ORDER_SELLER')

  server!.close()
  if (fail > 0) { console.error(`\n❌ payment_query actions FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ payment_query actions: seller report→negotiation(+grace) / confirm→resume / buyer cancel / escalate(evidence→dispute) / withdraw(before ruling); direct_p2p + role/status gated; escrow blocked\n  ✅ pass ${pass}`)
} catch (e) { try { server!.close() } catch {}; console.error('❌ threw:', (e as Error).message, (e as Error).stack); process.exit(1) }
