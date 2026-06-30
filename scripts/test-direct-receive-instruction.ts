#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 卖家收款说明 CRUD 端点测试 (PR-4f-a) — 真 express + 真 helper(set/deactivate/getActive)。
 * 验:auth 门(401/403)、PUT 校验(必填/trim/长度)、单一 active 不变量(替换不留多条)、DELETE 软停用、
 *   停用后 getActivePaymentInstruction → null 且 #94 create route fail-closed NO_PAYMENT_INSTRUCTION,
 *   有 active + production-bond fixture 时 create route 过收款指令门。纯展示文本 CRUD,不碰 wallet/escrow/order。
 * Usage: npm run test:direct-receive-instruction
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dr-instr-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerDirectReceivePaymentInstructionRoutes } = await import('../src/pwa/routes/direct-receive-payment-instructions.js')
const { registerOrdersCreateRoutes } = await import('../src/pwa/routes/orders-create.js')
const { getActivePaymentInstruction } = await import('../src/direct-receive-payment-instruction.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
initOrderChainSchema(db)
initSystemUser(db)
for (const [u, role] of [['buyer1', 'buyer'], ['seller1', 'seller'], ['seller2', 'seller']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('buyer1', 100)").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','T','d',50,10,'active')").run()
// PR-④ per-product verification is a HARD GATE before the instruction gate; verify p1 so this test reaches the instruction check it targets.
db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES ('pvf_p1','p1','seller1','wzv_p1','verified','admin1',datetime('now'))").run()
const seedBond = (sellerId: string) => db.prepare("INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run('dep_' + sellerId, sellerId, 'T0', 500, 500, 'usdc', 'manual', 'locked', new Date().toISOString())

const activeCount = (s: string) => (db.prepare("SELECT COUNT(*) n FROM direct_receive_payment_instructions WHERE seller_id=? AND status='active'").get(s) as { n: number }).n

// ── route under test (instruction CRUD) ──
let oc = 0
const app = express(); app.use(express.json())
const auth = (req: Request, res: Response) => {
  const uid = req.headers['x-test-uid'] as string | undefined
  const role = req.headers['x-test-role'] as string | undefined
  if (!uid) { res.status(401).json({ error: 'login required' }); return null }
  return { id: uid, role: role || 'seller' }
}
registerDirectReceivePaymentInstructionRoutes(app, { db, auth, generateId: (p: string) => `${p}_${++oc}` })
// #94 create route on the same app (to prove instruction gate is real)
registerOrdersCreateRoutes(app, {
  db, auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++oc}`, generateRecipientCode: () => 'RC',
  DONATION_VALID_PCTS: new Set([0, 1, 2, 5]), INTERNAL_AUDITOR_ID: 'audit',
  addHours: (d: Date, h: number) => new Date(d.getTime() + h * 3600_000).toISOString(),
  getActiveFlashSale: () => null, applyCouponToOrder: () => ({ ok: false }),
  // Phase 4a 控制面:开启全局/地区/上限,让 create 走到收款指令门(本测试聚焦 instruction gate,不测控制面拒绝矩阵)。
  getProtocolParam: <T,>(k: string, fb: T): T => { const m: Record<string, unknown> = { 'direct_pay.enabled': true, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG', 'direct_pay.per_tx_cap_units': 1_000_000_000, 'direct_pay.fee_ar_credit_ceiling_units': 1_000_000_000 }; return k in m ? m[k] as T : fb },
  getProductShareChain: () => [], isAllowedSponsor: () => false, resolveInviteCodeRef: () => null,
  checkStockAndMaybeDelist: () => {}, auditSponsorChainCross: () => {},
  appendOrderEvent, transition, notifyTransition: () => {}, shouldAutoAccept: () => false,
  ensureCharityRep: () => {}, broadcastSystemEvent: () => {}, signPassport: async () => 'sig', issuerAddress: () => 'addr',
})

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })

function call(method: 'POST' | 'GET' | 'PUT' | 'DELETE', path: string, body: Record<string, unknown> | null, h: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...h }
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null }) } catch { resolve({ status: res.statusCode || 0, json: data }) } })
    })
    rq.on('error', reject); if (payload) rq.write(payload); rq.end()
  })
}
const seller = (uid: string) => ({ 'x-test-uid': uid, 'x-test-role': 'seller' })
const PI = '/api/direct-receive/payment-instruction'

// ── 1. auth gates ──
ok('GET unauthenticated → 401', (await call('GET', PI, null)).status === 401)
ok('PUT unauthenticated → 401', (await call('PUT', PI, { instruction: 'x' })).status === 401)
ok('DELETE unauthenticated → 401', (await call('DELETE', PI, null)).status === 401)
const r2 = await call('PUT', PI, { instruction: 'x' }, { 'x-test-uid': 'buyer1', 'x-test-role': 'buyer' })
ok('non-seller (buyer) PUT → 403 SELLER_ONLY', r2.status === 403 && r2.json?.error_code === 'SELLER_ONLY', JSON.stringify(r2))
ok('non-seller GET → 403', (await call('GET', PI, null, { 'x-test-uid': 'buyer1', 'x-test-role': 'buyer' })).status === 403)

// ── 2. GET when none → instruction:null ──
const g0 = await call('GET', PI, null, seller('seller1'))
ok('GET (none) → 200 instruction:null', g0.status === 200 && g0.json?.instruction === null, JSON.stringify(g0))

// ── 3. PUT validation ──
ok('PUT empty instruction → 400 INSTRUCTION_REQUIRED', (await call('PUT', PI, { instruction: '   ' }, seller('seller1'))).json?.error_code === 'INSTRUCTION_REQUIRED')
ok('PUT missing instruction → 400', (await call('PUT', PI, {}, seller('seller1'))).json?.error_code === 'INSTRUCTION_REQUIRED')
ok('PUT instruction too long → 400 INSTRUCTION_TOO_LONG', (await call('PUT', PI, { instruction: 'a'.repeat(501) }, seller('seller1'))).json?.error_code === 'INSTRUCTION_TOO_LONG')
ok('PUT label too long → 400 LABEL_TOO_LONG', (await call('PUT', PI, { instruction: 'ok', label: 'a'.repeat(41) }, seller('seller1'))).json?.error_code === 'LABEL_TOO_LONG')
ok('failed PUTs created no active row', activeCount('seller1') === 0)

// ── 4. PUT set active (with trim) ──
const p1 = await call('PUT', PI, { instruction: '  PayNow +65 9xxx (off-protocol)  ', label: '  PayNow  ' }, seller('seller1'))
ok('PUT set → 200 ok + trimmed instruction/label', p1.status === 200 && p1.json?.ok === true && p1.json?.instruction?.instruction === 'PayNow +65 9xxx (off-protocol)' && p1.json?.instruction?.label === 'PayNow', JSON.stringify(p1))
ok('exactly 1 active after set', activeCount('seller1') === 1)
ok('getActivePaymentInstruction returns it', getActivePaymentInstruction(db, 'seller1')?.instruction === 'PayNow +65 9xxx (off-protocol)')
const g1 = await call('GET', PI, null, seller('seller1'))
ok('GET returns the active instruction', g1.json?.instruction?.instruction === 'PayNow +65 9xxx (off-protocol)' && g1.json?.instruction?.label === 'PayNow')

// ── 5. PUT replace → active stays single ──
const p2 = await call('PUT', PI, { instruction: 'Bank transfer DBS 123-456', label: 'Bank' }, seller('seller1'))
ok('PUT replace → 200', p2.status === 200 && p2.json?.instruction?.instruction === 'Bank transfer DBS 123-456')
ok('still exactly 1 active after replace (no competing actives)', activeCount('seller1') === 1)
ok('getActive reflects the replacement', getActivePaymentInstruction(db, 'seller1')?.instruction === 'Bank transfer DBS 123-456')
ok('label optional: PUT without label → null', (await call('PUT', PI, { instruction: 'Cash on delivery' }, seller('seller1'))).json?.instruction?.label === null)
ok('still single active after label-less set', activeCount('seller1') === 1)

// ── 6. one seller's instruction does not leak to another ──
ok('seller2 GET → null (no cross-seller leak)', (await call('GET', PI, null, seller('seller2'))).json?.instruction === null)

// ── 7. create route gate is REAL: with active instruction + production bond, instruction gate passes ──
seedBond('seller1')  // production base-bond fixture
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc_seller1','seller1','clear')").run()  // 制裁筛查 clear
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kyb_seller1','seller1','approved')").run()  // Phase 6A:KYB approved → KYB AND sanctions 门通过 → 只剩 instruction 门

const co1 = await call('POST', '/api/orders', { product_id: 'p1', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, { 'x-test-uid': 'buyer1' })
ok('create route passes instruction gate when active instruction exists', co1.status === 200 && co1.json?.error_code !== 'NO_PAYMENT_INSTRUCTION', JSON.stringify(co1))

// ── 8. DELETE deactivate → getActive null + create route fail-closed NO_PAYMENT_INSTRUCTION ──
const d1 = await call('DELETE', PI, null, seller('seller1'))
ok('DELETE → 200 deactivated:true', d1.status === 200 && d1.json?.deactivated === true, JSON.stringify(d1))
ok('no active after deactivate', activeCount('seller1') === 0)
ok('getActivePaymentInstruction → null after deactivate', getActivePaymentInstruction(db, 'seller1') === null)
const co2 = await call('POST', '/api/orders', { product_id: 'p1', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, { 'x-test-uid': 'buyer1' })
ok('create route fail-closed NO_PAYMENT_INSTRUCTION after deactivate', co2.status === 409 && co2.json?.error_code === 'NO_PAYMENT_INSTRUCTION', JSON.stringify(co2))
ok('DELETE when none active → deactivated:false (idempotent)', (await call('DELETE', PI, null, seller('seller1'))).json?.deactivated === false)

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-receive-instruction tests passed`)
