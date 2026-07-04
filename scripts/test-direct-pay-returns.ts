#!/usr/bin/env tsx
/**
 * 直付(direct_p2p)送达后退货·场外退款握手 —— 域 + returns 路由集成 + HTTP e2e。
 *   completed 单可申请退货(原 DIRECT_PAY_NO_REFUND 已移除);卖家同意 → await_refund →
 *   mark_refunded → 买家 Passkey confirm → refunded。零资金、零库存回补、订单状态不变;
 *   escrow 退货路径完全不变(回归)。
 * Usage: npm run test:direct-pay-returns
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dpret-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initReturnRequestsSchema, initReturnMessagesSchema, initWebauthnSchema, initRegisterListSearchColumns } = await import('../src/runtime/webaz-schema-helpers.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { initReputationSchema } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { initPendingCommissionEscrowSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const DR = await import('../src/direct-pay-returns.js')
const { registerReturnsRoutes } = await import('../src/pwa/routes/returns.js')
const { registerDirectPayReturnsRoutes } = await import('../src/pwa/routes/direct-pay-returns.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initRegisterListSearchColumns(db); initReturnRequestsSchema(db); initReturnMessagesSchema(db); initWebauthnSchema(db); initNotificationSchema(db); initReputationSchema(db); initDisputeSchema(db); initPendingCommissionEscrowSchema(db)
try { db.exec('ALTER TABLE products ADD COLUMN completion_count INTEGER DEFAULT 0') } catch { /* 已存在(生产为 server.ts 内联 ALTER) */ }
try { db.exec('ALTER TABLE return_requests ADD COLUMN pickup_requested INTEGER DEFAULT 0') } catch { /* 同上 */ }
try { db.exec('ALTER TABLE return_requests ADD COLUMN pickup_address TEXT') } catch { /* 同上 */ }
try { db.exec('ALTER TABLE return_messages ADD COLUMN flagged INTEGER DEFAULT 0') } catch { /* 同上 */ }
try { db.exec('ALTER TABLE return_messages ADD COLUMN flag_reasons TEXT') } catch { /* 同上 */ }
try { db.exec("ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'shop'") } catch { /* 同上 */ }
try { db.exec('ALTER TABLE orders ADD COLUMN variant_id TEXT') } catch { /* 同上 */ }
const mkUser = (id: string, role = 'buyer'): void => { db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id) }
mkUser('b1'); mkUser('s1', 'seller'); mkUser('outsider')
db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_b1', 'b1', Buffer.from([1]))
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('w_b1','w','buyer','k_w')").run
db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').run('b1', 0)
db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').run('s1', 1000)
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,return_days,completion_count) VALUES ('p','s1','P','d',50,5,7,3)").run()

