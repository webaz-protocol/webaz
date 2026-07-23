#!/usr/bin/env tsx
/**
 * 2026-07 订单流遍历审计:自动执法/裁定/协商取消 —— 通知补齐回归锁。
 *   根因事故:direct_p2p 单买家场外付款后,卖家 72h 超时被系统判责关单(fault_seller→completed),
 *   买卖双方【零通知】(生产 ord_87c21c0b04ae/ord_a5791a9a30 实锤)。本测试锁:
 *   ① checkTimeouts details 携带结构化 transitions 对;
 *   ② notifyEnforcementTransitions 按 RULES 发出双方通知(rail-fork:direct 绝无"已退款"话术);
 *   ③ arbitrateDispute 细粒度裁定终态通知(手动+自动同一发射点);
 *   ④ mutual-cancel propose/accept/decline 当事方通知;
 *   ⑤ force-timeout-check 对本次扫出的【全部】订单记信誉+发通知(不只请求单)。
 * 真实引擎,不桩被测组件(notification-engine/checkTimeouts/arbitrateDispute 全真)。
 * Usage: npm run test:enforcement-notifications
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'enf-notify-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initSystemUser, transition, settleFault, checkTimeouts } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initNotificationSchema, notifyEnforcementTransitions } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { initReputationSchema, recordViolationReputation } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema, arbitrateDispute, createDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { initMutualCancelSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.js')
const { registerMutualCancelRoutes } = await import('../src/pwa/routes/mutual-cancel.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderChainSchema(db)
for (const c of ['settled_fault_at TEXT', 'has_pending_claim INTEGER DEFAULT 0', 'decline_objective_pending INTEGER DEFAULT 0', 'decline_contested INTEGER DEFAULT 0', 'decline_contest_deadline TEXT', 'delivery_failed_deadline TEXT', "source TEXT DEFAULT 'shop'", 'stake_backing REAL DEFAULT 0', 'bid_stake_held REAL DEFAULT 0'])
  { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* 已有 */ } }
initNotificationSchema(db); initReputationSchema(db); initDisputeSchema(db); initMutualCancelSchema(db); initSystemUser(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','买家甲','buyer','kb'),('s1','卖家乙','seller','ks')").run()
db.prepare("INSERT INTO wallets (user_id, balance, escrowed) VALUES ('b1',0,0),('s1',100,0)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','s1','测试品','d',50,100)").run()

const past = new Date(Date.now() - 3600_000).toISOString()
let n = 0
function mkOrder(st: string, rail: string, extra: Record<string, unknown> = {}): string {
  const id = `o_${++n}`
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, shipping_address)
     VALUES (?,'p1','b1','s1',1,50,50,?,?,?,'地址')`).run(id, rail === 'escrow' ? 50 : 0, st, rail)
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE orders SET ${k} = ? WHERE id = ?`).run(v, id)
  return id
}
const notifKeys = (uid: string, orderId: string): string[] =>
  (db.prepare('SELECT template_key FROM notifications WHERE user_id = ? AND order_id = ? ORDER BY rowid').all(uid, orderId) as Array<{ template_key: string | null }>).map(r => String(r.template_key))
const notifBodies = (uid: string, orderId: string): string =>
  (db.prepare('SELECT body FROM notifications WHERE user_id = ? AND order_id = ? ORDER BY rowid').all(uid, orderId) as Array<{ body: string }>).map(r => r.body).join('\n')

// ═══ ① direct_p2p 卖家发货超时:判责+处置 → 双方两条通知(生产事故的精确复刻)═══
{
  const o = mkOrder('accepted', 'direct_p2p', { ship_deadline: past })
  const r = checkTimeouts(db)
  const d = r.details.find(x => x.orderId === o)
  ok('1a. details 带结构化 transitions 对', JSON.stringify(d?.transitions) === JSON.stringify([['accepted', 'fault_seller'], ['fault_seller', 'completed']]), JSON.stringify(d))
  notifyEnforcementTransitions(db, r.details)
  ok('1b. 买家收到判责+处置两条(dp 键)', JSON.stringify(notifKeys('b1', o)) === JSON.stringify(['ord_accepted_fault_seller_dp', 'ord_fault_seller_completed_dp']), JSON.stringify(notifKeys('b1', o)))
  ok('1c. 卖家同样两条', JSON.stringify(notifKeys('s1', o)) === JSON.stringify(['ord_accepted_fault_seller_dp', 'ord_fault_seller_completed_dp']))
  const body = notifBodies('b1', o)
  ok('1d. dp 文案非托管诚实(无"资金退回/已退款"话术,有场外协商指引)', body.includes('非托管') && body.includes('场外') && !/资金退回|WAZ 已全额退回|已退款/.test(body))
}

