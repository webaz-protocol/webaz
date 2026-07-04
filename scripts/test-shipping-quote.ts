#!/usr/bin/env tsx
/**
 * 询价握手(PR-3,直付轨)—— 建单分流(quote_ok 三态×轨道)+ 报价/确认端点 + 上限快照约束 + 总额/payable 重建。
 * Usage: npm run test:shipping-quote
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'shipq-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const ST = await import('../src/shipping-templates.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const { registerDirectPayPendingAcceptRoutes } = await import('../src/pwa/routes/direct-pay-pending-accept.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initOrderChainSchema(db); initNotificationSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('b1','b1','buyer','k_b1'),('outsider','o','buyer','k_o')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',30,10)").run()
db.prepare("UPDATE users SET store_shipping_template = ? WHERE id='s1'").run(JSON.stringify([{ region: 'SG', fee: 2 }]))

const resStub = (): { status: (n: number) => { json: (b: unknown) => void }; _code: number | null; _body: Record<string, unknown> | null } => {
  const r = { _code: null as number | null, _body: null as Record<string, unknown> | null, status(n: number) { r._code = n; return { json(b: unknown) { r._body = b as Record<string, unknown> } } } }
  return r as never
}

// ── ① 建单守门分流:quote_ok × 轨道 ──
{
  const r1 = resStub()
  ok('1. uncovered + quote OFF + dp → 409', ST.gateShippingForCreate(db, r1 as never, { shipping_template: null, shipping_quote_ok: null }, 's1', 'US', 'direct_p2p') === null && r1._code === 409)
  db.prepare("UPDATE users SET store_shipping_quote_ok = 1 WHERE id='s1'").run()
  const g2 = ST.gateShippingForCreate(db, resStub() as never, { shipping_template: null, shipping_quote_ok: null }, 's1', 'US', 'direct_p2p')
  ok('2. uncovered + store quote ON + dp → quoteRequired (fee 0, region kept)', !!g2 && g2.quoteRequired === true && g2.feeU === 0 && g2.region === 'US')
  const r3 = resStub()
  ok('3. uncovered + quote ON + ESCROW → still 409 (pay-after-accept not built)', ST.gateShippingForCreate(db, r3 as never, { shipping_template: null, shipping_quote_ok: null }, 's1', 'US', 'escrow') === null && r3._code === 409)
  const g4 = ST.gateShippingForCreate(db, resStub() as never, { shipping_template: null, shipping_quote_ok: null }, 's1', 'SG', 'direct_p2p')
  ok('4. covered region unaffected by quote flag (template fee, no quote)', !!g4 && g4.quoteRequired === false && g4.fee === 2)
  const g5 = ST.gateShippingForCreate(db, resStub() as never, { shipping_template: null, shipping_quote_ok: 0 }, 's1', 'US', 'direct_p2p')
  ok('5. product-level quote_ok=0 overrides store ON → 409 path', g5 === null)
}

// ── ② dp 建单:quoteRequired 强制 pending_accept(哪怕 auto)+ 标记列 ──
let n = 0; const generateId = (p: string): string => `${p}_${++n}`
const deps = { generateId, transition, appendOrderEvent }
const SNAP = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG'], perTxCapUnits: 50_000_000, sellerBreakerTripped: false, decisionCode: 'OK' }
function mkQuoteOrder(): string {
  const oid = createDirectPayOrder(db, deps as never, {
    productId: 'p', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 30, totalAmount: 30,
    instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600_000).toISOString(),
    shippingAddress: 'addr', accountSnapshot: { account_id: 'acc1', method: 'bank', currency: 'SGD', label: 'L', qr_ref: null, payable_usdc: 30 }, snapshot: SNAP,
    acceptMode: 'auto', pendingAcceptDeadlineIso: new Date(Date.now() + 24 * 3600_000).toISOString(),
    shipping: { region: 'US', fee: 0, estDays: null, quoteRequired: true },
  }).orderId
  return oid
}
const orderRow = (id: string): Record<string, unknown> => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>
{
  const oid = mkQuoteOrder()
  const o = orderRow(oid)
  ok('6. quote order lands pending_accept even with acceptMode=auto + flag col set', o.status === 'pending_accept' && Number(o.shipping_quote_required) === 1 && o.ship_to_region === 'US')
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(oid); db.prepare("UPDATE products SET stock=10 WHERE id='p'").run()
}

// ── ③ HTTP:quote / confirm-quote / 守卫矩阵 ──
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
  const oid = mkQuoteOrder()
  ok('7. plain accept on quote order → 409 QUOTE_REQUIRED (no fee bypass)', (await call('POST', `/api/orders/${oid}/pending-accept/accept`, 's1')).status === 409)
  ok('8. buyer cannot quote (403)', (await call('POST', `/api/orders/${oid}/pending-accept/quote`, 'b1', { shipping_fee: 5 })).status === 403)
  ok('9. confirm before quote → 409 QUOTE_NOT_SUBMITTED', (await call('POST', `/api/orders/${oid}/pending-accept/confirm-quote`, 'b1')).status === 409)
  ok('10. quote exceeding per-tx cap snapshot → 409 QUOTE_EXCEEDS_CAP (30 + 25 > 50)', (await call('POST', `/api/orders/${oid}/pending-accept/quote`, 's1', { shipping_fee: 25 })).status === 409)
  ok('11. bad fee rejected', (await call('POST', `/api/orders/${oid}/pending-accept/quote`, 's1', { shipping_fee: -1 })).status === 400)
  const dl0 = String(orderRow(oid).pending_accept_deadline)
  const q = await call('POST', `/api/orders/${oid}/pending-accept/quote`, 's1', { shipping_fee: 8.005, est_days: '10-15', note: 'EMS 转运' })
  ok('12. quote ok: fee rounded, new_total, deadline reset, buyer notified', q.status === 200 && q.json.shipping_quote_fee === 8.01 && q.json.new_total === 38.01
    && String(orderRow(oid).pending_accept_deadline) > dl0
    && (db.prepare("SELECT COUNT(*) c FROM notifications WHERE order_id=? AND user_id='b1' AND type='direct_pay_quote_submitted'").get(oid) as { c: number }).c === 1)
  ok('13. re-quote allowed before confirm (correction)', (await call('POST', `/api/orders/${oid}/pending-accept/quote`, 's1', { shipping_fee: 6, est_days: '8-12' })).status === 200)
  ok('14. seller cannot confirm quote (403)', (await call('POST', `/api/orders/${oid}/pending-accept/confirm-quote`, 's1')).status === 403)
  const c = await call('POST', `/api/orders/${oid}/pending-accept/confirm-quote`, 'b1')
  const o = orderRow(oid)
  const snap = JSON.parse(String(o.direct_pay_account_snapshot))
  ok('15. confirm: total 30→36, shipping cols snapshotted, → direct_pay_window + window deadline', c.status === 200 && Number(o.total_amount) === 36
    && Number(o.shipping_fee) === 6 && o.shipping_est_days === '8-12' && o.status === 'direct_pay_window' && !!o.direct_pay_window_deadline)
  ok('16. payable snapshot rebuilt at NEW total', snap.payable_usdc === 36)
  ok('17. seller notified of confirmation', (db.prepare("SELECT COUNT(*) c FROM notifications WHERE order_id=? AND user_id='s1' AND type='direct_pay_quote_confirmed'").get(oid) as { c: number }).c === 1)
  ok('18. double confirm rejected (order no longer pending_accept)', (await call('POST', `/api/orders/${oid}/pending-accept/confirm-quote`, 'b1')).status === 409)
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(oid); db.prepare("UPDATE products SET stock=10 WHERE id='p'").run()
  // 买家不接受报价 → 既有 /cancel(无责+回补)
  {
    const s0 = (db.prepare("SELECT stock s FROM products WHERE id='p'").get() as { s: number }).s
    const o2 = mkQuoteOrder()
    await call('POST', `/api/orders/${o2}/pending-accept/quote`, 's1', { shipping_fee: 6 })
    const r = await call('POST', `/api/orders/${o2}/pending-accept/cancel`, 'b1')
    ok('19. buyer declines quote via cancel → no-fault cancelled + restock', r.status === 200 && orderRow(o2).status === 'cancelled'
      && (db.prepare("SELECT stock s FROM products WHERE id='p'").get() as { s: number }).s === s0)
  }
  // quote on non-quote order → 409
  {
    const o3 = createDirectPayOrder(db, deps as never, {
      productId: 'p', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 30, totalAmount: 32,
      instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600_000).toISOString(),
      shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP, acceptMode: 'manual',
      pendingAcceptDeadlineIso: new Date(Date.now() + 24 * 3600_000).toISOString(),
      shipping: { region: 'SG', fee: 2, estDays: null, quoteRequired: false },
    }).orderId
    ok('20. quote on covered/manual order → 409 NOT_QUOTE_ORDER (plain accept still works)', (await call('POST', `/api/orders/${o3}/pending-accept/quote`, 's1', { shipping_fee: 5 })).status === 409
      && (await call('POST', `/api/orders/${o3}/pending-accept/accept`, 's1')).status === 200)
  }
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ shipping-quote FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ shipping quote handshake (PR-3): gate fork (quote_ok × rail) + forced pending_accept + quote/confirm endpoints + cap-snapshot bound + total/payable rebuild + decline paths\n  ✅ pass ${pass}`)