let oc = 0
function mkOrder(status: string, rail = 'direct_p2p', qty = 1): string {
  const id = `o_${++oc}`
  db.prepare(`INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .run(id, 'p', 'b1', 's1', qty, 50, 50 * qty, 0, status, rail)
  return id
}
function mkReturn(orderId: string, status: string, opts: { refund?: number; awaitSince?: string } = {}): string {
  const id = `ret_${++oc}`
  db.prepare(`INSERT INTO return_requests (id, order_id, buyer_id, seller_id, product_id, reason, refund_amount, status, await_refund_since)
              VALUES (?,?,?,?,?,'quality',?,?,?)`)
    .run(id, orderId, 'b1', 's1', 'p', opts.refund ?? 50, status, opts.awaitSince ?? null)
  return id
}
const rid = (() => { let n = 0; return () => `x_${++n}` })()
const stockOf = (): number => (db.prepare("SELECT stock FROM products WHERE id='p'").get() as { stock: number }).stock
const balOf = (u: string): number => (db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(u) as { balance: number }).balance
const ccOf = (): number => (db.prepare("SELECT completion_count FROM products WHERE id='p'").get() as { completion_count: number }).completion_count

// ── 域:enterAwaitRefund 守卫 ──
{
  const escrowO = mkOrder('completed', 'escrow')
  const er = mkReturn(escrowO, 'pending')
  ok('1. escrow return rejected by enterAwaitRefund (NOT_DIRECT_PAY)', DR.enterAwaitRefund(db, { returnId: er, fromStatus: 'pending', messageId: rid() }).error_code === 'NOT_DIRECT_PAY')
  const o = mkOrder('completed')
  const r1 = mkReturn(o, 'pending')
  ok('2. pending → await_refund ok + anchor set', DR.enterAwaitRefund(db, { returnId: r1, fromStatus: 'pending', sellerResponse: '同意', messageId: rid() }).ok === true
    && (db.prepare('SELECT status, await_refund_since FROM return_requests WHERE id=?').get(r1) as { status: string; await_refund_since: string | null }).status === 'await_refund'
    && !!(db.prepare('SELECT await_refund_since FROM return_requests WHERE id=?').get(r1) as { await_refund_since: string | null }).await_refund_since)
  ok('3. CAS: second enterAwaitRefund rejected (RETURN_ALREADY_SETTLED)', DR.enterAwaitRefund(db, { returnId: r1, fromStatus: 'pending', messageId: rid() }).error_code === 'RETURN_ALREADY_SETTLED')
}

// ── 域:mark_refunded / confirm 边界 + 零资金零库存 ──
{
  const o = mkOrder('completed')
  const r1 = mkReturn(o, 'pending')
  DR.enterAwaitRefund(db, { returnId: r1, fromStatus: 'pending', messageId: rid() })
  ok('4. outsider cannot mark refunded (NOT_ORDER_SELLER)', DR.markReturnRefunded(db, { returnId: r1, sellerId: 'outsider', messageId: rid() }).error_code === 'NOT_ORDER_SELLER')
  ok('5. confirm before refund_marked rejected (REFUND_NOT_MARKED)', DR.confirmReturnRefundReceived(db, { returnId: r1, buyerId: 'b1', messageId: rid() }).error_code === 'REFUND_NOT_MARKED')
  ok('6. seller mark_refunded ok (with reference)', DR.markReturnRefunded(db, { returnId: r1, sellerId: 's1', refundReference: 'TXN-9', messageId: rid() }).ok === true
    && (db.prepare('SELECT refund_reference FROM return_requests WHERE id=?').get(r1) as { refund_reference: string }).refund_reference === 'TXN-9')
  ok('7. seller cannot confirm (NOT_ORDER_BUYER)', DR.confirmReturnRefundReceived(db, { returnId: r1, buyerId: 's1', messageId: rid() }).error_code === 'NOT_ORDER_BUYER')
  const s0 = stockOf(); const bb0 = balOf('b1'); const sb0 = balOf('s1'); const cc0 = ccOf()
  const c = db.transaction(() => DR.confirmReturnRefundReceived(db, { returnId: r1, buyerId: 'b1', messageId: rid() }))()
  ok('8. confirm → refunded terminal + fault reason surfaced', c.ok === true && c.status === 'refunded' && c.seller_fault_reason === 'quality'
    && (db.prepare('SELECT status, resolved_at FROM return_requests WHERE id=?').get(r1) as { status: string; resolved_at: string | null }).status === 'refunded')
  ok('9. ZERO stock restore (post-outbound B-category)', stockOf() === s0, `before=${s0} after=${stockOf()}`)
  ok('10. ZERO funds moved (non-custodial)', balOf('b1') === bb0 && balOf('s1') === sb0)
  ok('11. full refund → completion_count -1 (best-effort social counter)', ccOf() === cc0 - 1, `before=${cc0} after=${ccOf()}`)
  ok('12. order status untouched (return is a side flow)', (db.prepare('SELECT status FROM orders WHERE id=?').get(o) as { status: string }).status === 'completed')
  ok('13. confirm idempotence: second confirm rejected', db.transaction(() => DR.confirmReturnRefundReceived(db, { returnId: r1, buyerId: 'b1', messageId: rid() }))().error_code === 'REFUND_NOT_MARKED')
}

// ── 域:部分退款不减 completion_count;escalate 判定 ──
{
  const o = mkOrder('completed')
  const r1 = mkReturn(o, 'pending', { refund: 20 })
  DR.enterAwaitRefund(db, { returnId: r1, fromStatus: 'pending', messageId: rid() })
  DR.markReturnRefunded(db, { returnId: r1, sellerId: 's1', messageId: rid() })
  const cc0 = ccOf()
  db.transaction(() => DR.confirmReturnRefundReceived(db, { returnId: r1, buyerId: 'b1', messageId: rid() }))()
  ok('14. partial refund keeps completion_count', ccOf() === cc0)
  ok('15. escalatable: refund_marked anytime', DR.directPayReturnEscalatable(db, { status: 'refund_marked' }) === true)
  ok('16. escalatable: fresh await_refund NOT yet', DR.directPayReturnEscalatable(db, { status: 'await_refund', await_refund_since: new Date().toISOString().slice(0, 19).replace('T', ' ') }) === false)
  ok('17. escalatable: await_refund past respond window', DR.directPayReturnEscalatable(db, { status: 'await_refund', await_refund_since: '2020-01-01 00:00:00' }) === true)
  ok('18. escalatable: other statuses never', DR.directPayReturnEscalatable(db, { status: 'pending' }) === false)
}

// ── HTTP e2e:returns 路由集成(request 解禁/decide fork/received fork/escalate)+ 握手端点 + Passkey 门 ──
const app = express(); app.use(express.json())
const deps = {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: uid === 's1' ? 'seller' : (uid === 'lg1' ? 'logistics' : 'buyer') } },
  generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`,
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
  isTrustedRole: () => false,
  broadcastSystemEvent: () => {},
  detectFraud: () => [] as string[],
  consumeGateToken: (_u: string, token: string | undefined, purpose: string, validate: (d: unknown) => boolean) => {
    if (purpose !== 'direct_pay_order_action') return { ok: false, reason: 'wrong purpose' }
    try { const d = JSON.parse(String(token || '{}')); return validate(d) ? { ok: true } : { ok: false, reason: 'purpose_data mismatch' } } catch { return { ok: false, reason: 'bad token' } }
  },
}
registerReturnsRoutes(app, deps as never)
registerDirectPayReturnsRoutes(app, deps as never)
mkUser('lg1', 'logistics')
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})

