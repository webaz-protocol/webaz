#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) 买家动作 ROUTE 级回归测试(#86 P1/P2 + PR-4e 门控)。
 * 真 express + 真 transition + 真 releaseFeeStake/takeFeeAtCompletion + 真 consumeGateToken + 真 #87 helpers。
 * PR-4e:mark_paid / confirm / confirm-in-person(仅 direct_p2p)= 两次披露门(D1+D2)+ 现场真人 Passkey/gate-token 门。
 *   cancel 不门控;escrow 不受影响;gate 在任何写入前;错误状态不消耗 token。
 * Usage: npm run test:direct-pay-actions
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-actions-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { recordDisclosureAck, STAGE } = await import('../src/direct-pay-disclosures.js')
const { lockFeeStake, releaseFeeStake } = await import('../src/direct-pay-ledger.js')
const { accrueFeeReceivable, feeUnitsForOrder } = await import('../src/direct-pay-fee-ar.js')
const { walletUnits } = await import('../src/ledger.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
initOrderChainSchema(db)
try { db.exec("ALTER TABLE orders ADD COLUMN fulfillment_mode TEXT DEFAULT 'shipped'") } catch {}  // server-boot ALTER(schema.ts 不含)
try { db.exec("ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'shop'") } catch {}  // server-boot ALTER(settleOrder 读 order.source 算费率)
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)')
initSystemUser(db)
db.exec('CREATE TABLE IF NOT EXISTS protocol_reserve_pool (id INTEGER PRIMARY KEY, balance REAL DEFAULT 0)')
db.prepare('INSERT OR IGNORE INTO protocol_reserve_pool (id, balance) VALUES (1, 0)').run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('sys_protocol', 0)").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('buyer1','买家','buyer','k_b1')").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('nopk','无PK买家','buyer','k_np')").run()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('seller1','卖家','seller','k_s1')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('seller1', 100)").run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('buyer1', 0)").run()
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_b1','buyer1')").run()  // buyer1 有 Passkey;nopk 没有

const { consumeGateToken } = createHumanPresence(db, <T,>(_k: string, fb: T): T => fb)
const FEE = toUnits(5)
const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string } | undefined)?.status
const stakeStatus = (id: string) => (db.prepare('SELECT status FROM direct_pay_fee_stakes WHERE order_id=?').get(id) as { status?: string } | undefined)?.status
const receivable = (id: string) => db.prepare('SELECT id, amount FROM direct_pay_fee_receivables WHERE order_id=?').get(id) as { id: string; amount: number } | undefined
let rk = 0
const tokConsumed = (id: string) => (db.prepare('SELECT consumed_at FROM webauthn_gate_tokens WHERE id=?').get(id) as { consumed_at: string | null } | undefined)?.consumed_at

