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
const { initSystemUser, transition, settleFault, checkTimeouts } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { recordDisclosureAck, STAGE } = await import('../src/direct-pay-disclosures.js')
const { lockFeeStake, releaseFeeStake } = await import('../src/direct-pay-ledger.js')
const { accrueFeeReceivable, feeUnitsForOrder } = await import('../src/direct-pay-fee-ar.js')
const { walletUnits, applyWalletDelta } = await import('../src/ledger.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
initOrderChainSchema(db)
try { db.exec("ALTER TABLE orders ADD COLUMN fulfillment_mode TEXT DEFAULT 'shipped'") } catch {}  // server-boot ALTER(schema.ts 不含)
try { db.exec("ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'shop'") } catch {}  // server-boot ALTER(settleOrder 读 order.source 算费率)
try { db.exec("ALTER TABLE orders ADD COLUMN settled_fault_at TEXT") } catch {}  // server-boot ALTER(settleFault 写幂等标记;真实 settleFault 回归用)
try { db.exec("ALTER TABLE orders ADD COLUMN has_pending_claim INTEGER DEFAULT 0") } catch {}  // server-boot ALTER(checkTimeouts SELECT 读它跳过 claim 进行中单;P1 auto-confirm 回归用)
try { db.exec("ALTER TABLE orders ADD COLUMN decline_objective_pending INTEGER DEFAULT 0") } catch {}  // server-boot ALTER(checkTimeouts RFC-007 临时判责扫描读)
try { db.exec("ALTER TABLE orders ADD COLUMN decline_contested INTEGER DEFAULT 0") } catch {}  // server-boot ALTER(同上)
try { db.exec("ALTER TABLE orders ADD COLUMN decline_contest_deadline TEXT") } catch {}  // server-boot ALTER(同上)
try { db.exec("ALTER TABLE evidence ADD COLUMN flag_reasons TEXT") } catch {}  // server-boot ALTER(deliver 带证据→detectFraud 写入;P1k route 回归用)
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
initNotificationSchema(db)   // 审计项 B:mark_paid → 卖家模板通知断言用
initSystemUser(db)
db.exec('CREATE TABLE IF NOT EXISTS protocol_params (key TEXT PRIMARY KEY, value TEXT)')   // settleFault escrow 对照读 fault_penalty_rate/protocol_fee_rate(空表→默认率)
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

// ═══ RFC-021 PR3 / Codex P1-c:direct_p2p 进 accepted 生成 ship_deadline + 执行器 SLA fail-closed + backfill ═══
const shipDl = (id: string) => (db.prepare('SELECT ship_deadline FROM orders WHERE id=?').get(id) as { ship_deadline: string | null } | undefined)?.ship_deadline
ok('P1c-b mark_paid→accepted 后生成 ship_deadline(direct-pay 建单不设该列)', shipDl('o1') != null)
{ const before = shipDl('o1')   // 幂等/不覆盖:再跑一次 WHERE IS NULL 的写不应改动已有值(守 I3)
  db.prepare("UPDATE orders SET ship_deadline = datetime('now', '+999 hours') WHERE id='o1' AND ship_deadline IS NULL").run()
  ok('P1c-b ship_deadline 不被覆盖(WHERE IS NULL 兜死,守 I3)', shipDl('o1') === before) }
{ const r = await call('o1', { action: 'ship', evidence_description: '直付自发货' }, 'seller1', 'seller')   // 真实 ship_deadline → SLA 生效 → 放行
  ok('P1c direct_p2p accept→ship 有真实 ship_deadline 且 SLA 生效 → shipped', r.status === 200 && status('o1') === 'shipped', JSON.stringify(r)) }
mkOrder('oNull', 'accepted', 'direct_p2p')   // 构造 ship_deadline=NULL 的存量 accepted 单
ok('P1c-a 前置:oNull ship_deadline 为 NULL', shipDl('oNull') == null)
{ const r = await call('oNull', { action: 'ship', evidence_description: 'x' }, 'seller1', 'seller')
  ok('P1c-a deadline=NULL → 执行器 fail-closed SLA_DEADLINE_MISSING(绝不 skip/放行)', r.json?.error_code === 'SLA_DEADLINE_MISSING' && status('oNull') === 'accepted', JSON.stringify(r)) }
db.prepare("UPDATE orders SET ship_deadline = datetime('now', '+72 hours') WHERE payment_rail='direct_p2p' AND status='accepted' AND ship_deadline IS NULL").run()   // 镜像 backfill 脚本
{ const r = await call('oNull', { action: 'ship', evidence_description: 'x' }, 'seller1', 'seller')
  ok('P1c-c backfill 补齐后,存量 accepted 单可正常走完发货 → shipped', r.status === 200 && status('oNull') === 'shipped', JSON.stringify(r)) }

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
  db.prepare("INSERT INTO users (id, name, role, api_key) VALUES ('buyer2','买家2','buyer','k_b2')").run()
  db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_b2','buyer2')").run()
  mkOrder('oSolo', 'direct_pay_window', 'direct_p2p', 'shipped', 'buyer2'); lock('oSolo'); seedAcks('oSolo', 'buyer2')
  const rSolo = await call('oSolo', { action: 'mark_paid', webauthn_token: seedToken('buyer2', 'oSolo', 'mark_paid') }, 'buyer2')
  ok('D2b. 无同金额在途单 → mark_paid 成功且无预警(非空 note 上断言,防假绿)', rSolo.status === 200 && lastNote('oSolo').length > 0 && !lastNote('oSolo').includes('⚠️'), lastNote('oSolo'))
  // 审计项 E:时间线带应付金额(对账三要素:参考号+金额+币种)—— 无 payable 快照的旧单回落仅 USDC
  ok('E. mark_paid 时间线记录应付金额(USDC)', /应付 50 USDC/.test(lastNote('oSolo')), lastNote('oSolo'))
  // 审计项 B(N2):mark_paid → 卖家收到 dp_marked_paid 模板通知(detail=权威对账串;此前卖家全程无"已付款"信号)
  const mpNotif = db.prepare("SELECT template_key, params, body FROM notifications WHERE user_id='seller1' AND order_id='oSolo' AND type='direct_pay_marked_paid'").get() as { template_key: string; params: string; body: string } | undefined
  ok('B. mark_paid notifies seller with dp_marked_paid template (detail = canonical ref+payable)', !!mpNotif && mpNotif.template_key === 'dp_marked_paid' && /付款参考: WAZ-/.test(String(JSON.parse(mpNotif.params || '{}').detail || '')), JSON.stringify(mpNotif))
  // D3:付款窗口/货款协商取消恢复库存(transition→cancelled 引擎不恢复,此前漏)
  mkOrder('oCanc', 'direct_pay_window', 'direct_p2p'); lock('oCanc')
  const s0 = stockOf()
  const rc = await call('oCanc', { action: 'cancel' }, 'buyer1')
  ok('D3a. 付款窗口取消 → 库存恢复 +quantity', rc.status === 200 && stockOf() === s0 + 1, `before=${s0} after=${stockOf()}`)
  mkOrder('oCancPq', 'payment_query', 'direct_p2p'); lock('oCancPq')
  const s1 = stockOf()
  const rc2 = await call('oCancPq', { action: 'cancel' }, 'buyer1')
  ok('D3b. 货款协商买家取消 → 库存恢复', rc2.status === 200 && stockOf() === s1 + 1, `before=${s1} after=${stockOf()}`)
  // 审计项 H:付款窗过期宽限期买家可确认未付即刻关单(此前 guard 与状态机矛盾=死能力)+ 库存恢复
  mkOrder('oCancExp', 'direct_expired_unconfirmed', 'direct_p2p')
  const s2 = stockOf()
  const rc3 = await call('oCancExp', { action: 'cancel' }, 'buyer1')
  ok('H. expired 宽限期买家取消 → 200 cancelled + 库存恢复', rc3.status === 200 && status('oCancExp') === 'cancelled' && stockOf() === s2 + 1, JSON.stringify(rc3))
  ok('H2. mark_paid 仍仅付款窗口(expired 不可 mark_paid)', (await call('oCancExp', { action: 'mark_paid', webauthn_token: seedToken('buyer1', 'oCancExp', 'mark_paid') }, 'buyer1')).status === 409)
}

