#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — direct_p2p 建单测试 (PR-4c)。
 * 验:helper 原子建单(本金不入协议/escrow_amount=0/buyer wallet 不动/仅锁卖家 fee-stake/扣库存;失败整体回滚)
 *   + 生产门(production base-bond)+ 收款指令门 fail-closed + 路由分叉(direct_p2p 不走 escrow)。
 * 本片 non-launchable:无 production base-bond 时建单必拒;测试自行 seed 一条 production-locked deposit 走 happy path。
 * Usage: npm run test:direct-pay-create
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-create-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerOrdersCreateRoutes } = await import('../src/pwa/routes/orders-create.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const { getActivePaymentInstruction } = await import('../src/direct-receive-payment-instruction.js')
const { sellerHasProductionBaseBondLocked } = await import('../src/direct-receive-deposits.js')
const { walletUnits } = await import('../src/ledger.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
initOrderChainSchema(db)
initSystemUser(db)
for (const [u, role] of [['buyer1', 'buyer'], ['seller1', 'seller']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('buyer1', 100)").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','T','d',50,10,'active')").run()

const ord = (id: string) => db.prepare('SELECT status, payment_rail, escrow_amount, direct_pay_instruction_snapshot FROM orders WHERE id=?').get(id) as any
const stake = (oid: string) => db.prepare('SELECT status, amount FROM direct_pay_fee_stakes WHERE order_id=?').get(oid) as any
const pstock = () => (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
const seedBond = (sellerId: string, production: boolean) => db.prepare(`INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run('dep_' + sellerId, sellerId, 'T0', 500, 500, 'usdc', 'manual', 'locked', production ? new Date().toISOString() : null)
const seedInstr = (sellerId: string) => db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES (?,?,?,?,'active')").run('pi_' + sellerId, sellerId, 'PayNow +65 9xxx (off-protocol)', 'PayNow')

// ══════ Part A: helper units ══════
// getActivePaymentInstruction
ok('instruction: none → null', getActivePaymentInstruction(db, 'seller1') === null)
seedInstr('seller1')
ok('instruction: active → returned', getActivePaymentInstruction(db, 'seller1')?.instruction?.includes('PayNow') === true)
db.prepare("UPDATE direct_receive_payment_instructions SET status='inactive' WHERE seller_id='seller1'").run()
ok('instruction: inactive → null', getActivePaymentInstruction(db, 'seller1') === null)
db.prepare("UPDATE direct_receive_payment_instructions SET status='active' WHERE seller_id='seller1'").run()

// sellerHasProductionBaseBondLocked
ok('prod-bond: none → false', sellerHasProductionBaseBondLocked(db, 'seller1') === false)
seedBond('seller1', false)  // locked but NO production receipt
ok('prod-bond: locked w/o receipt → false', sellerHasProductionBaseBondLocked(db, 'seller1') === false)
db.prepare("UPDATE direct_receive_deposits SET production_receipt_confirmed_at = ? WHERE user_id='seller1'").run(new Date().toISOString())
ok('prod-bond: locked + receipt → true', sellerHasProductionBaseBondLocked(db, 'seller1') === true)

// createDirectPayOrder atomic helper
const deps = { generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`, transition, appendOrderEvent }
const bBal = walletUnits(db, 'buyer1').balance, sBal = walletUnits(db, 'seller1').balance, st0 = pstock()
const { orderId: hOid } = createDirectPayOrder(db, deps, { productId: 'p1', sellerId: 'seller1', buyerId: 'buyer1', quantity: 1, unitPrice: 50, totalAmount: 50, feeUnits: toUnits(1), instructionSnapshot: 'snap', windowDeadlineIso: new Date(Date.now() + 3600_000).toISOString(), shippingAddress: 'addr' })
ok('helper: order in direct_pay_window', ord(hOid)?.status === 'direct_pay_window')
ok('helper: escrow_amount = 0 (本金不入协议)', ord(hOid)?.escrow_amount === 0)
ok('helper: buyer wallet UNCHANGED (不写 buyer wallet/principal)', walletUnits(db, 'buyer1').balance === bBal)
ok('helper: seller fee-stake locked (= 1)', stake(hOid)?.status === 'locked' && toUnits(stake(hOid)?.amount) === toUnits(1))
ok('helper: seller balance -1 (fee-stake), fee_staked +1', walletUnits(db, 'seller1').balance === sBal - toUnits(1))
ok('helper: instruction snapshot stored', ord(hOid)?.direct_pay_instruction_snapshot === 'snap')
ok('helper: stock decremented by 1', pstock() === st0 - 1)

// rollback: seller insufficient WAZ for fee-stake → no order, no stake, no stock change
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('poor','poor','seller','k_poor')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('poor', 0)").run()
const stBefore = pstock()
let threw = false
try { createDirectPayOrder(db, deps, { productId: 'p1', sellerId: 'poor', buyerId: 'buyer1', quantity: 1, unitPrice: 50, totalAmount: 50, feeUnits: toUnits(1), instructionSnapshot: 'x', windowDeadlineIso: new Date().toISOString(), shippingAddress: 'addr' }) } catch { threw = true }
ok('helper rollback: insufficient fee-stake → throws', threw)
ok('helper rollback: no order rows for poor seller', !db.prepare("SELECT 1 FROM orders WHERE seller_id='poor'").get())
ok('helper rollback: no fee-stake rows for poor seller', !db.prepare("SELECT 1 FROM direct_pay_fee_stakes WHERE seller_id='poor'").get())
ok('helper rollback: stock UNCHANGED', pstock() === stBefore)

// ══════ Part B: route integration (POST /api/orders payment_rail=direct_p2p) ══════
let oc = 0
const app = express(); app.use(express.json())
registerOrdersCreateRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++oc}`, generateRecipientCode: () => 'RC',
  DONATION_VALID_PCTS: new Set([0, 1, 2, 5]), INTERNAL_AUDITOR_ID: 'audit',
  addHours: (d: Date, h: number) => new Date(d.getTime() + h * 3600_000).toISOString(),
  getActiveFlashSale: () => null, applyCouponToOrder: () => ({ ok: false }),
  getProtocolParam: <T,>(_k: string, fb: T): T => fb,
  getProductShareChain: () => [], isAllowedSponsor: () => false, resolveInviteCodeRef: () => null,
  checkStockAndMaybeDelist: () => {}, auditSponsorChainCross: () => {},
  appendOrderEvent, transition, notifyTransition: () => {}, shouldAutoAccept: () => false,
  ensureCharityRep: () => {}, broadcastSystemEvent: () => {}, signPassport: async () => 'sig', issuerAddress: () => 'addr',
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
function post(body: Record<string, unknown>, uid?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (uid) headers['x-test-uid'] = uid
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/orders', headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}

// seller2: no bond, no instruction
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller2','s2','seller','k_s2')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller2', 100)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p2','seller2','T2','d',50,10,'active')").run()

// unauthenticated
ok('unauthenticated → 401', (await post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' })).status === 401)
// no production bond → 409 DIRECT_PAY_NOT_AVAILABLE
const rNoBond = await post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, 'buyer1')
ok('direct_p2p no production bond → 409 DIRECT_PAY_NOT_AVAILABLE', rNoBond.status === 409 && rNoBond.json?.error_code === 'DIRECT_PAY_NOT_AVAILABLE', JSON.stringify(rNoBond))
// production bond but no instruction → 409 NO_PAYMENT_INSTRUCTION
seedBond('seller2', true)
const rNoInstr = await post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, 'buyer1')
ok('direct_p2p bond, no instruction → 409 NO_PAYMENT_INSTRUCTION', rNoInstr.status === 409 && rNoInstr.json?.error_code === 'NO_PAYMENT_INSTRUCTION', JSON.stringify(rNoInstr))
// bond + instruction → 200 happy
seedInstr('seller2')
const bBal2 = walletUnits(db, 'buyer1').balance
const rOk = await post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, 'buyer1')
ok('direct_p2p bond + instruction → 200 direct_pay_window', rOk.status === 200 && rOk.json?.status === 'direct_pay_window', JSON.stringify(rOk))
ok('route happy: returns payment_instruction', typeof rOk.json?.payment_instruction === 'string' && rOk.json.payment_instruction.length > 0)
ok('route happy: buyer wallet UNCHANGED (no principal/escrow)', walletUnits(db, 'buyer1').balance === bBal2)
const createdId = rOk.json?.order_id
ok('route happy: order escrow_amount=0, rail=direct_p2p', ord(createdId)?.escrow_amount === 0 && ord(createdId)?.payment_rail === 'direct_p2p')
ok('route happy: seller fee-stake locked', stake(createdId)?.status === 'locked')
// self-fulfill 兼容:无 logistics_id / 未传 logistics_company_id 也能建单(后续走卖家自发货 action path)
ok('route happy: simple physical, NO logistics required (logistics_id NULL)', (db.prepare('SELECT logistics_id FROM orders WHERE id=?').get(createdId) as { logistics_id: string | null }).logistics_id == null)

// ══════ Part C: escrow-only / 不支持修饰 → fail-closed(helper 级,绕过 route 预校验)═══════
const { createDirectPayResponse } = await import('../src/direct-pay-create.js')
function mres(): any { const r: any = { _s: 200, _b: null, status(c: number) { r._s = c; return r }, json(b: any) { r._b = b; return r } }; return r }
const cdeps = { generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`, transition, appendOrderEvent, getProtocolParam: <T,>(_k: string, fb: T): T => fb }
const baseCtx = { product: { id: 'p1', seller_uid: 'seller1', source: null }, buyerId: 'buyer1', reqQty: 1, basePrice: 50, totalAmount: 50, totalAmountU: toUnits(50), shippingAddress: 'addr' }
const ordersN = () => (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n
const stakesN = () => (db.prepare('SELECT COUNT(*) n FROM direct_pay_fee_stakes').get() as { n: number }).n
function rejects(name: string, opts: Record<string, unknown>, code: string): void {
  const oN = ordersN(), sN = stakesN(), st = pstock(); const r = mres()
  createDirectPayResponse(r, db, cdeps, { ...baseCtx, opts })
  ok(`reject ${name} → 409 ${code}, no order/stake/stock`, r._s === 409 && r._b?.error_code === code && ordersN() === oN && stakesN() === sN && pstock() === st, JSON.stringify(r._b))
}
rejects('has_variants', { hasVariants: true }, 'DIRECT_PAY_SIMPLE_PRODUCT_ONLY')
rejects('variant_id', { variantId: 'v1' }, 'DIRECT_PAY_SIMPLE_PRODUCT_ONLY')
rejects('flash sale', { flashActive: true }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
rejects('coupon', { couponCode: 'SAVE10' }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
rejects('insurance', { buyInsurance: true }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
rejects('donation', { donationPct: 0.01 }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
rejects('gift', { isGift: true }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
rejects('anonymous', { anonymous: true }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
rejects('delivery_window', { deliveryWindow: true }, 'DIRECT_PAY_UNSUPPORTED_OPTION')
// 正向:无任何修饰(simple physical)→ 不被 Part C 门拦(继续到生产门;seller1 有 production bond+instr → 建单成功,验证 simple 物理单可建)
const okRes = mres()
const oN0 = ordersN()
createDirectPayResponse(okRes, db, cdeps, baseCtx)
ok('simple physical (no modifiers) passes the modifier gate → 200 created', okRes._s === 200 && okRes._b?.status === 'direct_pay_window' && ordersN() === oN0 + 1, JSON.stringify(okRes._b))

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-create tests passed`)