let sk = 0, tk = 0, ak = 0
function mkOrder(id: string, st: string, rail: string, fulfillment = 'shipped', buyer = 'buyer1'): void {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode)
     VALUES (?, 'p1',?,'seller1',1,50,50,0,?,?,?)`).run(id, buyer, st, rail, fulfillment)
}
const lock = (id: string) => lockFeeStake(db, { orderId: id, sellerId: 'seller1', feeUnits: FEE, stakeId: `s_${++sk}` })
const seedAcks = (id: string, buyer = 'buyer1') => { recordDisclosureAck(db, { orderId: id, buyerId: buyer, stage: STAGE.PRE_SELECT, ackId: `a_${++ak}` }); recordDisclosureAck(db, { orderId: id, buyerId: buyer, stage: STAGE.PRE_CONFIRM, ackId: `a_${++ak}` }) }
function seedToken(user: string, orderId: string, action: string): string {
  const id = `wgt_${++tk}`
  db.prepare('INSERT INTO webauthn_gate_tokens (id,user_id,purpose,purpose_data,expires_at) VALUES (?,?,?,?,?)')
    .run(id, user, 'direct_pay_order_action', JSON.stringify({ order_id: orderId, action }), new Date(Date.now() + 60_000).toISOString())
  return id
}

let counter = 0
const app = express(); app.use(express.json())
registerOrdersActionRoutes(app, {
  db,
  auth: (req: Request, res: Response) => {
    const uid = req.headers['x-test-uid'] as string | undefined
    if (!uid) { res.status(401).json({ error: 'login required' }); return null }
    return { id: uid, role: (req.headers['x-test-role'] as string) || 'buyer' }
  },
  isTrustedRole: () => false,
  generateId: (p: string) => `${p}_${++counter}`,
  transition,
  notifyTransition: () => {},
  settleOrder: (orderId: string) => db.transaction(() => {
    // 镜像 server.ts settleOrder direct_p2p 分支:释放任何遗留模拟 stake + accrue 链下应收(fail-closed)。
    const o = db.prepare('SELECT payment_rail, total_amount, source, seller_id FROM orders WHERE id=?').get(orderId) as { payment_rail?: string; total_amount?: number; source?: string | null; seller_id?: string } | undefined
    if (o?.payment_rail === 'direct_p2p') {
      releaseFeeStake(db, { orderId })
      accrueFeeReceivable(db, { orderId, sellerId: o.seller_id as string, feeUnits: feeUnitsForOrder(toUnits(Number(o.total_amount) || 0), o.source ?? null), receivableId: `dpfr_${++rk}` })
      return
    }
  })(),
  settleFault: () => {}, detectFraud: () => [], createDispute: () => {}, checkTimeouts: () => ({ details: [] }),
  recordViolationReputation: () => {}, broadcastSystemEvent: () => {},
  consumeGateToken,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })

function callPath(path: string, body: Record<string, unknown>, uid?: string, role?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (uid) headers['x-test-uid'] = uid
    if (role) headers['x-test-role'] = role
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null }) } catch { resolve({ status: res.statusCode || 0, json: data }) } })
    })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}
const call = (orderId: string, body: Record<string, unknown>, uid?: string, role?: string) => callPath(`/api/orders/${orderId}/action`, body, uid, role)

// ═══ mark_paid ═══
// 1. happy:acks + valid token → accepted
mkOrder('o1', 'direct_pay_window', 'direct_p2p'); lock('o1'); seedAcks('o1')
const r1 = await call('o1', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'o1', 'mark_paid') }, 'buyer1')
ok('mark_paid acks+token → 200 accepted', r1.status === 200 && status('o1') === 'accepted', JSON.stringify(r1))
ok('mark_paid leaves fee-stake locked', stakeStatus('o1') === 'locked')

// 2. 缺 acks → 409 DISCLOSURE_NOT_ACKED,无写入
mkOrder('oNoAck', 'direct_pay_window', 'direct_p2p'); lock('oNoAck')
const r2 = await call('oNoAck', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'oNoAck', 'mark_paid') }, 'buyer1')
ok('mark_paid 缺 acks → 409 DISCLOSURE_NOT_ACKED', r2.status === 409 && r2.json?.error_code === 'DISCLOSURE_NOT_ACKED', JSON.stringify(r2))
ok('缺 acks 无写入(状态仍 window,stake 仍 locked)', status('oNoAck') === 'direct_pay_window' && stakeStatus('oNoAck') === 'locked')

// 3. 有 acks 无 token / 错 token / 错 action / 错 order → 403(状态不变)
mkOrder('oGate', 'direct_pay_window', 'direct_p2p'); lock('oGate'); seedAcks('oGate')
ok('mark_paid 无 token → 403 HUMAN_PRESENCE_REQUIRED', (await call('oGate', { action: 'mark_paid' }, 'buyer1')).json?.error_code === 'HUMAN_PRESENCE_REQUIRED')
ok('mark_paid 不存在 token → 403', (await call('oGate', { action: 'mark_paid', webauthn_token: 'nope' }, 'buyer1')).status === 403)
ok('mark_paid 错 action token → 403', (await call('oGate', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'oGate', 'confirm') }, 'buyer1')).status === 403)
ok('mark_paid 错 order token → 403', (await call('oGate', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'zzz', 'mark_paid') }, 'buyer1')).status === 403)
ok('上述失败后 oGate 仍 direct_pay_window(无写入)', status('oGate') === 'direct_pay_window')

// 4. 无 Passkey 用户 → 403 PASSKEY_REQUIRED
mkOrder('oNp', 'direct_pay_window', 'direct_p2p', 'shipped', 'nopk'); lock('oNp'); seedAcks('oNp', 'nopk')
const r4 = await call('oNp', { action: 'mark_paid', webauthn_token: seedToken('nopk', 'oNp', 'mark_paid') }, 'nopk')
ok('no-Passkey mark_paid → 403 PASSKEY_REQUIRED_FOR_DIRECT_PAY', r4.status === 403 && r4.json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', JSON.stringify(r4))

// 5. seller mark_paid → 403 NOT_ORDER_BUYER(ownership 在 gate 前)
mkOrder('oSel', 'direct_pay_window', 'direct_p2p'); lock('oSel')
ok('seller mark_paid → 403 NOT_ORDER_BUYER', (await call('oSel', { action: 'mark_paid' }, 'seller1', 'seller')).json?.error_code === 'NOT_ORDER_BUYER')

// 6. escrow mark_paid → 409 NOT_DIRECT_PAY_WINDOW(不受门控影响)
mkOrder('oEsc', 'created', 'escrow')
ok('escrow mark_paid → 409 NOT_DIRECT_PAY_WINDOW', (await call('oEsc', { action: 'mark_paid' }, 'buyer1')).json?.error_code === 'NOT_DIRECT_PAY_WINDOW')

// ═══ cancel(不门控)═══
// 7. cancel 释放质押(无需 acks/token)
mkOrder('o3', 'direct_pay_window', 'direct_p2p'); lock('o3')
const fsBefore = walletUnits(db, 'seller1').fee_staked, balBefore = walletUnits(db, 'seller1').balance
const r7 = await call('o3', { action: 'cancel' }, 'buyer1')
ok('cancel(ungated)→ 200 released', r7.status === 200 && r7.json?.fee_stake_released === true && status('o3') === 'cancelled', JSON.stringify(r7))
ok('cancel 释放质押', stakeStatus('o3') === 'released' && walletUnits(db, 'seller1').balance === balBefore + FEE && walletUnits(db, 'seller1').fee_staked === fsBefore - FEE)

// 8. unauthenticated → 401
mkOrder('o6', 'direct_pay_window', 'direct_p2p')
ok('unauthenticated → 401', (await call('o6', { action: 'mark_paid' })).status === 401)

// ═══ confirm ═══
// 9. AR 订单(无 stake)confirm → 200 completed + accrue 应收(不再有"缺 fee-stake"前置门;fail-closed 移到 accrue)。
mkOrder('o7c', 'delivered', 'direct_p2p'); seedAcks('o7c')   // 无 lock:AR 订单本就无 stake
const r9 = await call('o7c', { action: 'confirm', webauthn_token: seedToken('buyer1', 'o7c', 'confirm') }, 'buyer1')
ok('confirm AR(无 stake)→ 200 completed(无前置 stake 门)', r9.status === 200 && status('o7c') === 'completed', JSON.stringify(r9))
ok('confirm → 记一笔应收(>0)', !!receivable('o7c') && toUnits(receivable('o7c')!.amount) > 0)
ok('confirm → 不创建 fee-stake', stakeStatus('o7c') === undefined)

// 10. 缺 acks → 409 DISCLOSURE_NOT_ACKED,无写入
mkOrder('oCnoack', 'delivered', 'direct_p2p'); lock('oCnoack')
const r10 = await call('oCnoack', { action: 'confirm', webauthn_token: seedToken('buyer1', 'oCnoack', 'confirm') }, 'buyer1')
ok('confirm 缺 acks → 409 DISCLOSURE_NOT_ACKED', r10.status === 409 && r10.json?.error_code === 'DISCLOSURE_NOT_ACKED', JSON.stringify(r10))
ok('confirm 缺 acks → 仍 delivered,stake 仍 locked', status('oCnoack') === 'delivered' && stakeStatus('oCnoack') === 'locked')

// 11. 错误状态(非 delivered)→ 409 ORDER_NOT_DELIVERED 且【不消耗 token】
mkOrder('oWS', 'accepted', 'direct_p2p'); lock('oWS'); seedAcks('oWS')
const tWS = seedToken('buyer1', 'oWS', 'confirm')
const r11 = await call('oWS', { action: 'confirm', webauthn_token: tWS }, 'buyer1')
ok('confirm 非 delivered → 409 ORDER_NOT_DELIVERED', r11.status === 409 && r11.json?.error_code === 'ORDER_NOT_DELIVERED', JSON.stringify(r11))
ok('confirm 错误状态【未消耗 token】', tokConsumed(tWS) == null)
// 改到 delivered 后,同一 token 仍可用 → 证明上一步没浪费
db.prepare("UPDATE orders SET status='delivered' WHERE id='oWS'").run()
const r11b = await call('oWS', { action: 'confirm', webauthn_token: tWS }, 'buyer1')
ok('delivered 后同 token → 200 completed(token 之前未被消耗)', r11b.status === 200 && status('oWS') === 'completed', JSON.stringify(r11b))

// 12. legacy(cutover 前遗留 locked stake)confirm → completed:释放遗留模拟 stake(不取)+ accrue 应收。
mkOrder('o8c', 'delivered', 'direct_p2p'); lock('o8c'); seedAcks('o8c')
const r12 = await call('o8c', { action: 'confirm', webauthn_token: seedToken('buyer1', 'o8c', 'confirm') }, 'buyer1')
ok('confirm acks+token → 200 completed', r12.status === 200 && status('o8c') === 'completed', JSON.stringify(r12))
ok('confirm → 遗留 stake 释放(非 fee_taken)', stakeStatus('o8c') === 'released')
ok('confirm → 记一笔应收', !!receivable('o8c'))

// 13. escrow confirm 不受 4e 门控:无 acks/token 也【不会被 direct_p2p gate 拦】(走原 state-machine 路径)。
//    用非 delivered 状态触发 state-machine 拒绝,避免 escrow 完成时的 commission breakdown 依赖完整 schema(与本片无关)。
mkOrder('oEscC', 'accepted', 'escrow')
const r13 = await call('oEscC', { action: 'confirm' }, 'buyer1')
const GATE_CODES = ['DISCLOSURE_NOT_ACKED', 'HUMAN_PRESENCE_REQUIRED', 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', 'ORDER_NOT_DELIVERED']
ok('escrow confirm 不返回任何 direct_p2p gate code(未被 4e 门控)', !GATE_CODES.includes(r13.json?.error_code), JSON.stringify(r13))
ok('escrow confirm(非 delivered)被 state-machine 拒、未完成', status('oEscC') === 'accepted')

// ═══ confirm-in-person ═══
// 14. AR 订单(无 stake)面交完成 → 200 completed + accrue 应收(不再有"缺 fee-stake"前置门)。
mkOrder('o9p', 'accepted', 'direct_p2p', 'in_person'); seedAcks('o9p')   // 无 lock
const r14 = await callPath('/api/orders/o9p/confirm-in-person', { webauthn_token: seedToken('buyer1', 'o9p', 'confirm_in_person') }, 'buyer1')
ok('in-person AR(无 stake)→ 200 completed', r14.status === 200 && status('o9p') === 'completed', JSON.stringify(r14))
ok('in-person → 记一笔应收', !!receivable('o9p'))

// 15. 缺 acks → 409 DISCLOSURE_NOT_ACKED,无写入
mkOrder('oIPna', 'accepted', 'direct_p2p', 'in_person'); lock('oIPna')
const r15 = await callPath('/api/orders/oIPna/confirm-in-person', { webauthn_token: seedToken('buyer1', 'oIPna', 'confirm_in_person') }, 'buyer1')
ok('in-person 缺 acks → 409 DISCLOSURE_NOT_ACKED', r15.status === 409 && r15.json?.error_code === 'DISCLOSURE_NOT_ACKED', JSON.stringify(r15))
ok('in-person 缺 acks → 仍 accepted,stake 仍 locked', status('oIPna') === 'accepted' && stakeStatus('oIPna') === 'locked')

// 16. legacy(遗留 locked stake)面交完成 → 释放遗留 stake + accrue 应收。
mkOrder('o10p', 'accepted', 'direct_p2p', 'in_person'); lock('o10p'); seedAcks('o10p')
const r16 = await callPath('/api/orders/o10p/confirm-in-person', { webauthn_token: seedToken('buyer1', 'o10p', 'confirm_in_person') }, 'buyer1')
ok('in-person acks+token → 200 completed', r16.status === 200 && status('o10p') === 'completed', JSON.stringify(r16))
ok('in-person → 遗留 stake 释放(非 fee_taken)', stakeStatus('o10p') === 'released')
ok('in-person → 记一笔应收', !!receivable('o10p'))

// 17. Codex P1:confirm 全原子 —— accrue 失败(fee=0)→ 409 且订单【仍停在 delivered】(回滚,不卡 confirmed,可重试)。
db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode, source)
   VALUES ('oZero','p1','buyer1','seller1',1,0,0,0,'delivered','direct_p2p','shipped','shop')`).run()
