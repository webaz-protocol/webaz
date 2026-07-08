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
const { initSystemUser, transition, getOrderStatus } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
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
try { db.exec('ALTER TABLE orders ADD COLUMN settled_fault_at TEXT') } catch { /* boot-ALTER col;缓交配额 SQL 用它排除拒单/违约结算单 */ }
setSeamDb(db)
initOrderChainSchema(db)
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
initNotificationSchema(db)   // 审计项 B:建单 → 卖家模板通知断言用
initSystemUser(db)
for (const [u, role] of [['buyer1', 'buyer'], ['seller1', 'seller']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('buyer1', 100)").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','T','d',50,10,'active')").run()

const ord = (id: string) => db.prepare('SELECT status, payment_rail, escrow_amount, direct_pay_instruction_snapshot, direct_pay_account_snapshot FROM orders WHERE id=?').get(id) as any
const stake = (oid: string) => db.prepare('SELECT status, amount FROM direct_pay_fee_stakes WHERE order_id=?').get(oid) as any
const pstock = () => (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
const seedBond = (sellerId: string, production: boolean) => db.prepare(`INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run('dep_' + sellerId, sellerId, 'T0', 500, 500, 'usdc', 'manual', 'locked', production ? new Date().toISOString() : null)
const seedInstr = (sellerId: string) => db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES (?,?,?,?,'active')").run('pi_' + sellerId, sellerId, 'PayNow +65 9xxx (off-protocol)', 'PayNow')
// PR-④ per-product verification is now a HARD GATE on direct-pay. Seed a verified row so existing happy-path products stay eligible.
const seedProductVerified = (productId: string, sellerId: string) => db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES (?,?,?,?, 'verified', 'admin1', datetime('now'))").run('pvf_' + productId, productId, sellerId, 'wzv_' + productId)
seedProductVerified('p1', 'seller1')

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
// PR-5b frozen-at-create policy 快照(helper 直测用一个代表性快照)。
const SNAP = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG', 'MY'], perTxCapUnits: toUnits(1000), sellerBreakerTripped: false, decisionCode: 'OK' }
const snapRow = (id: string) => db.prepare('SELECT direct_pay_enabled_snapshot e, direct_pay_rail_breaker_snapshot rb, direct_pay_region_snapshot rg, direct_pay_region_allowlist_snapshot al, direct_pay_per_tx_cap_units_snapshot cap, direct_pay_seller_breaker_snapshot sb, direct_pay_decision_code dc FROM orders WHERE id=?').get(id) as any
const bBal = walletUnits(db, 'buyer1').balance, sBal = walletUnits(db, 'seller1').balance, st0 = pstock()
const { orderId: hOid } = createDirectPayOrder(db, deps, { productId: 'p1', sellerId: 'seller1', buyerId: 'buyer1', quantity: 1, unitPrice: 50, totalAmount: 50, instructionSnapshot: 'snap', windowDeadlineIso: new Date(Date.now() + 3600_000).toISOString(), shippingAddress: 'addr', snapshot: SNAP })
ok('helper: order in direct_pay_window', ord(hOid)?.status === 'direct_pay_window')
ok('helper: escrow_amount = 0 (本金不入协议)', ord(hOid)?.escrow_amount === 0)
ok('helper: buyer wallet UNCHANGED (不写 buyer wallet/principal)', walletUnits(db, 'buyer1').balance === bBal)
ok('helper: NO fee-stake at create (AR model:费用完成时记应收,建单不锁)', stake(hOid) === undefined)
ok('helper: seller wallet UNCHANGED at create (建单无资金写)', walletUnits(db, 'seller1').balance === sBal)
ok('helper: instruction snapshot stored', ord(hOid)?.direct_pay_instruction_snapshot === 'snap')
ok('helper: stock decremented by 1', pstock() === st0 - 1)
// PR-5b: policy 快照随订单 INSERT 一同写入(同一 tx);布尔 0/1、cap 整数、allowlist=JSON.stringify 数组、decision='OK'。
const hs = snapRow(hOid)
ok('helper: policy snapshot written (enabled/rail/seller as 0/1, cap int, region, allowlist JSON, decision OK)',
  hs.e === 1 && hs.rb === 0 && hs.sb === 0 && hs.rg === 'SG' && hs.al === JSON.stringify(['SG', 'MY']) && hs.cap === toUnits(1000) && hs.dc === 'OK', JSON.stringify(hs))

// rollback: stock depleted → 整体回滚(no order, no stock change)。AR 模型下建单无资金写,唯一可回滚的写=扣库存。
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('poor','poor','seller','k_poor')").run()
const stBefore = pstock()
let threw = false
try { createDirectPayOrder(db, deps, { productId: 'p1', sellerId: 'seller1', buyerId: 'buyer1', quantity: stBefore + 999, unitPrice: 50, totalAmount: 50, instructionSnapshot: 'x', windowDeadlineIso: new Date().toISOString(), shippingAddress: 'addr', snapshot: SNAP }) } catch { threw = true }
ok('helper rollback: stock depleted → throws', threw)
ok('helper rollback: stock UNCHANGED after failed create', pstock() === stBefore)

// ══════ Part B: route integration (POST /api/orders payment_rail=direct_p2p) ══════
// Phase 4a 控制面参数:可变,便于在同一 app 上分别测 disabled/region/cap/enabled。默认空 = fail-closed(disabled)。
const cp: Record<string, unknown> = {}
const seedSanctions = (sellerId: string) => db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES (?,?,'clear')").run('sc_' + sellerId, sellerId)
const seedKyb = (sellerId: string, status = 'approved') => db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES (?,?,?)").run('kyb_' + sellerId, sellerId, status)
let oc = 0
const app = express(); app.use(express.json())
registerOrdersCreateRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++oc}`, generateRecipientCode: () => 'RC',
  DONATION_VALID_PCTS: new Set([0, 1, 2, 5]), INTERNAL_AUDITOR_ID: 'audit',
  addHours: (d: Date, h: number) => new Date(d.getTime() + h * 3600_000).toISOString(),
  getActiveFlashSale: () => null, applyCouponToOrder: () => ({ ok: false }),
  getProtocolParam: <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb),
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
seedProductVerified('p2', 'seller2')

const dp = (uid?: string) => post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, uid)
// unauthenticated
ok('unauthenticated → 401', (await dp()).status === 401)
// Phase 4a 控制面:默认(cp 空)= 全局 disabled → fail-closed
const rDisabled = await dp('buyer1')
ok('direct_p2p disabled by default → 409 DIRECT_PAY_DISABLED', rDisabled.status === 409 && rDisabled.json?.error_code === 'DIRECT_PAY_DISABLED', JSON.stringify(rDisabled))
// 开启全局但运营熔断 → RAIL_BREAKER(在 region/cap 之前)
Object.assign(cp, { 'direct_pay.enabled': true, 'direct_pay.rail_breaker_tripped': true })
ok('enabled but rail breaker tripped → 409 DIRECT_PAY_RAIL_BREAKER', (await dp('buyer1')).json?.error_code === 'DIRECT_PAY_RAIL_BREAKER')
cp['direct_pay.rail_breaker_tripped'] = false
// 开启全局,但地区不在白名单 → REGION_UNSUPPORTED
Object.assign(cp, { 'direct_pay.enabled': true, 'direct_pay.region': 'US', 'direct_pay.region_allowlist': 'SG', 'direct_pay.per_tx_cap_units': toUnits(1000) })
ok('enabled but region not allowed → 409 DIRECT_PAY_REGION_UNSUPPORTED', (await dp('buyer1')).json?.error_code === 'DIRECT_PAY_REGION_UNSUPPORTED')
// 地区放开,但单笔上限低于金额(p2=50,cap=10)→ CAP_EXCEEDED
cp['direct_pay.region'] = 'SG'; cp['direct_pay.per_tx_cap_units'] = toUnits(10)
ok('amount over per-tx cap → 409 DIRECT_PAY_CAP_EXCEEDED', (await dp('buyer1')).json?.error_code === 'DIRECT_PAY_CAP_EXCEEDED')
// 上限恢复;此后控制面全开,仅卖家事实(suspended/bond/KYC/instruction)决定结果
cp['direct_pay.per_tx_cap_units'] = toUnits(1000)
// 卖家熔断(direct_receive_privileges.status='suspended')→ SELLER_SUSPENDED(在 base-bond/KYC 之前)
db.prepare("INSERT INTO direct_receive_privileges (user_id, status, tier) VALUES ('seller2','suspended','T0') ON CONFLICT(user_id) DO UPDATE SET status='suspended'").run()
// 买家面脱敏:卖家私密拒因一律收敛为 SELLER_NOT_ELIGIBLE(精确 code + gate 顺序在 test-direct-pay-controls 覆盖)。
ok('seller suspended → 409 coarsened SELLER_NOT_ELIGIBLE (no precise code leaked to buyer)', (await dp('buyer1')).json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE')
db.prepare("UPDATE direct_receive_privileges SET status='none' WHERE user_id='seller2'").run()
// no production bond → 409 DIRECT_PAY_NOT_AVAILABLE
const rNoBond = await dp('buyer1')
ok('direct_p2p no production bond → 409 coarsened SELLER_NOT_ELIGIBLE (no base-bond leak)', rNoBond.status === 409 && rNoBond.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(rNoBond))
// bond 到位但 KYB+制裁都无记录 → 409 DIRECT_PAY_KYC_REQUIRED(fail-closed:无记录=不可用)
seedBond('seller2', true)
const rNoKyc = await dp('buyer1')
ok('direct_p2p bond but no KYB/sanctions records → 409 coarsened SELLER_NOT_ELIGIBLE (no KYC leak)', rNoKyc.status === 409 && rNoKyc.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(rNoKyc))
// 仅制裁 clear、KYB 仍缺失 → 仍 KYC_REQUIRED(AND 门:KYB 与 sanctions 都须通过)
seedSanctions('seller2')
const rSanctOnly = await dp('buyer1')
ok('direct_p2p sanctions clear but KYB missing → still 409 coarsened SELLER_NOT_ELIGIBLE (AND gate)', rSanctOnly.status === 409 && rSanctOnly.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(rSanctOnly))
// KYB 记录存在但 status=pending(非 approved)→ 仍 KYC_REQUIRED(fail-closed:仅 approved 才放行)
seedKyb('seller2', 'pending')
const rKybPending = await dp('buyer1')
ok('direct_p2p KYB pending → still 409 coarsened SELLER_NOT_ELIGIBLE (only approved passes)', rKybPending.status === 409 && rKybPending.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(rKybPending))
// KYB → approved + 制裁 clear → 越过 KYC/制裁门,但无收款说明 → 409 NO_PAYMENT_INSTRUCTION
db.prepare("UPDATE direct_receive_kyb_reviews SET status='approved' WHERE user_id='seller2'").run()
const rNoInstr = await dp('buyer1')
ok('direct_p2p KYB approved + sanctions clear, no instruction → 409 NO_PAYMENT_INSTRUCTION', rNoInstr.status === 409 && rNoInstr.json?.error_code === 'NO_PAYMENT_INSTRUCTION', JSON.stringify(rNoInstr))
// 全部满足 → 200 happy
seedInstr('seller2')
const bBal2 = walletUnits(db, 'buyer1').balance
const rOk = await post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr' }, 'buyer1')
ok('direct_p2p bond + instruction → 200 direct_pay_window', rOk.status === 200 && rOk.json?.status === 'direct_pay_window', JSON.stringify(rOk))
// 响应契约门:create 成功响应【不】下发卖家收款说明(D1/D2 both-acked 前不得泄露;非仅 UI 软门)
ok('route happy: create response does NOT leak payment_instruction', rOk.json?.payment_instruction === undefined && rOk.json?.payment_instruction_label === undefined, JSON.stringify(rOk.json))
ok('route happy: buyer wallet UNCHANGED (no principal/escrow)', walletUnits(db, 'buyer1').balance === bBal2)
const createdId = rOk.json?.order_id
ok('route happy: order escrow_amount=0, rail=direct_p2p', ord(createdId)?.escrow_amount === 0 && ord(createdId)?.payment_rail === 'direct_p2p')
ok('route happy: NO fee-stake at create (AR model:费用完成时记应收)', stake(createdId) === undefined)
// 边界 = simple product + 现有 shipping/self-fulfill 流程:无 logistics_id / 未传 logistics_company_id 也能建单
// (后续走卖家自发货 action path;不要求第三方物流,也不按 product_type 判定物理/虚拟)
ok('route happy: simple product, NO logistics required (logistics_id NULL)', (db.prepare('SELECT logistics_id FROM orders WHERE id=?').get(createdId) as { logistics_id: string | null }).logistics_id == null)
// PR-5b: 成功建单写入【建单时】policy 快照(cp 当时:enabled true / rail false / region SG / allowlist ['SG'] / cap 1000 / seller not suspended / OK)
const cs = snapRow(createdId)
ok('route happy: policy snapshot written frozen-at-create', cs.e === 1 && cs.rb === 0 && cs.rg === 'SG' && cs.al === JSON.stringify(['SG']) && cs.cap === toUnits(1000) && cs.sb === 0 && cs.dc === 'OK', JSON.stringify(cs))
// frozen-at-create:事后改 protocol params 不影响已建订单快照
cp['direct_pay.enabled'] = false; cp['direct_pay.per_tx_cap_units'] = toUnits(7)
const cs2 = snapRow(createdId)
ok('snapshot frozen-at-create (later param change does NOT mutate the order snapshot)', cs2.e === 1 && cs2.cap === toUnits(1000), JSON.stringify(cs2))
cp['direct_pay.enabled'] = true; cp['direct_pay.per_tx_cap_units'] = toUnits(1000)  // 恢复供 Part C/E

// ══════ Part D2: buyer account selection (dual-read) ══════
// seller2 已全资格(bond/KYB/sanctions/instruction/verified);seed 一条平台费预付款(过非首单 prepay 门)+ 两个多收款账号。
db.prepare("INSERT INTO direct_pay_fee_payments (id,seller_id,invoice_id,amount,currency,method) VALUES ('topup_s2','seller2',NULL,1000,'usdc','usdc')").run()
db.prepare("INSERT INTO direct_receive_accounts (id, seller_id, method, currency, instruction, label, qr_image_ref, status) VALUES ('acc_s2_a','seller2','PayNow','SGD','ACC-A-INSTR','A','qrref_a','active')").run()
db.prepare("INSERT INTO direct_receive_accounts (id, seller_id, method, currency, instruction, label, status) VALUES ('acc_s2_off','seller2','GCash','PHP','OFF-INSTR','off','inactive')").run()
db.prepare("INSERT INTO direct_receive_accounts (id, seller_id, method, currency, instruction, status) VALUES ('acc_s1_x','seller1','Bank','THB','S1-INSTR','active')").run()
const dpAcc = (accId: string | undefined, uid = 'buyer1') => post({ product_id: 'p2', quantity: 1, payment_rail: 'direct_p2p', shipping_address: 'addr', ...(accId ? { direct_receive_account_id: accId } : {}) }, uid)
// chosen valid account → snapshots THAT account's instruction + non-sensitive account snapshot
const rSel = await dpAcc('acc_s2_a')
ok('D2: valid account selection → 200', rSel.status === 200 && rSel.json?.status === 'direct_pay_window', JSON.stringify(rSel))
const selOrd = ord(rSel.json?.order_id)
ok('D2: instruction snapshot = chosen account instruction (not legacy)', selOrd?.direct_pay_instruction_snapshot === 'ACC-A-INSTR')
const accSnap = selOrd?.direct_pay_account_snapshot ? JSON.parse(selOrd.direct_pay_account_snapshot) : null
ok('D2: account snapshot = {account_id,method,currency,label,qr_ref} (non-sensitive)', accSnap && accSnap.account_id === 'acc_s2_a' && accSnap.method === 'PayNow' && accSnap.currency === 'SGD' && accSnap.label === 'A' && accSnap.qr_ref === 'qrref_a', JSON.stringify(accSnap))
ok('D2: account snapshot carries NO raw instruction', accSnap && !('instruction' in accSnap))
// 审计项 E(v13):非 USD 账户 → 快照冻结应付参考换算(payable_*,display-only);换算不可得也只缺 payable_approx,建单不受阻
ok('E: SGD account snapshot freezes payable_* at create', accSnap && accSnap.payable_usdc === 50 && accSnap.payable_currency === 'SGD' && Number.isFinite(Number(accSnap.payable_approx)) && Number(accSnap.payable_approx) > 0 && Number.isFinite(Number(accSnap.payable_rate)) && typeof accSnap.payable_asof === 'string' && typeof accSnap.payable_stale === 'boolean', JSON.stringify(accSnap))
ok('E: payable_approx ≈ usdc × rate (2dp)', accSnap && Math.abs(Number(accSnap.payable_approx) - Math.round(accSnap.payable_usdc * accSnap.payable_rate * 100) / 100) < 0.011)
// 审计项 B(N2):建单 → 卖家收到 dp_new_order 模板通知(此前卖家不知道有单)
const noNotif = db.prepare("SELECT template_key, params FROM notifications WHERE user_id='seller2' AND order_id=? AND type='direct_pay_order_created'").get(rSel.json?.order_id) as { template_key: string; params: string } | undefined
ok('B: create notifies seller with dp_new_order template (product/qty/amount params)', !!noNotif && noNotif.template_key === 'dp_new_order' && JSON.parse(noNotif.params || '{}').amount === 50, JSON.stringify(noNotif))
// fail-closed: bogus / inactive / wrong-seller account → 409, never silent legacy fallback, no order
const ordsBeforeInvalid = (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n
ok('D2: bogus account_id → 409 DIRECT_RECEIVE_ACCOUNT_INVALID', (await dpAcc('nope')).json?.error_code === 'DIRECT_RECEIVE_ACCOUNT_INVALID')
ok('D2: inactive account → 409 (fail-closed)', (await dpAcc('acc_s2_off')).json?.error_code === 'DIRECT_RECEIVE_ACCOUNT_INVALID')
ok('D2: other-seller account → 409 (fail-closed, no cross-seller)', (await dpAcc('acc_s1_x')).json?.error_code === 'DIRECT_RECEIVE_ACCOUNT_INVALID')
ok('D2: no order created on invalid account', (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n === ordsBeforeInvalid)
// no account_id → legacy dual-read fallback (seller2 has an active legacy instruction from Part B)
const rLegacy = await dpAcc(undefined)
ok('D2: omitted account_id → legacy instruction fallback (unchanged behaviour)', rLegacy.status === 200 && ord(rLegacy.json?.order_id)?.direct_pay_instruction_snapshot === 'PayNow +65 9xxx (off-protocol)' && ord(rLegacy.json?.order_id)?.direct_pay_account_snapshot == null, JSON.stringify(rLegacy))

// ══════ Part C: escrow-only 修饰 → fail-closed(helper 级,绕过 route 预校验)═══════
// 注:拒的是 escrow-only 修饰,不是按 product_type 拒 digital/service(schema 无该字段)。
const { createDirectPayResponse } = await import('../src/direct-pay-create.js')
function mres(): any { const r: any = { _s: 200, _b: null, status(c: number) { r._s = c; return r }, json(b: any) { r._b = b; return r } }; return r }
// 复用 Part B 的 cp(此时已 enabled + SG 白名单 + cap 1000),让 okRes 能过控制面到达建单。
const cdeps = { generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`, transition, appendOrderEvent, getProtocolParam: <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb) }
const baseCtx = { product: { id: 'p1', seller_uid: 'seller1', source: null }, buyerId: 'buyer1', reqQty: 1, basePrice: 50, totalAmount: 50, totalAmountU: toUnits(50), shippingAddress: 'addr' }
// seller1 在 Part A 已有 direct_p2p 在途单 → 非首单宽限 → Part C 多次建单需预充值覆盖。seed 充足平台费预付款(invoice_id NULL)。
db.prepare("INSERT INTO direct_pay_fee_payments (id,seller_id,invoice_id,amount,currency,method) VALUES ('topup_s1','seller1',NULL,1000,'usdc','usdc')").run()
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
// 正向:无任何修饰(simple product)+ 控制面全过(enabled/region/cap)+ seller1 bond+KYC+instr → 建单成功
seedSanctions('seller1'); seedKyb('seller1')  // seller1 过 KYB+制裁(bond 在 Part A 已 production-locked;instr Part A active)
const okRes = mres()
const oN0 = ordersN()
createDirectPayResponse(okRes, db, cdeps, baseCtx)
ok('simple product + controls pass (no AML flag) → 200 created (crossed AML gate)', okRes._s === 200 && okRes._b?.status === 'direct_pay_window' && ordersN() === oN0 + 1, JSON.stringify(okRes._b))

// ══════ Part C-AML: PR-6B 运行期 AML 断路器(create 在【任何写入前】fail-closed)══════
// cleared 的 flag 不阻断:seller1 仍可建单(resolved flag 不算未清除风险)
db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status) VALUES ('af_clr','seller1','velocity','high','cleared')").run()
{
  const oN = ordersN(); const r = mres()
  createDirectPayResponse(r, db, cdeps, baseCtx)
  ok('AML cleared flag → does NOT block (still 200 created)', r._s === 200 && r._b?.status === 'direct_pay_window' && ordersN() === oN + 1, JSON.stringify(r._b))
}
// open/high flag 阻断:create 拒绝且【无】order/stake/stock mutation
db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status) VALUES ('af_open','seller1','velocity','high','open')").run()
{
  const oN = ordersN(), sN = stakesN(), st = pstock(); const r = mres()
  createDirectPayResponse(r, db, cdeps, baseCtx)
  ok('AML open/high flag → 409 coarsened SELLER_NOT_ELIGIBLE (no AML leak), no order/stake/stock mutation',
    r._s === 409 && r._b?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE' && ordersN() === oN && stakesN() === sN && pstock() === st, JSON.stringify(r._b))
}
// 清理:移除 open flag,避免影响后续 Part(seller1 在 Part D/E 仍需可用)
db.prepare("DELETE FROM aml_flags WHERE id='af_open'").run()
// 同时清掉 6B 的 cleared flag,让 seller1 干净,验证 PR-6C monitor 是【唯一】新增 flag 来源
db.prepare("DELETE FROM aml_flags WHERE subject_user_id='seller1'").run()

// ══════ Part C-AML2: PR-6C AML 监控接线(建单成功后 append-only 写 flag;fail-soft,不破坏建单)══════
// 设 velocity 阈值=1 → 本次 direct_p2p 建单成功后 monitor 必 append 一条 velocity flag(related_order_id=新单)。
cp['direct_pay.aml.velocity_max_orders'] = 1
{
  const amlBefore = (db.prepare("SELECT COUNT(*) n FROM aml_flags WHERE subject_user_id='seller1' AND rule='velocity'").get() as { n: number }).n
  const oN = ordersN(); const r = mres()
  createDirectPayResponse(r, db, cdeps, baseCtx)
  const flag = db.prepare("SELECT severity, status, related_order_id FROM aml_flags WHERE subject_user_id='seller1' AND rule='velocity'").get() as any
  ok('PR-6C: create still 200 AND monitor appended exactly one velocity flag post-commit',
    r._s === 200 && r._b?.status === 'direct_pay_window' && ordersN() === oN + 1 &&
    (db.prepare("SELECT COUNT(*) n FROM aml_flags WHERE subject_user_id='seller1' AND rule='velocity'").get() as { n: number }).n === amlBefore + 1,
    JSON.stringify({ s: r._s, flag }))
  ok('PR-6C: appended flag is medium/open (feeds #107 breaker)', flag?.severity === 'medium' && flag?.status === 'open', JSON.stringify(flag))
  ok('PR-6C: appended flag related_order_id = the just-created order', flag?.related_order_id === r._b?.order_id, JSON.stringify(flag))
}
cp['direct_pay.aml.velocity_max_orders'] = 0  // reset inert(后续 Part 不受影响)
db.prepare("DELETE FROM aml_flags WHERE subject_user_id='seller1'").run()  // 清理:seller1 在 Part D/E 仍需可用

// ══════ Part C-Quota: PR-③ 缓交期额度门(笔数 + 金额)在 create 真实接线(非桩)══════
// 缓交卖家(active deferral,无生产 bond)缓交期内额度压低:base=1 + factor(默认 clamp→0.5)→ countLimit=floor(1×0.5)=0→max(1,0)=1。
// 第 1 单过(额度内),第 2 单超笔数上限 → 409 买家面脱敏 SELLER_NOT_ELIGIBLE(精确 quota code 在 deferral-quota 单测),且【无】order/stake/stock 变更。
{
  const { requestDeferral, approveDeferral } = await import('../src/direct-receive-deferral.js')
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller_q','sq','seller','k_sq')").run()
  db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller_q', 100)").run()   // fee-stake 余额
  db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('pq','seller_q','TQ','d',50,100,'active')").run()
  seedProductVerified('pq', 'seller_q')
  seedKyb('seller_q'); seedSanctions('seller_q'); seedInstr('seller_q')   // 合规全过 + instr active(无 production bond → 靠 deferral 入场)
  const nowIso = new Date().toISOString()
  requestDeferral(db, { deferralId: 'dq', userId: 'seller_q', periodDays: 30, nowIso })
  approveDeferral(db, { deferralId: 'dq', adminId: 'admin1', nowIso })   // factor 默认 clamp → 0.5
  cp['direct_pay.deferral_base_order_count'] = 1   // countLimit = max(1, floor(1×0.5)) = 1
  const pqStock = () => (db.prepare("SELECT stock n FROM products WHERE id='pq'").get() as any).n
  const qCtx = { product: { id: 'pq', seller_uid: 'seller_q', source: null }, buyerId: 'buyer1', reqQty: 1, basePrice: 50, totalAmount: 50, totalAmountU: toUnits(50), shippingAddress: 'addr' }
  const oN = ordersN(); const r1 = mres()
  createDirectPayResponse(r1, db, cdeps, qCtx)
  ok('③ 缓交 seller 1st direct_p2p create → 200 (within reduced quota)', r1._s === 200 && r1._b?.status === 'direct_pay_window' && ordersN() === oN + 1, JSON.stringify(r1._b))
  // 口径(2026-07-08):只有【已付款(accepted+)】的单才计入配额 —— 标记第 1 单已付款,它才占额;否则未付款单不占,第 2 单不会被拦。
  db.prepare("UPDATE orders SET status='accepted' WHERE id=?").run(r1._b.order_id)
  const oN2 = ordersN(), sN2 = stakesN(), st2 = pqStock(); const r2 = mres()
  createDirectPayResponse(r2, db, cdeps, qCtx)
  ok('③ 缓交 seller 2nd create over count limit → 409 coarsened SELLER_NOT_ELIGIBLE (no quota/缓交 leak), no order/stake/stock mutation',
    r2._s === 409 && r2._b?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE' && !/DEFERRAL|缓交|quota/i.test(JSON.stringify(r2._b)) && ordersN() === oN2 && stakesN() === sN2 && pqStock() === st2, JSON.stringify(r2._b))
  delete cp['direct_pay.deferral_base_order_count']   // reset(seller1/seller2 有生产 bond → quota no-op,后续 Part 不受影响)
}

// ══════ Part D: GET /orders/:id 响应契约门 —— buyer 在 D1/D2 both-acked 前拿不到 snapshot ══════
// 生产由 runtime schema bridge(webaz-schema-helpers)给 products 加 return_days;本测试用 schema.ts initDatabase,补上以匹配。
const { registerOrdersReadRoutes } = await import('../src/pwa/routes/orders-read.js')
const { recordDisclosureAck, STAGE } = await import('../src/direct-pay-disclosures.js')
registerOrdersReadRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: uid === 'seller2' ? 'seller' : 'buyer' } },
  getOrderStatus,
  getOrderChain: () => ({}), verifyOrderChain: () => ({ ok: true }), getOrderDispute: () => null,
})
function getJson(path: string, uid: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers: { 'x-test-uid': uid } }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve({ status: r.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: r.statusCode || 0, json: d }) } }) })
    rq.on('error', reject); rq.end()
  })
}
const snapOf = (j: any) => j?.order?.direct_pay_instruction_snapshot
// a. buyer 未 both-acked → snapshot 被 redact(响应里没有)
const gPre = await getJson(`/api/orders/${createdId}`, 'buyer1')
ok('GET buyer pre-ack: snapshot REDACTED from response', gPre.status === 200 && snapOf(gPre.json) === undefined, JSON.stringify(snapOf(gPre.json)))
// seller(自填者)始终可见自己的收款说明
const gSeller = await getJson(`/api/orders/${createdId}`, 'seller2')
ok('GET seller: own snapshot VISIBLE', typeof snapOf(gSeller.json) === 'string' && snapOf(gSeller.json).length > 0, JSON.stringify(gSeller.json?.order && 'order-present'))
// b. both-acked 后 buyer 可见
recordDisclosureAck(db, { orderId: createdId, buyerId: 'buyer1', stage: STAGE.PRE_SELECT, ackId: 'dpa_t1' })
recordDisclosureAck(db, { orderId: createdId, buyerId: 'buyer1', stage: STAGE.PRE_CONFIRM, ackId: 'dpa_t2' })
const gPost = await getJson(`/api/orders/${createdId}`, 'buyer1')
ok('GET buyer post-both-ack: snapshot VISIBLE', typeof snapOf(gPost.json) === 'string' && snapOf(gPost.json).length > 0, JSON.stringify(snapOf(gPost.json)))

// ══════ Part E: 可用性只读端点(控制面 SSOT,脱敏)══════
const { registerDirectPayAvailabilityRoutes } = await import('../src/pwa/routes/direct-pay-availability.js')
registerDirectPayAvailabilityRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
  getProtocolParam: <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb),
})
// p2:控制面全开 + seller2 bond+KYC+instr → available:true
const av1 = await getJson('/api/direct-pay/availability?product_id=p2', 'buyer1')
ok('availability: eligible product → available:true', av1.json?.available === true, JSON.stringify(av1.json))
// PR-④ HARD GATE: a fresh UNVERIFIED product of an otherwise-fully-eligible seller is NOT direct-pay-eligible
// (proves one verification does NOT bless all products). Verifying THIS product then enables only it.
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p2uv','seller2','UV','d',50,10,'active')").run()
const avUv = await getJson('/api/direct-pay/availability?product_id=p2uv', 'buyer1')
ok('availability: unverified product → available:false DIRECT_PAY_PRODUCT_NOT_VERIFIED', avUv.json?.available === false && avUv.json?.error_code === 'DIRECT_PAY_PRODUCT_NOT_VERIFIED', JSON.stringify(avUv.json))
{
  const oN = ordersN(); const r = mres()
  createDirectPayResponse(r, db, cdeps, { product: { id: 'p2uv', seller_uid: 'seller2', source: null }, buyerId: 'buyer1', reqQty: 1, basePrice: 50, totalAmount: 50, totalAmountU: toUnits(50), shippingAddress: 'addr' })
  ok('create: unverified product → 409 DIRECT_PAY_PRODUCT_NOT_VERIFIED, no order', r._s === 409 && r._b?.error_code === 'DIRECT_PAY_PRODUCT_NOT_VERIFIED' && ordersN() === oN, JSON.stringify(r._b))
}
seedProductVerified('p2uv', 'seller2')
const avUv2 = await getJson('/api/direct-pay/availability?product_id=p2uv', 'buyer1')
ok('availability: after verifying that product → available:true (per-product, not seller-wide)', avUv2.json?.available === true, JSON.stringify(avUv2.json))
// PR-⑤ EXEMPTION: a seller with a verified store marked per_product_exempt → their UNVERIFIED products are eligible.
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller_ex','sx','seller','k_sx')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller_ex', 100)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('pex','seller_ex','EX','d',50,10,'active')").run()  // NOT product-verified
seedBond('seller_ex', true); seedKyb('seller_ex'); seedSanctions('seller_ex'); seedInstr('seller_ex')
db.prepare("INSERT INTO store_verifications (id, user_id, code, status, per_product_exempt, reviewed_by, reviewed_at) VALUES ('svx','seller_ex','wzs_x','verified',1,'admin1',datetime('now'))").run()
const avEx = await getJson('/api/direct-pay/availability?product_id=pex', 'buyer1')
ok('availability: exempt seller UNVERIFIED product → available:true (store exemption blesses all products)', avEx.json?.available === true, JSON.stringify(avEx.json))
{
  const oN = ordersN(); const r = mres()
  createDirectPayResponse(r, db, cdeps, { product: { id: 'pex', seller_uid: 'seller_ex', source: null }, buyerId: 'buyer1', reqQty: 1, basePrice: 50, totalAmount: 50, totalAmountU: toUnits(50), shippingAddress: 'addr' })
  ok('create: exempt seller unverified product → 200 created (per-product gate bypassed by exemption)', r._s === 200 && r._b?.status === 'direct_pay_window' && ordersN() === oN + 1, JSON.stringify(r._b))
}
// exemption is per-seller: a NON-exempt seller's unverified product is still blocked (seller2 not exempt)
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p2uv2','seller2','UV2','d',50,10,'active')").run()
ok('availability: non-exempt seller unverified product still blocked', (await getJson('/api/direct-pay/availability?product_id=p2uv2', 'buyer1')).json?.error_code === 'DIRECT_PAY_PRODUCT_NOT_VERIFIED')
// PR-6B: AML 断路器阻断 → available:false,买家只见脱敏 SELLER_NOT_ELIGIBLE(不泄露 AML/STR/severity/status 细节)
db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status) VALUES ('af_e2','seller2','velocity','high','open')").run()
const avAml = await getJson('/api/direct-pay/availability?product_id=p2', 'buyer1')
ok('availability: AML-blocked seller → available:false, coarsened DIRECT_PAY_SELLER_NOT_ELIGIBLE', avAml.json?.available === false && avAml.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(avAml.json))
ok('availability: AML block leaks NO detail (no aml/str/severity/status/flag in payload)', !/aml|str|severity|status|flag/i.test(JSON.stringify(avAml.json)), JSON.stringify(avAml.json))
db.prepare("DELETE FROM aml_flags WHERE id='af_e2'").run()
// P1 fix: 卖家 suspended 但 bond/KYC/instruction 都满足 → availability 必须 available:false(与 create 门一致),脱敏成 SELLER_NOT_ELIGIBLE
db.prepare("INSERT INTO direct_receive_privileges (user_id, status, tier) VALUES ('seller2','suspended','T0') ON CONFLICT(user_id) DO UPDATE SET status='suspended'").run()
const avSusp = await getJson('/api/direct-pay/availability?product_id=p2', 'buyer1')
ok('availability: suspended seller (otherwise eligible) → available:false, coarsened DIRECT_PAY_SELLER_NOT_ELIGIBLE', avSusp.json?.available === false && avSusp.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(avSusp.json))
db.prepare("UPDATE direct_receive_privileges SET status='none' WHERE user_id='seller2'").run()
// 全局关 → available:false + 非敏感码 DIRECT_PAY_DISABLED(原样透出)
cp['direct_pay.enabled'] = false
ok('availability: global off → DIRECT_PAY_DISABLED (non-sensitive, passthrough)', (await getJson('/api/direct-pay/availability?product_id=p2', 'buyer1')).json?.error_code === 'DIRECT_PAY_DISABLED')
cp['direct_pay.enabled'] = true
// 卖家合规类拒绝 → 脱敏为 DIRECT_PAY_SELLER_NOT_ELIGIBLE(不暴露 base-bond/KYC 具体状态)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller3','s3','seller','k_s3')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p3','seller3','T3','d',50,10,'active')").run()
const av3 = await getJson('/api/direct-pay/availability?product_id=p3', 'buyer1')
ok('availability: seller not eligible → coarsened DIRECT_PAY_SELLER_NOT_ELIGIBLE (no base-bond/KYC leak)', av3.json?.available === false && av3.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', JSON.stringify(av3.json))
// PR-③: availability 镜像 create 的缓交额度门 —— seller_q 已有 1 单(Part C-Quota),base=1 → 超额 → 脱敏 SELLER_NOT_ELIGIBLE。
cp['direct_pay.deferral_base_order_count'] = 1
const avQuota = await getJson('/api/direct-pay/availability?product_id=pq', 'buyer1')
ok('availability: 缓交 seller over reduced quota → available:false, coarsened DIRECT_PAY_SELLER_NOT_ELIGIBLE (no quota/deferral leak)',
  avQuota.json?.available === false && avQuota.json?.error_code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE' && !/quota|deferral|缓交/i.test(JSON.stringify(avQuota.json)), JSON.stringify(avQuota.json))
delete cp['direct_pay.deferral_base_order_count']
ok('availability: missing product_id → 400', (await getJson('/api/direct-pay/availability', 'buyer1')).status === 400)

// ═══ 审计项 G:单买家·单卖家在途直付单上限(防锁库存刷单)═══
{
  const openN = () => (db.prepare(`SELECT COUNT(*) n FROM orders WHERE buyer_id='buyer1' AND seller_id='seller2' AND payment_rail='direct_p2p' AND status IN ('direct_pay_window','direct_expired_unconfirmed','accepted','payment_query')`).get() as { n: number }).n
  cp['direct_pay.max_open_per_buyer_seller'] = openN() + 1
  const rOk = await dpAcc('acc_s2_a')
  ok('G: 上限内建单 → 200', rOk.status === 200, JSON.stringify(rOk.json))
  const rCap = await dpAcc('acc_s2_a')
  ok('G: 达上限 → 429 DIRECT_PAY_TOO_MANY_OPEN(精确 code,买家自身行为不脱敏)', rCap.status === 429 && rCap.json?.error_code === 'DIRECT_PAY_TOO_MANY_OPEN', JSON.stringify(rCap.json))
  const before = (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n
  await dpAcc('acc_s2_a')
  ok('G: 429 时不建单不扣库存', (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n === before)
  delete cp['direct_pay.max_open_per_buyer_seller']
}

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-create tests passed`)