// ═══ P0(钱路):非托管轨 settleFault = 零钱包移动 —— 修"direct_p2p 超时判责凭空印钱 + 冤枉退款" ═══
{
  const stockOf = () => (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
  const wu = (u: string) => walletUnits(db, u)
  // (a) direct_p2p accepted → 真实 settleFault('fault_seller'):买家钱包零变动(escrowed 不转负、balance 不凭空 +total),卖家不被没收,发货前库存回补,标记落库。
  mkOrder('oFaultDp', 'accepted', 'direct_p2p')
  const bBefore = wu('buyer1'), sBefore = wu('seller1'), stBefore = stockOf()
  settleFault(db, 'oFaultDp', 'fault_seller')
  const bAfter = wu('buyer1'), sAfter = wu('seller1')
  ok('P0a. direct_p2p fault_seller:买家 balance 不凭空增(零印钱)', bAfter.balance === bBefore.balance, `before=${bBefore.balance} after=${bAfter.balance}`)
  ok('P0b. direct_p2p fault_seller:买家 escrowed 不转负(从无托管)', bAfter.escrowed === bBefore.escrowed && bAfter.escrowed >= 0, `escrowed after=${bAfter.escrowed}`)
  ok('P0c. direct_p2p fault_seller:卖家 balance 不被没收(仅信誉,信誉由 cron 侧另记)', sAfter.balance === sBefore.balance, `before=${sBefore.balance} after=${sAfter.balance}`)
  ok('P0d. direct_p2p fault_seller:settled_fault_at 落库(幂等 + 供缓交配额排除)', !!(db.prepare("SELECT settled_fault_at FROM orders WHERE id='oFaultDp'").get() as { settled_fault_at?: string } | undefined)?.settled_fault_at)
  ok('P0e. direct_p2p fault_seller:发货前库存回补 +1', stockOf() === stBefore + 1, `before=${stBefore} after=${stockOf()}`)
  // (b) 对照:escrow accepted 且买家已托管 → fault_seller 仍全额退回买家(托管路径不受本次改动影响 = 未 regress)。
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyerE','托管买家','buyer','k_be')").run()
  db.prepare("INSERT INTO wallets (user_id, balance, escrowed) VALUES ('buyerE', 0, 50)").run()
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode) VALUES ('oFaultEsc','p1','buyerE','seller1',1,50,50,50,'accepted','escrow','shipped')").run()
  const eBefore = wu('buyerE')
  settleFault(db, 'oFaultEsc', 'fault_seller')
  const eAfter = wu('buyerE')
  ok('P0f. 对照:escrow fault_seller 仍全额退回买家(escrowed→balance,托管路径未改)', eAfter.escrowed === eBefore.escrowed - toUnits(50) && eAfter.balance === eBefore.balance + toUnits(50), `esc ${eBefore.escrowed}→${eAfter.escrowed} bal ${eBefore.balance}→${eAfter.balance}`)
  // (c) quantity>1:发货前 fault 按 create 扣减口径回补 quantity(非 +1)
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode) VALUES ('oFaultQty','p1','buyer1','seller1',3,50,150,0,'accepted','direct_p2p','shipped')").run()
  const stQ = stockOf()
  settleFault(db, 'oFaultQty', 'fault_seller')
  ok('P0g. direct_p2p fault_seller qty=3:按 quantity 回补(+3,非 +1)', stockOf() === stQ + 3, `before=${stQ} after=${stockOf()}`)
  // (d) post-ship fault_logistics:发货前门 → 不回补【已发出】的货;仍零钱包 + 幂等标记(防未来加 SLA 后幻影回补)
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode) VALUES ('oFaultLog','p1','buyer1','seller1',1,50,50,0,'shipped','direct_p2p','shipped')").run()
  const stL = stockOf(), bL = wu('buyer1')
  settleFault(db, 'oFaultLog', 'fault_logistics')
  ok('P0h. direct_p2p fault_logistics(post-ship):不回补已发出的货(stock 不变)', stockOf() === stL, `before=${stL} after=${stockOf()}`)
  ok('P0i. direct_p2p fault_logistics:仍零钱包(不印钱)+ settled_fault_at 落库', wu('buyer1').balance === bL.balance && wu('buyer1').escrowed === bL.escrowed && wu('buyer1').escrowed >= 0 && !!(db.prepare("SELECT settled_fault_at FROM orders WHERE id='oFaultLog'").get() as { settled_fault_at?: string } | undefined)?.settled_fault_at)
}