try {
  // 直付 completed 单:request 解禁(不再 DIRECT_PAY_NO_REFUND)
  const o = mkOrder('completed')
  const reqRes = await call('POST', `/api/orders/${o}/return-request`, 'b1', { reason: 'quality', refund_amount: 50 })
  ok('19. direct_p2p return request ALLOWED (no DIRECT_PAY_NO_REFUND)', reqRes.status === 200 && reqRes.json.success === true, JSON.stringify(reqRes.json))
  const retId = String(reqRes.json.id)
  // 非 completed 直付单仍拒
  const o2 = mkOrder('delivered')
  ok('20. non-completed still rejected', (await call('POST', `/api/orders/${o2}/return-request`, 'b1', { reason: 'quality' })).status === 400)
  // decide accept(无取件)→ await_refund(非 refunded,零资金)
  const s0 = stockOf(); const sb0 = balOf('s1')
  const dec = await call('POST', `/api/return-requests/${retId}/decide`, 's1', { decision: 'accept', response: '好的' })
  ok('21. seller accept → await_refund (NOT escrow refund)', dec.status === 200 && dec.json.status === 'await_refund'
    && (db.prepare('SELECT status FROM return_requests WHERE id=?').get(retId) as { status: string }).status === 'await_refund')
  ok('22. accept moved no funds, no stock', stockOf() === s0 && balOf('s1') === sb0)
  ok('23. buyer notified await_refund', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='b1' AND title LIKE '%等待卖家场外退款%'").get() as { n: number }).n >= 1)
  // 在途握手挡重复申请
  ok('24. duplicate request blocked while handshake open', (await call('POST', `/api/orders/${o}/return-request`, 'b1', { reason: 'quality' })).status === 400)
  // escalate:await_refund 未超窗 → 拒
  ok('25. escalate await_refund before window → 400', (await call('POST', `/api/return-requests/${retId}/escalate`, 'b1', {})).status === 400)
  // mark-refunded:outsider 403;卖家 ok
  ok('26. mark-refunded outsider → 403', (await call('POST', `/api/return-requests/${retId}/mark-refunded`, 'outsider', {})).status === 403)
  const mk = await call('POST', `/api/return-requests/${retId}/mark-refunded`, 's1', { refund_reference: 'TXN-77' })
  ok('27. seller mark-refunded → refund_marked + buyer notified', mk.status === 200 && mk.json.status === 'refund_marked'
    && (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='b1' AND type='direct_pay_return_refund_marked'").get() as { n: number }).n === 1)
  // confirm:无 token 403;错 action token 403;对 token 200
  ok('28. confirm without token → 403', (await call('POST', `/api/return-requests/${retId}/confirm-refund`, 'b1', {})).status === 403)
  ok('29. confirm with wrong-action token → 403', (await call('POST', `/api/return-requests/${retId}/confirm-refund`, 'b1', { webauthn_token: JSON.stringify({ order_id: o, action: 'mark_paid' }) })).status === 403)
  const cf = await call('POST', `/api/return-requests/${retId}/confirm-refund`, 'b1', { webauthn_token: JSON.stringify({ order_id: o, action: 'return_refund_confirm' }) })
  ok('30. confirm with valid token → refunded + seller notified', cf.status === 200 && cf.json.status === 'refunded'
    && (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='s1' AND type='direct_pay_return_settled'").get() as { n: number }).n === 1)
  ok('31. order still completed after full return', (db.prepare('SELECT status FROM orders WHERE id=?').get(o) as { status: string }).status === 'completed')
  ok('32. seller-fault rep event recorded (claim_upheld_against)', (db.prepare("SELECT COUNT(*) n FROM reputation_events WHERE user_id='s1' AND event_type='claim_upheld_against' AND reason LIKE '%return=%'").get() as { n: number }).n >= 1)

  // escalate:refund_marked 随时可升级(声明≠到账)
  {
    const o3 = mkOrder('completed')
    const r3 = mkReturn(o3, 'refund_marked')
    const esc = await call('POST', `/api/return-requests/${r3}/escalate`, 'b1', {})
    ok('33. escalate from refund_marked → dispute created', esc.status === 200 && !!esc.json.dispute_id,
      JSON.stringify(esc.json))
  }
  // escalate:await_refund 超窗可升级
  {
    const o4 = mkOrder('completed')
    const r4 = mkReturn(o4, 'await_refund', { awaitSince: '2020-01-01 00:00:00' })
    ok('34. escalate from overdue await_refund → dispute created', (await call('POST', `/api/return-requests/${r4}/escalate`, 'b1', {})).status === 200)
  }
  // 取件流:accepted_pickup_pending → picked_up → received 走 await_refund(不触发 escrow 退款)
  {
    const o5 = mkOrder('completed')
    const rq5 = await call('POST', `/api/orders/${o5}/return-request`, 'b1', { reason: 'damaged', refund_amount: 50, pickup_requested: true, pickup_address: '新加坡某地 123 号' })
    const r5 = String(rq5.json.id)
    await call('POST', `/api/return-requests/${r5}/decide`, 's1', { decision: 'accept', response: '安排取件' })
    ok('35. accept with pickup → accepted_pickup_pending (unchanged logistics)', (db.prepare('SELECT status FROM return_requests WHERE id=?').get(r5) as { status: string }).status === 'accepted_pickup_pending')
    await call('POST', `/api/return-requests/${r5}/picked-up`, 'lg1', { evidence: 'SF123456' })
    const sb1 = balOf('s1')
    const rec = await call('POST', `/api/return-requests/${r5}/received`, 's1', {})
    ok('36. received on direct_p2p → await_refund (no wallet refund)', rec.status === 200 && rec.json.status === 'await_refund' && balOf('s1') === sb1)
  }
  // escrow 回归:accept(无取件)仍即时钱包退款 + 库存回补
  {
    const oe = mkOrder('completed', 'escrow')
    const rqe = await call('POST', `/api/orders/${oe}/return-request`, 'b1', { reason: 'quality', refund_amount: 50 })
    const re = String(rqe.json.id)
    const bb0 = balOf('b1'); const se0 = stockOf()
    const dece = await call('POST', `/api/return-requests/${re}/decide`, 's1', { decision: 'accept' })
    ok('37. ESCROW regression: accept → refunded + wallet moved + stock restored', dece.status === 200 && dece.json.status === 'refunded'
      && balOf('b1') === bb0 + 50 && stockOf() === se0 + 1, JSON.stringify({ dece: dece.json, bal: balOf('b1'), bb0, stock: stockOf(), se0 }))
  }
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ direct-pay-returns FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay returns (off-protocol refund handshake): request unblock + accept/received → await_refund + mark-refunded/confirm-refund (Passkey) + zero-funds/zero-restock + escalate windows + escrow regression\n  ✅ pass ${pass}`)