seedAcks('oZero')
const r17 = await call('oZero', { action: 'confirm', webauthn_token: seedToken('buyer1', 'oZero', 'confirm') }, 'buyer1')
ok('accrue 失败(fee=0)→ 409 DIRECT_PAY_SETTLE_FAILED', r17.status === 409 && r17.json?.error_code === 'DIRECT_PAY_SETTLE_FAILED', JSON.stringify(r17))
ok('accrue 失败 → 订单仍 delivered(全原子回滚,不卡 confirmed)', status('oZero') === 'delivered')
ok('accrue 失败 → 无应收落库', !receivable('oZero'))

// ═══ 防作弊 D1/D2 + 库存恢复 D3(路由级) ═══
{
  try { db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','seller1','P','d',50,10)").run() } catch { /* 已存在 */ }
  const stockOf = () => (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
  const lastNote = (id: string) => (db.prepare("SELECT notes FROM order_state_history WHERE order_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as { notes: string } | undefined)?.notes || ''
  // D1:客户端伪造参考号被服务端权威派生覆盖(冒充别单参考 + 夹带 WAZ- 样式一并剥掉,补充备注保留)
  mkOrder('oSpoof', 'direct_pay_window', 'direct_p2p'); lock('oSpoof'); seedAcks('oSpoof')
  const rs = await call('oSpoof', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'oSpoof', 'mark_paid'), notes: '付款参考: WAZ-EVILSPOOF 顺丰到付 WAZ-ABCD1234' }, 'buyer1')
  const canonical = 'WAZ-' + 'oSpoof'.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase()
  ok('D1a. mark_paid 服务端权威参考号覆盖客户端伪造', rs.status === 200 && lastNote('oSpoof').includes(`付款参考: ${canonical}`), lastNote('oSpoof'))
  ok('D1b. 伪造的参考号被剥除,补充备注保留', !lastNote('oSpoof').includes('EVILSPOOF') && !lastNote('oSpoof').includes('WAZ-ABCD1234') && lastNote('oSpoof').includes('顺丰到付'))
  // D2:同买家·同卖家·同金额在途多单 → 时间线预警
  mkOrder('oDup1', 'accepted', 'direct_p2p')   // 已在途的同金额单
  mkOrder('oDup2', 'direct_pay_window', 'direct_p2p'); lock('oDup2'); seedAcks('oDup2')
  await call('oDup2', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'oDup2', 'mark_paid') }, 'buyer1')
  ok('D2a. 同金额在途多单 → mark_paid 时间线带 ⚠️ 预警', /⚠️ 同买家另有 \d+ 笔同金额直付订单在途/.test(lastNote('oDup2')), lastNote('oDup2'))
  mkOrder('oSolo', 'direct_pay_window', 'direct_p2p', 'shipped', 'buyer2'); lock('oSolo'); seedAcks('oSolo', 'buyer2')
  await call('oSolo', { action: 'mark_paid', webauthn_token: seedToken('buyer2', 'oSolo', 'mark_paid') }, 'buyer2')
  ok('D2b. 无同金额在途单 → 无预警(不喊狼来了)', !lastNote('oSolo').includes('⚠️'))
  // D3:付款窗口/货款协商取消恢复库存(transition→cancelled 引擎不恢复,此前漏)
  mkOrder('oCanc', 'direct_pay_window', 'direct_p2p'); lock('oCanc')
  const s0 = stockOf()
  const rc = await call('oCanc', { action: 'cancel' }, 'buyer1')
  ok('D3a. 付款窗口取消 → 库存恢复 +quantity', rc.status === 200 && stockOf() === s0 + 1, `before=${s0} after=${stockOf()}`)
  mkOrder('oCancPq', 'payment_query', 'direct_p2p'); lock('oCancPq')
  const s1 = stockOf()
  const rc2 = await call('oCancPq', { action: 'cancel' }, 'buyer1')
  ok('D3b. 货款协商买家取消 → 库存恢复', rc2.status === 200 && stockOf() === s1 + 1, `before=${s1} after=${stockOf()}`)
}

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-actions route tests passed`)