// ═══ ② escrow 卖家发货超时:判责+处置 → 退款话术 ═══
{
  db.prepare("UPDATE wallets SET escrowed = 50 WHERE user_id = 'b1'").run()
  const o = mkOrder('accepted', 'escrow', { ship_deadline: past })
  const r = checkTimeouts(db)
  notifyEnforcementTransitions(db, r.details)
  ok('2a. escrow 买家两条(非 dp 键)', JSON.stringify(notifKeys('b1', o)) === JSON.stringify(['ord_accepted_fault_seller', 'ord_fault_seller_completed']), JSON.stringify(notifKeys('b1', o)))
  ok('2b. escrow 处置文案含全额退回', notifBodies('b1', o).includes('已全额退回买家'))
}

// ═══ ③ delivered 逾期自动确认:settleConfirmed 注入 → 卖家收确认+完成通知 ═══
{
  const o = mkOrder('delivered', 'escrow', { confirm_deadline: past })
  const r = checkTimeouts(db, { settleConfirmed: () => { /* settleOrder 桩:通知层不依赖结算结果 */ } })
  const d = r.details.find(x => x.orderId === o)
  ok('3a. 自动确认 transitions 对', JSON.stringify(d?.transitions) === JSON.stringify([['delivered', 'confirmed'], ['confirmed', 'completed']]), JSON.stringify(d))
  notifyEnforcementTransitions(db, r.details)
  ok('3b. 卖家收 confirmed+completed 通知', JSON.stringify(notifKeys('s1', o)) === JSON.stringify(['ord_delivered_confirmed', 'ord_confirmed_completed']))
}

// ═══ ④ created 付款超时自动取消 → 买家通知 ═══
{
  const o = mkOrder('created', 'escrow', { pay_deadline: past })
  const r = checkTimeouts(db)
  notifyEnforcementTransitions(db, r.details)
  ok('4. 付款超时取消 → 买家 ord_created_cancelled', JSON.stringify(notifKeys('b1', o)) === JSON.stringify(['ord_created_cancelled']), JSON.stringify(notifKeys('b1', o)))
}

// ═══ ⑤ arbitrateDispute 细粒度裁定终态通知(direct_p2p refund_buyer → refunded_full_dp)═══
{
  const o = mkOrder('disputed', 'direct_p2p')
  const cd = createDispute(db, o, 'b1', '货不对版', [])
  ok('5a. dispute fixture 建立', !!cd && (cd as { success?: boolean }).success !== false, JSON.stringify(cd))
  const disputeId = (db.prepare('SELECT id FROM disputes WHERE order_id = ? ORDER BY rowid DESC LIMIT 1').get(o) as { id: string }).id
  const ar = arbitrateDispute(db, disputeId, 'sys_protocol', 'refund_buyer', '证据支持买家')
  ok('5b. 裁定执行成功(非托管)', ar.success === true && ar.non_custodial === true, JSON.stringify(ar))
  ok('5c. 双方收 ord_disputed_refunded_full_dp', notifKeys('b1', o).includes('ord_disputed_refunded_full_dp') && notifKeys('s1', o).includes('ord_disputed_refunded_full_dp'), JSON.stringify(notifKeys('b1', o)))
  ok('5d. dp 裁定文案无托管退款假话', !/WAZ 已退回|资金已释放/.test(notifBodies('b1', o)) && notifBodies('b1', o).includes('非托管'))
}

// ═══ ⑥ mutual-cancel 路由通知(propose→对方;accept→双方,dp 分轨)═══
{
  const o = mkOrder('disputed', 'direct_p2p')
  createDispute(db, o, 'b1', '协商取消场景', [])
  const app = express(); app.use(express.json())
  const authStub = (req: Request, res: Response): Record<string, unknown> | null => {
    const uid = req.headers['x-test-uid'] as string | undefined
    if (!uid) { res.status(401).json({ error: 'login' }); return null }
    return { id: uid }
  }
  let c = 0
  registerMutualCancelRoutes(app, { db, auth: authStub, generateId: (p: string) => `${p}_${++c}`, errorRes: (res, status, code, msg) => res.status(status).json({ error: msg, error_code: code }) })
  let server!: Server
  const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
  const call = (method: string, path: string, uid: string): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'x-test-uid': uid } }, res => { let d = ''; res.on('data', ch => d += ch); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
    rq.on('error', reject); rq.end()
  })
  try {
    const pr = await call('POST', `/api/orders/${o}/mutual-cancel/propose`, 'b1')
    ok('6a. propose 成功 → 对方(卖家)收 mc_proposed', pr.status === 200 && notifKeys('s1', o).includes('mc_proposed'), JSON.stringify({ pr: pr.json, keys: notifKeys('s1', o) }))
    ok('6b. 提议方不收 propose 通知', !notifKeys('b1', o).includes('mc_proposed'))
    const ac = await call('POST', `/api/orders/${o}/mutual-cancel/accept`, 's1')
    ok('6c. accept 成功 → 双方收 mc_done_dp(非托管分轨)', ac.status === 200 && notifKeys('b1', o).includes('mc_done_dp') && notifKeys('s1', o).includes('mc_done_dp'), JSON.stringify(ac.json))
    ok('6d. dp 协商取消文案零资金诚实', notifBodies('b1', o).includes('零资金') && !notifBodies('b1', o).includes('已全额退回'))
    // decline 路径:新单重走 propose→decline
    const o2 = mkOrder('disputed', 'direct_p2p')
    createDispute(db, o2, 'b1', '再来一单', [])
    await call('POST', `/api/orders/${o2}/mutual-cancel/propose`, 'b1')
    const dc = await call('POST', `/api/orders/${o2}/mutual-cancel/decline`, 's1')
    ok('6e. decline → 提议方收 mc_declined', dc.status === 200 && notifKeys('b1', o2).includes('mc_declined'), JSON.stringify(dc.json))
  } finally { server.close() }
}

