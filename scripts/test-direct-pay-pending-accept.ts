#!/usr/bin/env tsx
/**
 * 手动接单模式(v16)—— 模式解析 + pending_accept 状态机 + 时序门(接单前零收款信息)+ 超时 sweep + escrow auto。
 *   直付 manual:建单 → pending_accept(扣库存,不开付款窗、收款信息状态门遮蔽)→ 卖家 accept → direct_pay_window
 *   (deadline 此刻起表)| decline / 买家 cancel / 超时 → 无责取消 + 回补库存(零资金)。
 *   escrow:'auto' → paid 后系统自动接单;manual/未设 = 原流程(不进 pending_accept)。
 * Usage: npm run test:direct-pay-pending-accept
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dppa-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const { registerDirectPayPendingAcceptRoutes } = await import('../src/pwa/routes/direct-pay-pending-accept.js')
const { runDirectPayTimeoutSweep } = await import('../src/pwa/routes/direct-pay-timeouts.js')
const { redactUnackedDirectPayTarget, projectDirectPayTargetForViewer } = await import('../src/pwa/direct-pay-order-redaction.js')
const { OPEN_FEE_ACCRUING_STATUSES } = await import('../src/direct-pay-fee-ar.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initOrderChainSchema(db); initNotificationSchema(db)
const mkUser = (id: string, role = 'buyer'): void => { db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id) }
mkUser('b1'); mkUser('s1', 'seller'); mkUser('outsider')
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',50,10)").run()
const stockOf = (): number => (db.prepare("SELECT stock FROM products WHERE id='p'").get() as { stock: number }).stock

const SNAP = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG'], perTxCapUnits: 50_000_000, sellerBreakerTripped: false, decisionCode: 'OK' }
let n = 0; const generateId = (p: string): string => `${p}_${++n}`
const deps = { generateId, transition, appendOrderEvent }
function mkManualOrder(deadlineIso?: string): string {
  return createDirectPayOrder(db, deps as never, {
    productId: 'p', sellerId: 's1', buyerId: 'b1', quantity: 2, unitPrice: 25, totalAmount: 50,
    instructionSnapshot: 'PayNow UEN 123', windowDeadlineIso: new Date(Date.now() + 4 * 3600_000).toISOString(),
    shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP,
    acceptMode: 'manual', pendingAcceptDeadlineIso: deadlineIso ?? new Date(Date.now() + 24 * 3600_000).toISOString(),
  }).orderId
}
const orderRow = (id: string): Record<string, unknown> => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>

// ── ① 建单分流:manual → pending_accept(不开付款窗);auto → direct_pay_window(原行为)──
{
  const s0 = stockOf()
  const oid = mkManualOrder()
  const o = orderRow(oid)
  ok('1. manual create lands pending_accept + snapshot + accept deadline set', o.status === 'pending_accept'
    && o.accept_mode_snapshot === 'manual' && !!o.pending_accept_deadline)
  ok('2. manual create: NO payment window deadline yet (clock starts at accept)', o.direct_pay_window_deadline == null)
  ok('3. stock deducted at create (占用防超卖)', stockOf() === s0 - 2)
  const aid = createDirectPayOrder(db, deps as never, {
    productId: 'p', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 50, totalAmount: 50,
    instructionSnapshot: 'PayNow UEN 123', windowDeadlineIso: new Date(Date.now() + 4 * 3600_000).toISOString(),
    shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP, acceptMode: 'auto',
  }).orderId
  const a = orderRow(aid)
  ok('4. auto create unchanged: direct_pay_window + window deadline + no accept deadline', a.status === 'direct_pay_window'
    && !!a.direct_pay_window_deadline && a.pending_accept_deadline == null && a.accept_mode_snapshot === 'auto')
  // 收尾:回补测试库存基线(直接置回)
  db.prepare("UPDATE products SET stock = 10 WHERE id='p'").run()
  db.prepare("UPDATE orders SET status='cancelled' WHERE id IN (?,?)").run(oid, aid)
}

// ── ② 时序门:pending_accept 阶段收款信息无条件遮蔽(哪怕 both-acked)──
{
  const oid = mkManualOrder()
  // 真实 both-acked(走真 writer → 门若只看 ack 就会漏)
  const { recordDisclosureAck, STAGE } = await import('../src/direct-pay-disclosures.js')
  recordDisclosureAck(db, { orderId: oid, buyerId: 'b1', stage: STAGE.PRE_SELECT, ackId: 'a1' })
  recordDisclosureAck(db, { orderId: oid, buyerId: 'b1', stage: STAGE.PRE_CONFIRM, ackId: 'a2' })
  const o1 = orderRow(oid)
  redactUnackedDirectPayTarget(db, o1, 'b1')
  ok('5. STATUS gate: pending_accept hides instruction even when both-acked', o1.direct_pay_instruction_snapshot === undefined)
  const o2 = orderRow(oid)
  projectDirectPayTargetForViewer(db, o2, 'outsider')
  ok('6. third-party still fully stripped', o2.direct_pay_instruction_snapshot === undefined && o2.direct_pay_account_snapshot === undefined)
  // accept 后(direct_pay_window)ack 门恢复正常放行
  db.prepare("UPDATE orders SET status='direct_pay_window' WHERE id=?").run(oid)
  const o3 = orderRow(oid)
  redactUnackedDirectPayTarget(db, o3, 'b1')
  ok('7. after accept (window) both-acked buyer sees instruction again', o3.direct_pay_instruction_snapshot === 'PayNow UEN 123')
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(oid); db.prepare("UPDATE products SET stock = 10 WHERE id='p'").run()
}

// ── ③ HTTP e2e:accept / decline / cancel + 权限 ──
const app = express(); app.use(express.json())
registerDirectPayPendingAcceptRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: uid === 's1' ? 'seller' : 'buyer' } },
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
  getProtocolParam: <T,>(_k: string, fb: T): T => fb,
} as never)
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})

try {
  // accept
  {
    const oid = mkManualOrder()
    ok('8. outsider cannot accept (403)', (await call('POST', `/api/orders/${oid}/pending-accept/accept`, 'outsider')).status === 403)
    ok('9. buyer cannot accept (403)', (await call('POST', `/api/orders/${oid}/pending-accept/accept`, 'b1')).status === 403)
    const r = await call('POST', `/api/orders/${oid}/pending-accept/accept`, 's1')
    const o = orderRow(oid)
    ok('10. seller accept → direct_pay_window + window deadline starts NOW + buyer notified', r.status === 200
      && o.status === 'direct_pay_window' && !!o.direct_pay_window_deadline
      && (db.prepare("SELECT COUNT(*) c FROM notifications WHERE order_id=? AND user_id='b1' AND type='direct_pay_accepted_by_seller'").get(oid) as { c: number }).c === 1)
    ok('11. double accept rejected (CAS)', (await call('POST', `/api/orders/${oid}/pending-accept/accept`, 's1')).status === 409)
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(oid); db.prepare("UPDATE products SET stock = 10 WHERE id='p'").run()
  }
  // decline + restock
  {
    const s0 = stockOf()
    const oid = mkManualOrder()
    const r = await call('POST', `/api/orders/${oid}/pending-accept/decline`, 's1', { reason: '该地区物流不可达' })
    ok('12. seller decline → cancelled + stock restored + reason in buyer notification', r.status === 200
      && orderRow(oid).status === 'cancelled' && stockOf() === s0
      && String((db.prepare("SELECT body FROM notifications WHERE order_id=? AND user_id='b1' ORDER BY rowid DESC LIMIT 1").get(oid) as { body: string }).body).includes('物流不可达'))
  }
  // buyer cancel + restock
  {
    const s0 = stockOf()
    const oid = mkManualOrder()
    ok('13. seller cannot buyer-cancel (403)', (await call('POST', `/api/orders/${oid}/pending-accept/cancel`, 's1')).status === 403)
    const r = await call('POST', `/api/orders/${oid}/pending-accept/cancel`, 'b1')
    ok('14. buyer cancel → cancelled + stock restored + seller notified', r.status === 200
      && orderRow(oid).status === 'cancelled' && stockOf() === s0
      && (db.prepare("SELECT COUNT(*) c FROM notifications WHERE order_id=? AND user_id='s1' AND type='direct_pay_accept_cancelled'").get(oid) as { c: number }).c === 1)
  }
  // accept-mode 设置端点
  {
    ok('15. buyer cannot set accept-mode (403)', (await call('POST', '/api/seller/accept-mode', 'b1', { store_accept_mode: 'manual' })).status === 403)
    ok('16. seller sets store default', (await call('POST', '/api/seller/accept-mode', 's1', { store_accept_mode: 'manual' })).status === 200
      && (db.prepare("SELECT store_accept_mode m FROM users WHERE id='s1'").get() as { m: string }).m === 'manual')
    ok('17. seller sets per-product override', (await call('POST', '/api/seller/accept-mode', 's1', { product_id: 'p', accept_mode: 'auto' })).status === 200
      && (db.prepare("SELECT accept_mode m FROM products WHERE id='p'").get() as { m: string }).m === 'auto')
    ok('18. invalid value rejected', (await call('POST', '/api/seller/accept-mode', 's1', { store_accept_mode: 'yolo' })).status === 400)
    ok('19. not-owner product rejected', (await call('POST', '/api/seller/accept-mode', 's1', { product_id: 'nope', accept_mode: 'manual' })).status === 404)
    db.prepare("UPDATE users SET store_accept_mode=NULL WHERE id='s1'").run(); db.prepare("UPDATE products SET accept_mode=NULL WHERE id='p'").run()
  }
} finally { server.close() }

// ── ④ 超时 sweep E:过窗 → 无责取消 + 回补 + 双方通知;窗内绝不动 ──
{
  const s0 = stockOf()
  const expired = mkManualOrder('2020-01-01T00:00:00.000Z')
  const fresh = mkManualOrder()
  const r = runDirectPayTimeoutSweep({ db })
  ok('20. sweep cancels ONLY past-deadline pending_accept', r.acceptExpired.includes(expired) && !r.acceptExpired.includes(fresh)
    && orderRow(expired).status === 'cancelled' && orderRow(fresh).status === 'pending_accept')
  ok('21. expiry restores stock (net: only fresh order still holds 2)', stockOf() === s0 - 2)
  ok('22. both parties notified on expiry', (db.prepare("SELECT COUNT(*) c FROM notifications WHERE order_id=? AND type='direct_pay_accept_expired'").get(expired) as { c: number }).c === 2)
  ok('23. sweep idempotent (second run no-op)', runDirectPayTimeoutSweep({ db }).acceptExpired.length === 0)
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(fresh); db.prepare("UPDATE products SET stock = 10 WHERE id='p'").run()
}

// ── ⑤ 护栏口径:pending_accept 计入在途费估 + 状态机边角 + escrow auto 静态锚 ──
{
  ok('24. pending_accept counted in OPEN_FEE_ACCRUING_STATUSES (griefing/fee gates)', (OPEN_FEE_ACCRUING_STATUSES as readonly string[]).includes('pending_accept'))
  const { readFileSync } = await import('fs')
  const OC = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  ok('27. escrow auto mode wired (mode ?? store default → auto-accept at paid, alongside Skill)',
    /_acceptModeAuto \|\| shouldAutoAccept\(db, orderId\)/.test(OC) && /store_accept_mode FROM users/.test(OC) && /自动接单\(卖家接单模式设置\)/.test(OC))
  ok('28. dp create-cap counts pending_accept (griefing guard)', /'pending_accept','direct_pay_window'/.test(readFileSync('src/direct-pay-create.ts', 'utf8')))
  const oid = mkManualOrder()
  ok('25. pending_accept cannot jump to accepted directly (no such edge)', transition(db, oid, 'accepted', 's1', [], 'x').success === false)
  ok('26. buyer cannot drive pending_accept→direct_pay_window (seller/system only)', transition(db, oid, 'direct_pay_window', 'b1', [], 'x').success === false)
}

if (fail > 0) { console.error(`\n❌ direct-pay-pending-accept FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay pending-accept (manual accept mode v16): create fork + status-gated payment info + accept/decline/cancel + expiry sweep + restock + mode settings endpoint + fee/cap accounting\n  ✅ pass ${pass}`)
