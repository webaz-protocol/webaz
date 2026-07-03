#!/usr/bin/env tsx
/**
 * 直付取消退款握手(审计项 C)—— 域 + HTTP e2e。
 *   付款后(accepted)·发货前:买家 request → 卖家 mark_refunded(场外退款)→ 买家 confirm(Passkey)
 *   → 系统 accepted→cancelled + 恢复库存。零资金(非托管);escrow 拒;握手不阻塞发货(竞态 fail-closed)。
 * Usage: npm run test:direct-pay-cancel-refund
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dpcr-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const CR = await import('../src/direct-pay-cancel-refund.js')
const { registerDirectPayCancelRefundRoutes } = await import('../src/pwa/routes/direct-pay-cancel-refund.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initOrderChainSchema(db); initWebauthnSchema(db); CR.initDirectPayCancelRefundSchema(db); initNotificationSchema(db)
const mkUser = (id: string, role = 'buyer'): void => { db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id) }
mkUser('b1'); mkUser('s1', 'seller'); mkUser('outsider')
db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_b1', 'b1', Buffer.from([1]))
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',50,5)").run()

let oc = 0
function mkOrder(status: string, rail = 'direct_p2p', qty = 2): string {
  const id = `o_${++oc}`
  db.prepare('INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'p', 'b1', 's1', qty, 25, 50, 0, status, rail)
  return id
}
const rid = (() => { let n = 0; return () => `dpcr_${++n}` })()

// ── 域:request 守卫 ──
{
  const escrowO = mkOrder('accepted', 'escrow')
  ok('1. escrow order rejected (NOT_DIRECT_PAY)', CR.requestCancelRefund(db, { orderId: escrowO, buyerId: 'b1', requestId: rid() }).error_code === 'NOT_DIRECT_PAY')
  const windowO = mkOrder('direct_pay_window')
  ok('2. non-accepted status rejected (ORDER_NOT_ACCEPTED)', CR.requestCancelRefund(db, { orderId: windowO, buyerId: 'b1', requestId: rid() }).error_code === 'ORDER_NOT_ACCEPTED')
  const o = mkOrder('accepted')
  ok('3. seller cannot request (NOT_ORDER_BUYER)', CR.requestCancelRefund(db, { orderId: o, buyerId: 's1', requestId: rid() }).error_code === 'NOT_ORDER_BUYER')
  ok('4. buyer request ok', CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', reason: ' 不想要了 ', requestId: rid() }).ok === true)
  ok('5. duplicate open request rejected', CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() }).error_code === 'REQUEST_ALREADY_OPEN')
  // 卖家拒绝 → 可重新申请;3 次封顶
  ok('6. seller decline ok', CR.declineCancelRefund(db, { orderId: o, sellerId: 's1' }).ok === true)
  ok('7. re-request after decline ok', CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() }).ok === true)
  ok('8. withdraw (before seller responds) ok', CR.withdrawCancelRefund(db, { orderId: o, buyerId: 'b1' }).ok === true)
  ok('9. third request ok', CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() }).ok === true)
  CR.declineCancelRefund(db, { orderId: o, sellerId: 's1' })
  ok('10. 4th request hits cap (REQUEST_CAP_REACHED)', CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() }).error_code === 'REQUEST_CAP_REACHED')
}

// ── 域:mark_refunded / withdraw 边界 / confirm settle ──
{
  const o = mkOrder('accepted')
  CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() })
  ok('11. outsider cannot mark refunded (NOT_ORDER_SELLER)', CR.markRefunded(db, { orderId: o, sellerId: 'outsider' }).error_code === 'NOT_ORDER_SELLER')
  ok('12. confirm before refund_marked rejected (REFUND_NOT_MARKED)', (() => { try { return db.transaction(() => CR.confirmRefundReceived(db, { orderId: o, buyerId: 'b1' }, transition))().error_code === 'REFUND_NOT_MARKED' } catch { return false } })())
  ok('13. seller mark_refunded ok (with reference)', CR.markRefunded(db, { orderId: o, sellerId: 's1', refundReference: 'TXN-888' }).ok === true)
  ok('14. buyer withdraw AFTER refund_marked rejected (no free-ride)', CR.withdrawCancelRefund(db, { orderId: o, buyerId: 'b1' }).error_code === 'NO_OPEN_REQUEST')
  const stockBefore = (db.prepare("SELECT stock FROM products WHERE id='p'").get() as { stock: number }).stock
  const r = db.transaction(() => CR.confirmRefundReceived(db, { orderId: o, buyerId: 'b1' }, transition))()
  ok('15. confirm settles: ok + order cancelled', r.ok === true && (db.prepare('SELECT status FROM orders WHERE id=?').get(o) as { status: string }).status === 'cancelled')
  const stockAfter = (db.prepare("SELECT stock FROM products WHERE id='p'").get() as { stock: number }).stock
  ok('16. stock restored by quantity (+2)', stockAfter === stockBefore + 2, `before=${stockBefore} after=${stockAfter}`)
  ok('17. request row settled', (db.prepare('SELECT status FROM direct_pay_cancel_requests WHERE order_id=? ORDER BY created_at DESC LIMIT 1').get(o) as { status: string }).status === 'settled')
  ok('18. confirm idempotence: second confirm rejected (order no longer accepted)', db.transaction(() => CR.confirmRefundReceived(db, { orderId: o, buyerId: 'b1' }, transition))().error_code === 'ORDER_NOT_ACCEPTED')
}

// ── 域:发货竞态(握手不阻塞履约,fail-closed 失效)──
{
  const o = mkOrder('accepted')
  CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() })
  CR.markRefunded(db, { orderId: o, sellerId: 's1' })
  db.prepare("UPDATE orders SET status='shipped' WHERE id=?").run(o)   // 卖家发货与 confirm 竞态
  ok('19. confirm after ship rejected (ORDER_NOT_ACCEPTED), request row untouched', db.transaction(() => CR.confirmRefundReceived(db, { orderId: o, buyerId: 'b1' }, transition))().error_code === 'ORDER_NOT_ACCEPTED'
    && (db.prepare('SELECT status FROM direct_pay_cancel_requests WHERE order_id=?').get(o) as { status: string }).status === 'refund_marked')
  ok('20. getState marks open request stale after ship', (CR.getCancelRefundState(db, o, 'b1').request as Record<string, unknown>)?.stale === true)
  ok('21. mark_refunded after ship rejected', (() => { const o2 = mkOrder('accepted'); CR.requestCancelRefund(db, { orderId: o2, buyerId: 'b1', requestId: rid() }); db.prepare("UPDATE orders SET status='shipped' WHERE id=?").run(o2); return CR.markRefunded(db, { orderId: o2, sellerId: 's1' }).error_code === 'ORDER_NOT_ACCEPTED' })())
}

// ── 域:party-gate + settle 原子性 ──
{
  const o = mkOrder('accepted')
  ok('22. getState party-gated (outsider → NOT_A_PARTY)', CR.getCancelRefundState(db, o, 'outsider').error_code === 'NOT_A_PARTY')
  CR.requestCancelRefund(db, { orderId: o, buyerId: 'b1', requestId: rid() }); CR.markRefunded(db, { orderId: o, sellerId: 's1' })
  // transition 失败 → 整体回滚(请求行 CAS 也回滚)
  const boom = () => ({ success: false, error: 'boom' })
  let threw = false
  try { db.transaction(() => CR.confirmRefundReceived(db, { orderId: o, buyerId: 'b1' }, boom as never))() } catch { threw = true }
  ok('23. settle atomicity: failed transition throws + request row rolled back to refund_marked', threw
    && (db.prepare('SELECT status FROM direct_pay_cancel_requests WHERE order_id=?').get(o) as { status: string }).status === 'refund_marked'
    && (db.prepare('SELECT status FROM orders WHERE id=?').get(o) as { status: string }).status === 'accepted')
}

// ── 库存回补守卫(电商裁定:已出库绝不直接回补,走退货验收上架)──
{
  const { restorePreShipDirectPayStock, PRE_SHIP_RESTOCK_STATUSES } = await import('../src/direct-pay-stock.js')
  const stockOf = () => (db.prepare("SELECT stock FROM products WHERE id='p'").get() as { stock: number }).stock
  const s0 = stockOf()
  for (const bad of ['shipped', 'picked_up', 'in_transit', 'delivered', 'disputed', 'confirmed', 'completed']) {
    restorePreShipDirectPayStock(db, { fromStatus: bad, productId: 'p', quantity: 1 })
  }
  ok('33. restock guard: ALL post-outbound/disputed origins refused (stock unchanged)', stockOf() === s0)
  ok('34. restock guard: pre-ship whitelist is exactly the never-outbound set', ['direct_pay_window', 'direct_expired_unconfirmed', 'payment_query', 'accepted'].every(st => PRE_SHIP_RESTOCK_STATUSES.has(st)) && PRE_SHIP_RESTOCK_STATUSES.size === 4)
  ok('35. restock guard: pre-ship origin restores and reports true', restorePreShipDirectPayStock(db, { fromStatus: 'direct_pay_window', productId: 'p', quantity: 2 }) === true && stockOf() === s0 + 2)
  db.prepare("UPDATE products SET stock = ? WHERE id='p'").run(s0)   // 复原,不影响后续用例
}

// ── HTTP e2e:路由 + Passkey 门 + 通知 ──
const app = express(); app.use(express.json())
let gateOk = true
registerDirectPayCancelRefundRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: uid === 's1' ? 'seller' : 'buyer' } },
  generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`,
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
  consumeGateToken: (_u: string, token: string | undefined, purpose: string, validate: (d: unknown) => boolean) => {
    if (!gateOk) return { ok: false, reason: 'no human' }
    if (purpose !== 'direct_pay_order_action') return { ok: false, reason: 'wrong purpose' }
    try { const d = JSON.parse(String(token || '{}')); return validate(d) ? { ok: true } : { ok: false, reason: 'purpose_data mismatch' } } catch { return { ok: false, reason: 'bad token' } }
  },
} as never)
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})

try {
  const o = mkOrder('accepted')
  ok('24. GET state party-gated over HTTP (outsider 403)', (await call('GET', `/api/orders/${o}/cancel-refund`, 'outsider')).status === 403)
  const g0 = await call('GET', `/api/orders/${o}/cancel-refund`, 'b1')
  ok('25. GET state: buyer can_request', g0.status === 200 && g0.json.can_request === true)
  ok('26. POST request ok + seller notified', (await call('POST', `/api/orders/${o}/cancel-refund/request`, 'b1', { reason: '买错了' })).status === 200
    && (db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id=? AND user_id='s1' AND type='direct_pay_cancel_requested'").get(o) as { n: number }).n === 1)
  const gs = await call('GET', `/api/orders/${o}/cancel-refund`, 's1')
  ok('27. GET state: seller can_respond + sees reason', gs.json.can_respond === true && (gs.json.request as Record<string, unknown>)?.reason === '买错了')
  ok('28. POST mark-refunded ok + buyer notified', (await call('POST', `/api/orders/${o}/cancel-refund/mark-refunded`, 's1', { refund_reference: 'TXN-1' })).status === 200
    && (db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id=? AND user_id='b1' AND type='direct_pay_refund_marked'").get(o) as { n: number }).n === 1)
  // confirm:无 token → 403 且不消费(预检先行);带匹配 token → 200 关单
  ok('29. confirm without valid token → 403 HUMAN_PRESENCE_REQUIRED', (await call('POST', `/api/orders/${o}/cancel-refund/confirm`, 'b1', {})).status === 403)
  ok('30. confirm with wrong-action token → 403 (purpose_data validate)', (await call('POST', `/api/orders/${o}/cancel-refund/confirm`, 'b1', { webauthn_token: JSON.stringify({ order_id: o, action: 'mark_paid' }) })).status === 403)
  const c = await call('POST', `/api/orders/${o}/cancel-refund/confirm`, 'b1', { webauthn_token: JSON.stringify({ order_id: o, action: 'cancel_refund_confirm' }) })
  ok('31. confirm with valid token → 200 cancelled + seller notified', c.status === 200 && c.json.status === 'cancelled'
    && (db.prepare('SELECT status FROM orders WHERE id=?').get(o) as { status: string }).status === 'cancelled'
    && (db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id=? AND user_id='s1' AND type='direct_pay_cancel_settled'").get(o) as { n: number }).n === 1)
  // 预检不浪费 token:无 open 请求时 confirm 409(而非消费 token 后失败)
  const o2 = mkOrder('accepted')
  ok('32. confirm precheck 409 REFUND_NOT_MARKED before any gate consumption', (await call('POST', `/api/orders/${o2}/cancel-refund/confirm`, 'b1', { webauthn_token: 'x' })).status === 409)
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ direct-pay-cancel-refund FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay cancel-refund handshake: request/decline/mark-refunded/withdraw/confirm matrix + stock restore + ship-race fail-closed + atomicity + party-gate + Passkey gate + notifications\n  ✅ pass ${pass}`)