// ═══ ⑦ force-timeout-check:全量 details 记信誉+发通知(不只请求单)═══
{
  const oA = mkOrder('accepted', 'direct_p2p', { ship_deadline: past })
  const oB = mkOrder('accepted', 'direct_p2p', { ship_deadline: past })   // 无关单,同样逾期
  const app = express(); app.use(express.json())
  let c2 = 0
  registerOrdersActionRoutes(app, {
    db,
    auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
    isTrustedRole: () => false, generateId: (p: string) => `${p}_ft_${++c2}`,
    transition, notifyTransition: () => {}, settleOrder: () => {}, settleFault, detectFraud: () => [],
    createDispute, checkTimeouts, recordViolationReputation, broadcastSystemEvent: () => {},
    consumeGateToken: () => true,
  } as never)
  let server!: Server
  const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
  const r = await new Promise<{ status: number }>((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/orders/${oA}/force-timeout-check`, headers: { 'content-type': 'application/json', 'x-test-uid': 'b1' } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0 })) })
    rq.on('error', reject); rq.end()
  })
  server.close()
  const repOrders = (db.prepare("SELECT DISTINCT order_id FROM reputation_events WHERE order_id IN (?,?)").all(oA, oB) as Array<{ order_id: string }>).map(x => x.order_id).sort()
  ok('7a. force-timeout 200 + 两单都记信誉(含无关单)', r.status === 200 && JSON.stringify(repOrders) === JSON.stringify([oA, oB].sort()), JSON.stringify({ status: r.status, repOrders }))
  ok('7b. 无关单 B 双方也收到通知', notifKeys('b1', oB).length >= 2 && notifKeys('s1', oB).length >= 2, JSON.stringify(notifKeys('b1', oB)))
}

// ═══ ⑧ 处置关单不可评价 — 双向端点(Codex R1 HIGH + R2 HIGH 反向评价旁路;真实表,正常单必须真成功)═══
{
  const { registerRatingsRoutes } = await import('../src/pwa/routes/ratings.js')
  const { initOrderRatingsSchema, initBuyerRatingsSchema } = await import('../src/runtime/webaz-schema-helpers.js')
  initOrderRatingsSchema(db); initBuyerRatingsSchema(db)
  for (const c of ['dim_quality INTEGER', 'dim_speed INTEGER', 'dim_service INTEGER', 'hidden_until TEXT'])
    { try { db.exec(`ALTER TABLE order_ratings ADD COLUMN ${c}`) } catch { /* 已有 */ } }
  const faultClosed = mkOrder('completed', 'direct_p2p')
  db.prepare("UPDATE orders SET settled_fault_at = datetime('now') WHERE id = ?").run(faultClosed)
  const genuine = mkOrder('completed', 'escrow')
  const app = express(); app.use(express.json())
  registerRatingsRoutes(app, {
    db,
    generateId: (p: string) => `${p}_rt_${Math.floor(Math.random() * 1e9)}`,
    auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
    isTrustedRole: () => false,
    errorRes: (res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, error_code: code }),
    broadcastSystemEvent: () => {},
  } as never)
  let server!: Server
  const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
  const rate = (path: string, uid: string): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ stars: 5 })
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-test-uid': uid } }, res => { let d = ''; res.on('data', ch => d += ch); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
  try {
    const rf = await rate(`/api/orders/${faultClosed}/rating`, 'b1')
    ok('8a. 处置关单:买家→卖家评价被拒 400', rf.status === 400 && String(rf.json.error).includes('处置关单'), JSON.stringify(rf))
    const rfb = await rate(`/api/orders/${faultClosed}/buyer-rating`, 's1')
    ok('8b. 处置关单:卖家→买家反向评价同样被拒 400(R2 HIGH)', rfb.status === 400 && String(rfb.json.error).includes('处置关单'), JSON.stringify(rfb))
    const rg = await rate(`/api/orders/${genuine}/rating`, 'b1')
    ok('8c. 正常 completed 正向评价真成功(200)', rg.status === 200 && rg.json.success === true, JSON.stringify(rg))
    const rgb = await rate(`/api/orders/${genuine}/buyer-rating`, 's1')
    ok('8d. 正常 completed 反向评价真成功(200)', rgb.status === 200 && rgb.json.success === true, JSON.stringify(rgb))
  } finally { server.close() }
}

if (fail > 0) { console.error(`\n❌ enforcement-notifications FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ enforcement notifications:checkTimeouts transitions 对 + 自动执法双方通知(rail-fork 诚实文案)+ 裁定终态通知 + 协商取消通知 + force-timeout 全量信誉/通知\n  ✅ pass ${pass}`)
