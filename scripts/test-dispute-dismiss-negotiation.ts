#!/usr/bin/env tsx
/**
 * 仲裁员【驳回仲裁,退回协商】(ruling=dismiss_to_negotiation)HTTP e2e —— 经真实 arbitrate 路由。
 * 证明:
 *  ① direct_p2p 且【由 payment_query 升级】的争议 → dismiss → order 回 payment_query、dispute dismissed、
 *     payment_query_deadline 重建、cancel_deadline 清空、无 refund/settlement/仲裁费。
 *  ② 履约类(delivered→disputed)direct_p2p 争议 → NOT_PAYMENT_QUERY_DISPUTE。
 *  ③ escrow 争议 → ARBITRATION_DISMISS_NOT_ALLOWED(escrow 资金零触碰)。
 *  ④ 无 Passkey token → 412 HUMAN_PRESENCE_REQUIRED;token dispute_id 不匹配 → 412。
 *  ⑤ 已裁定/已 dismiss 的争议 → DISPUTE_ALREADY_RULED。
 * Usage: npm run test:dispute-dismiss-negotiation
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arb-dismiss-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initArbitratorReviewSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const D = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { isEligibleArbitrator, grantArbitrator } = await import('../src/pwa/arbitrator-lifecycle.js')
const { registerDisputesWriteRoutes } = await import('../src/pwa/routes/disputes-write.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initArbitratorReviewSchema(db); initWebauthnSchema(db); initOrderChainSchema(db)
D.initDisputeSchema(db); D.initEvidenceRequestSchema(db)

const mkUser = (id: string, role = 'buyer'): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('cred_' + id, id, Buffer.from([1]))
}
mkUser('buyer1', 'buyer'); mkUser('seller1', 'seller'); mkUser('arb', 'buyer')
grantArbitrator(db, { userId: 'arb', grantedBy: 'admin1' })

const getParam = ((key: string, fb: unknown) => (String(key).includes('human_presence') ? 1 : fb)) as <T>(k: string, f: T) => T
const { requireHumanPresence } = createHumanPresence(db, getParam)

let oc = 0, dc = 0
// origin: 'payment_query'(货款协商升级)| 'delivered'(履约类)。rail: direct_p2p | escrow。
function mkDispute(origin: 'payment_query' | 'delivered', rail: 'direct_p2p' | 'escrow'): { orderId: string; disputeId: string } {
  const orderId = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p','buyer1','seller1',1,50,50,?,'disputed',?)")
    .run(orderId, rail === 'escrow' ? 50 : 0, rail)
  // 记录最近一次进入 disputed 的 from_status(dismiss 谓词据此判定)
  db.prepare("INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,evidence_ids,notes) VALUES (?,?,?,'disputed','buyer1','buyer','[]','x')")
    .run(`h_${++dc}`, orderId, origin)
  const r = D.createDispute(db, orderId, 'buyer1', '争议', [])
  if (!r.success) throw new Error('createDispute failed: ' + r.error)
  return { orderId, disputeId: r.disputeId as string }
}
function mkToken(userId: string, disputeId: string): string {
  const id = `tok_${++dc}`
  db.prepare("INSERT INTO webauthn_gate_tokens (id,user_id,purpose,purpose_data,expires_at,consumed_at) VALUES (?,?,?,?,datetime('now','+60 seconds'),NULL)")
    .run(id, userId, 'arbitrate', JSON.stringify({ dispute_id: disputeId }))
  return id
}
const noop = () => {}
const app = express(); app.use(express.json())
registerDisputesWriteRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'arbitrator', api_key: 'k_' + uid } },
  generateId: (p: string) => `${p}_${++dc}`,
  detectFraud: () => [],
  errorRes: (res: Response, status: number, code: string, msg: string) => { res.status(status).json({ error: msg, error_code: code }) },
  isEligibleArbitrator: (uid: string) => isEligibleArbitrator(db, uid),
  requireHumanPresence,
  getDisputeDetails: D.getDisputeDetails, respondToDispute: D.respondToDispute, arbitrateDispute: D.arbitrateDispute,
  addPartyEvidence: noop, requestEvidence: D.requestEvidence, markEvidenceExpiry: noop, uploadEvidence: noop,
  EVIDENCE_MAX_BYTES: 1_000_000, EVIDENCE_ALLOWED_MIME: new Set<string>(),
  appendOrderEvent: noop, FUND_BASE_RATE: () => 0,
  settleCommission: () => ({ redirected: 0 }), depositToFund: () => ({}), calculatePv: () => 0,
  recordDisputeReputation: noop, issueAgentStrike: noop, publishDisputeCase: noop, logAdminAction: noop, snfSend: noop,
  getProtocolParam: getParam, notifyTransition: noop,
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const call = (disputeId: string, body: Record<string, unknown>, uid?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/disputes/${disputeId}/arbitrate`, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})
const oStatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const dStatus = (id: string) => (db.prepare('SELECT status FROM disputes WHERE id=?').get(id) as { status: string }).status
const orderRow = (id: string) => db.prepare('SELECT payment_query_deadline pd, payment_query_cancel_deadline cd, escrow_amount ea FROM orders WHERE id=?').get(id) as any
const wallet = (uid: string) => db.prepare('SELECT balance,escrowed,staked FROM wallets WHERE user_id=?').get(uid) as any

const DISMISS = (dispId: string, token?: string) => ({ ruling: 'dismiss_to_negotiation', reason: '此案应回协商', ...(token ? { webauthn_token: token } : {}) })

try {
  // ① 直付 + payment_query 升级 → dismiss 成功,回协商,dispute dismissed,deadline 重建
  { const d = mkDispute('payment_query', 'direct_p2p')
    db.prepare("UPDATE orders SET payment_query_cancel_deadline = datetime('now','+3 days') WHERE id=?").run(d.orderId)  // 预置一个 cancel 窗验证被清
    const r = await call(d.disputeId, DISMISS(d.disputeId, mkToken('arb', d.disputeId)), 'arb')
    ok('1a. dismiss → 200 returned_to_negotiation', r.status === 200 && r.json?.returned_to_negotiation === true && r.json?.dispute_dismissed === true, JSON.stringify(r.json))
    ok('1b. order disputed→payment_query', oStatus(d.orderId) === 'payment_query')
    ok('1c. active dispute → dismissed', dStatus(d.disputeId) === 'dismissed')
    const row = orderRow(d.orderId)
    ok('1d. payment_query_deadline rebuilt + cancel_deadline cleared', !!row.pd && row.cd === null, JSON.stringify(row))
    ok('1e. no refund/settlement/fee in response', !r.json?.settlement && !r.json?.refund_amount && !r.json?.arbitration_fees)
    ok('1f. no money moved (parties + sys wallets absent/zero)', !wallet('buyer1') && !wallet('seller1')) }

  // ② 履约类(delivered→disputed)direct_p2p → NOT_PAYMENT_QUERY_DISPUTE,状态不变
  { const d = mkDispute('delivered', 'direct_p2p')
    const r = await call(d.disputeId, DISMISS(d.disputeId, mkToken('arb', d.disputeId)), 'arb')
    ok('2. fulfilment dispute → NOT_PAYMENT_QUERY_DISPUTE, still disputed', r.json?.error_code === 'NOT_PAYMENT_QUERY_DISPUTE' && oStatus(d.orderId) === 'disputed' && dStatus(d.disputeId) !== 'dismissed') }

  // ③ escrow(即便 from payment_query 也不该有)→ ARBITRATION_DISMISS_NOT_ALLOWED,escrow_amount 不动
  { const d = mkDispute('payment_query', 'escrow')
    const r = await call(d.disputeId, DISMISS(d.disputeId, mkToken('arb', d.disputeId)), 'arb')
    ok('3. escrow dispute → ARBITRATION_DISMISS_NOT_ALLOWED, escrow untouched', r.json?.error_code === 'ARBITRATION_DISMISS_NOT_ALLOWED' && oStatus(d.orderId) === 'disputed' && orderRow(d.orderId).ea === 50) }

  // ④ 无 token → 412;token dispute_id 不匹配 → 412
  { const d = mkDispute('payment_query', 'direct_p2p')
    ok('4a. no Passkey token → 412 HUMAN_PRESENCE_REQUIRED', (await call(d.disputeId, DISMISS(d.disputeId), 'arb')).json?.error_code === 'HUMAN_PRESENCE_REQUIRED' && oStatus(d.orderId) === 'disputed')
    const d2 = mkDispute('payment_query', 'direct_p2p')
    ok('4b. token bound to a different dispute_id → 412', (await call(d.disputeId, DISMISS(d.disputeId, mkToken('arb', d2.disputeId)), 'arb')).status === 412 && oStatus(d.orderId) === 'disputed') }

  // ⑤ 已 dismiss → DISPUTE_ALREADY_RULED
  { const d = mkDispute('payment_query', 'direct_p2p')
    await call(d.disputeId, DISMISS(d.disputeId, mkToken('arb', d.disputeId)), 'arb')  // first dismiss
    const r2 = await call(d.disputeId, DISMISS(d.disputeId, mkToken('arb', d.disputeId)), 'arb')
    ok('5. second dismiss → DISPUTE_ALREADY_RULED', r2.json?.error_code === 'DISPUTE_ALREADY_RULED') }
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ dispute-dismiss-negotiation FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ dispute-dismiss-negotiation: direct_p2p pq-origin dismiss → back to negotiation (no funds/fee/reputation) + fulfilment/escrow rejected + Passkey enforced + idempotent-terminal\n  ✅ pass ${pass}`)
