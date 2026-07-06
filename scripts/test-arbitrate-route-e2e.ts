#!/usr/bin/env tsx
/**
 * PR-D end-to-end:真人被授权仲裁员经【HTTP 仲裁路由】接住→裁决→终结一个 direct_p2p 争议(非托管=仅信誉/订单结果,
 *   零退款/放款),且所有门都在路由里串起来:eligibility(active whitelist)+ 现场 Passkey + COI + 领取。
 * 证明 grant(PR-B)+ Passkey(PR-C)+ COI + engine 在真实路由上闭环。escrow 结算正确性由 test-dispute-noncustodial 覆盖。
 * Usage: npm run test:arbitrate-route-e2e
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arb-e2e-'))
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
mkUser('buyer1', 'buyer'); mkUser('seller1', 'seller'); mkUser('arb', 'buyer'); mkUser('arb2', 'buyer'); mkUser('outsider', 'buyer'); mkUser('roleArb', 'arbitrator')
grantArbitrator(db, { userId: 'arb', grantedBy: 'admin1' })      // active whitelist, non-party
grantArbitrator(db, { userId: 'arb2', grantedBy: 'admin1' })     // 第二个 active 仲裁员(测已领取案的越权补证)
grantArbitrator(db, { userId: 'buyer1', grantedBy: 'admin1' })   // 也授权买家 → 用于 COI(当事方)测试

const getParam = ((key: string, fb: unknown) => (String(key).includes('human_presence') ? 1 : fb)) as <T>(k: string, f: T) => T
const { requireHumanPresence } = createHumanPresence(db, getParam)

let oc = 0, dc = 0
function mkDispute(): { orderId: string; disputeId: string } {
  const orderId = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p','buyer1','seller1',1,50,50,0,'disputed','direct_p2p')").run(orderId)
  const r = D.createDispute(db, orderId, 'buyer1', '我已付款,卖家不认', [])
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
  getProtocolParam: getParam,
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const call = (disputeId: string, body: Record<string, unknown>, uid?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/disputes/${disputeId}/arbitrate`, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})
const callReq = (disputeId: string, body: Record<string, unknown>, uid?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/disputes/${disputeId}/request-evidence`, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})
const orderStatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const dispStatus = (id: string) => (db.prepare('SELECT status FROM disputes WHERE id=?').get(id) as { status: string }).status

try {
  // ① 授权真人仲裁员(非当事方)+ 现场 Passkey → 经路由裁决 direct_p2p 争议 → 终结,零资金
  const d1 = mkDispute()
  const r1 = await call(d1.disputeId, { ruling: 'refund_buyer', reason: '证据支持买家', webauthn_token: mkToken('arb', d1.disputeId) }, 'arb')
  ok('1. granted non-party arbitrator + Passkey → rules via route (200, non_custodial)', r1.status === 200 && (r1.json?.non_custodial === true || r1.json?.settlement?.non_custodial === true), JSON.stringify(r1.json))
  ok('1b. order reached terminal (refunded_full) via route', orderStatus(d1.orderId) === 'refunded_full')
  ok('1c. dispute resolved', dispStatus(d1.disputeId) === 'resolved')

  // ② 无 Passkey → 412
  const d2 = mkDispute()
  ok('2. arbitrate WITHOUT Passkey → 412 HUMAN_PRESENCE_REQUIRED', (await call(d2.disputeId, { ruling: 'refund_buyer', reason: 'x' }, 'arb')).json?.error_code === 'HUMAN_PRESENCE_REQUIRED' && orderStatus(d2.orderId) === 'disputed')

  // ③ COI:当事方(买家,虽也被授权)→ 403,不得裁自己的案
  const d3 = mkDispute()
  ok('3. party (buyer, even if whitelisted) blocked by COI → 403', (await call(d3.disputeId, { ruling: 'refund_buyer', reason: 'x', webauthn_token: mkToken('buyer1', d3.disputeId) }, 'buyer1')).json?.error_code === 'ARBITRATOR_CONFLICT_OF_INTEREST' && orderStatus(d3.orderId) === 'disputed')

  // ④ 未授权(不在白名单)→ 403 NOT_ARBITRATOR(在 Passkey 之前)
  const d4 = mkDispute()
  ok('4. non-whitelisted user → 403 NOT_ARBITRATOR', (await call(d4.disputeId, { ruling: 'refund_buyer', reason: 'x', webauthn_token: 'whatever' }, 'outsider')).json?.error_code === 'NOT_ARBITRATOR')

  // ⑤ suspended 仲裁员 → 403(eligibility 只认 active)
  const { suspendArbitrator, reinstateArbitrator } = await import('../src/pwa/arbitrator-lifecycle.js')
  suspendArbitrator(db, { userId: 'arb' })
  const d5 = mkDispute()
  ok('5. suspended arbitrator → 403 NOT_ARBITRATOR', (await call(d5.disputeId, { ruling: 'refund_buyer', reason: 'x', webauthn_token: mkToken('arb', d5.disputeId) }, 'arb')).json?.error_code === 'NOT_ARBITRATOR')
  reinstateArbitrator(db, { userId: 'arb' })
  ok('5b. reinstated arbitrator can rule again via route', (await call(d5.disputeId, { ruling: 'refund_buyer', reason: 'ok', webauthn_token: mkToken('arb', d5.disputeId) }, 'arb')).status === 200 && orderStatus(d5.orderId) === 'refunded_full')

  // ── PR-E request-evidence:active + 已分配/领取该案 + 涉案方目标 ──
  const re1 = mkDispute()   // fresh, unassigned
  ok('RE1. active arbitrator + unassigned → atomic claim + request-evidence succeeds (target=party seller)', (await callReq(re1.disputeId, { requested_from_id: 'seller1', evidence_types: ['text'], description: '请提供发货凭证', deadline_hours: 48 }, 'arb')).json?.success === true)
  ok('RE2. second active arbitrator on the now-claimed case → NOT_ASSIGNED_ARBITRATOR', (await callReq(re1.disputeId, { requested_from_id: 'buyer1', evidence_types: ['text'], description: 'x' }, 'arb2')).json?.error_code === 'NOT_ASSIGNED_ARBITRATOR')
  ok('RE3. assigned arbitrator requests from NON-party → INVALID_EVIDENCE_TARGET', (await callReq(re1.disputeId, { requested_from_id: 'outsider', evidence_types: ['text'], description: 'x' }, 'arb')).json?.error_code === 'INVALID_EVIDENCE_TARGET')
  ok('RE-COI. whitelisted PARTY (buyer) cannot request-evidence on own case → ARBITRATOR_CONFLICT_OF_INTEREST', (await callReq(mkDispute().disputeId, { requested_from_id: 'seller1', evidence_types: ['text'], description: 'x' }, 'buyer1')).json?.error_code === 'ARBITRATOR_CONFLICT_OF_INTEREST')
  ok('RE4. non-whitelisted user → NOT_ARBITRATOR on request-evidence', (await callReq(mkDispute().disputeId, { requested_from_id: 'seller1', evidence_types: ['text'], description: 'x' }, 'outsider')).json?.error_code === 'NOT_ARBITRATOR')
  ok('RE5. role-only (no whitelist) → NOT_ARBITRATOR on request-evidence', (await callReq(mkDispute().disputeId, { requested_from_id: 'seller1', evidence_types: ['text'], description: 'x' }, 'roleArb')).json?.error_code === 'NOT_ARBITRATOR')
  { const { suspendArbitrator, reinstateArbitrator } = await import('../src/pwa/arbitrator-lifecycle.js')
    suspendArbitrator(db, { userId: 'arb' })
    ok('RE6. suspended arbitrator → NOT_ARBITRATOR on request-evidence', (await callReq(mkDispute().disputeId, { requested_from_id: 'seller1', evidence_types: ['text'], description: 'x' }, 'arb')).json?.error_code === 'NOT_ARBITRATOR')
    reinstateArbitrator(db, { userId: 'arb' }) }

  server!.close()
  if (fail > 0) { console.error(`\n❌ arbitrate-route-e2e FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ arbitrate-route-e2e: granted human arbitrator catches→rules→terminates a direct_p2p dispute via HTTP route (eligibility+Passkey+COI+claim), reputation-only zero funds; suspended/party/non-whitelisted blocked\n  ✅ pass ${pass}`)
} catch (e) { console.error(e); server!.close(); process.exit(1) }