// ═══ P1(钱路):送达后买家逾期未确认 → checkTimeouts 走 settleOrder 收口(两轨),绝不 settleFault('confirmed') ═══
{
  const stockOf = () => (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
  const wu = (u: string) => walletUnits(db, u)
  const confirmedSettled: string[] = []
  // settleConfirmed = 注入的成交结算(镜像 server.ts settleOrder):direct_p2p 释放遗留 stake+accrue;escrow 释放 escrow→卖家。
  const settleConfirmedStub = (orderId: string): void => { db.transaction(() => {
    const o = db.prepare('SELECT payment_rail, total_amount, source, seller_id, buyer_id FROM orders WHERE id=?').get(orderId) as { payment_rail?: string; total_amount?: number; source?: string | null; seller_id?: string; buyer_id?: string }
    confirmedSettled.push(orderId)
    if (o?.payment_rail === 'direct_p2p') {
      releaseFeeStake(db, { orderId })
      accrueFeeReceivable(db, { orderId, sellerId: o.seller_id as string, feeUnits: feeUnitsForOrder(toUnits(Number(o.total_amount) || 0), o.source ?? null), receivableId: `dpfr_${++rk}` })
      return
    }
    const totalU = toUnits(Number(o.total_amount) || 0)   // escrow 最小镜像:escrow→卖家(证明卖家收款,对照旧 settleFault('confirmed') 空结算)
    applyWalletDelta(db, o.buyer_id as string, { escrowed: -totalU })
    applyWalletDelta(db, o.seller_id as string, { balance: totalU, earned: totalU })
  })() }

  // (a) direct_p2p delivered + confirm_deadline 已过 + settler → 自动确认成交:走 settler、completed、不回补库存、不落 settled_fault_at
  mkOrder('oAcDp', 'delivered', 'direct_p2p'); lock('oAcDp')
  db.prepare("UPDATE orders SET confirm_deadline = datetime('now','-1 hour') WHERE id='oAcDp'").run()
  const stA = stockOf()
  checkTimeouts(db, { settleConfirmed: settleConfirmedStub })
  ok('P1a. direct_p2p 逾期未确认 → completed', status('oAcDp') === 'completed', `status=${status('oAcDp')}`)
  ok('P1b. direct_p2p 自动确认走 settleConfirmed(非 settleFault)', confirmedSettled.includes('oAcDp'))
  ok('P1c. direct_p2p 自动确认 accrue 平台费应收', !!receivable('oAcDp'))
  ok('P1d. direct_p2p 自动确认【不回补库存】(已售出,对照 settleFault 幻影回补)', stockOf() === stA, `before=${stA} after=${stockOf()}`)
  ok('P1e. direct_p2p 自动确认【不落 settled_fault_at】(未走 settleFault)', !(db.prepare("SELECT settled_fault_at FROM orders WHERE id='oAcDp'").get() as { settled_fault_at?: string } | undefined)?.settled_fault_at)

  // (b) escrow delivered + confirm_deadline 已过 + settler → 卖家收款(对照旧 settleFault('confirmed') 空结算=卖家永不收款、escrow 锁死)
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyerE2','托管买家2','buyer','k_be2')").run()
  db.prepare("INSERT INTO wallets (user_id, balance, escrowed) VALUES ('buyerE2', 0, 50)").run()
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode, confirm_deadline) VALUES ('oAcEsc','p1','buyerE2','seller1',1,50,50,50,'delivered','escrow','shipped',datetime('now','-1 hour'))").run()
  const sBefore = wu('seller1')
  checkTimeouts(db, { settleConfirmed: settleConfirmedStub })
  ok('P1f. escrow 逾期未确认 → completed', status('oAcEsc') === 'completed', `status=${status('oAcEsc')}`)
  // 断言"发生了资金移动 + escrow 释放"(方向,非精确金额)—— 修复空结算(旧 settleFault('confirmed') 零移动)。
  //   精确净额分账(总额−费−佣金−基金)由 test:settlement-breakdown / seller-order-actions 覆盖真实 settleOrder;
  //   此处 settleConfirmed 是【注入的协作者】,只验 checkTimeouts 路由到它、且成交路径确有资金移动,不复刻分账数字。
  ok('P1g. escrow 自动确认走 settleConfirmed → 卖家收款(movement>0 + escrow 释放,修复空结算)', confirmedSettled.includes('oAcEsc') && wu('seller1').balance > sBefore.balance && wu('buyerE2').escrowed === 0, `seller ${sBefore.balance}→${wu('seller1').balance} buyerE2.esc=${wu('buyerE2').escrowed}`)

  // (c) 无 settler(独立 cron/CLI)→ 不自动确认:留 delivered、settler 未调、不落 settled_fault_at(绝不 settleFault('confirmed') 误结算/搁浅)
  mkOrder('oAcNo', 'delivered', 'direct_p2p'); lock('oAcNo')
  db.prepare("UPDATE orders SET confirm_deadline = datetime('now','-1 hour') WHERE id='oAcNo'").run()
  const stN = stockOf()
  checkTimeouts(db)
  ok('P1h. 无 settler:留 delivered(不搁浅在 confirmed)', status('oAcNo') === 'delivered', `status=${status('oAcNo')}`)
  ok('P1i. 无 settler:不回补库存 + 不落 settled_fault_at(未误走 settleFault)', stockOf() === stN && !(db.prepare("SELECT settled_fault_at FROM orders WHERE id='oAcNo'").get() as { settled_fault_at?: string } | undefined)?.settled_fault_at)

  // (d) confirm_deadline 未到 → 不触发(确实以 deadline 为准)
  mkOrder('oAcFut', 'delivered', 'direct_p2p')
  db.prepare("UPDATE orders SET confirm_deadline = datetime('now','+72 hours') WHERE id='oAcFut'").run()
  checkTimeouts(db, { settleConfirmed: settleConfirmedStub })
  ok('P1j. confirm_deadline 未到 → 不自动确认(仍 delivered)', status('oAcFut') === 'delivered')

  // (e) route:direct_p2p in_transit→deliver 生成 confirm_deadline(+72h)——补全 direct-pay 建单缺失列
  mkOrder('oDlv', 'in_transit', 'direct_p2p')
  const rDlv = await call('oDlv', { action: 'deliver', evidence_description: '已投递签收' }, 'seller1', 'seller')
  const cd = (db.prepare("SELECT confirm_deadline FROM orders WHERE id='oDlv'").get() as { confirm_deadline: string | null }).confirm_deadline
  // ISO 格式('T')断言:防回退到 datetime('now',...) 空格格式 —— 后者与 ISO now 字符串比较会在同日提前 ~24h 触发。
  ok('P1k. route:direct_p2p deliver → delivered 且生成 confirm_deadline(ISO 格式)', rDlv.status === 200 && status('oDlv') === 'delivered' && !!cd && cd!.includes('T'), `${JSON.stringify(rDlv)} cd=${cd}`)

  // (f) 回归防线(review finding #1):同一日历日稍晚(+3h)的 ISO confirm_deadline 未到 → 绝不提前自动确认。
  //   若 findActiveDeadlineTransition 的 now(ISO) > deadline 比较对同日未来 deadline 误判为已过,本单会被错误 completed。
  mkOrder('oAcSoon', 'delivered', 'direct_p2p')
  db.prepare("UPDATE orders SET confirm_deadline = ? WHERE id='oAcSoon'").run(new Date(Date.now() + 3 * 3600 * 1000).toISOString())
  checkTimeouts(db, { settleConfirmed: settleConfirmedStub })
  ok('P1l. 同日 +3h 的 ISO deadline 未到 → 不提前自动确认(仍 delivered)', status('oAcSoon') === 'delivered', `status=${status('oAcSoon')}`)
}

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-actions route tests passed`)
