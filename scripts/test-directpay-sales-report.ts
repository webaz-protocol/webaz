#!/usr/bin/env tsx
/**
 * 卖家直接收款(direct_p2p)销售统计 + 对账 + 逐单平台费明细(只读)。GET /api/sellers/me/direct-pay-report。
 *   聚合仅 payment_rail='direct_p2p' 的订单(托管 escrow 与他人订单排除);逐单 LEFT JOIN direct_pay_fee_receivables 出平台费明细;
 *   汇总(销售额/各状态桶/区间已计提平台费)+ 按月 + 日期区间筛选;非卖家 403。无钱路、无 schema 变更。
 * Usage: npm run test:directpay-sales-report
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dpsr-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerSellerDirectPayReportRoutes } = await import('../src/pwa/routes/seller-directpay-report.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('b1','b1','buyer','k_b1'),('other','other','seller','k_other')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',10,99)").run()
let oc = 0
const mkOrder = (rail: string, status: string, total: number, createdAt: string, seller = 's1'): string => {
  const id = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail,created_at,ship_to_region) VALUES (?, 'p','b1',?,1,?,?,0,?,?,?, 'SG')").run(id, seller, total, total, status, rail, createdAt)
  return id
}
const mkFee = (orderId: string, amount: number, seller = 's1'): void => {
  db.prepare("INSERT INTO direct_pay_fee_receivables (id,order_id,seller_id,amount,currency,accrued_at) VALUES (?,?,?,?, 'usdc', ?)").run('r_' + orderId, orderId, seller, amount, '2026-03-21 00:00:00')
}
const o1 = mkOrder('direct_p2p', 'completed', 100, '2026-03-15 10:00:00'); mkFee(o1, 0.5)
const o2 = mkOrder('direct_p2p', 'confirmed', 200, '2026-03-20 10:00:00'); mkFee(o2, 1.0)
mkOrder('direct_p2p', 'accepted', 50, '2026-04-01 10:00:00')   // 在途,无 fee
mkOrder('direct_p2p', 'cancelled', 30, '2026-04-05 10:00:00')  // 已关闭,无 fee
mkOrder('escrow', 'completed', 999, '2026-03-16 10:00:00')     // 托管:必须排除
mkOrder('direct_p2p', 'completed', 500, '2026-03-18 10:00:00', 'other')  // 他人:必须排除

const app = express(); app.use(express.json())
registerSellerDirectPayReportRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } const u = db.prepare('SELECT role FROM users WHERE id=?').get(uid) as { role: string } | undefined; return { id: uid, role: u?.role || 'buyer' } },
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const get = (path: string, uid = 's1'): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api' + path, headers: { 'x-test-uid': uid } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode || 0, json: (() => { try { return JSON.parse(d) } catch { return {} } })() })) })
  rq.on('error', reject); rq.end()
})

try {
  const r = (await get('/sellers/me/direct-pay-report')).json as { summary: Record<string, number>; by_month: { month: string; order_count: number }[]; orders: { id: string; fee_amount: number | null; status: string }[] }
  const s = r.summary
  ok('1. order_count = 4 direct_p2p (escrow + other seller excluded)', s.order_count === 4)
  ok('2. sales_total = 380 (100+200+50+30; escrow 999 & other 500 excluded)', s.sales_total === 380)
  ok('3. completed: count 2, sales 300', s.completed_count === 2 && s.completed_sales === 300)
  ok('4. in_flight_count = 1 (accepted)', s.in_flight_count === 1)
  ok('5. closed_count = 1 (cancelled)', s.closed_count === 1)
  ok('6. fee_accrued_total = 1.5 over 2 fee rows', Math.abs(s.fee_accrued_total - 1.5) < 1e-9 && s.fee_order_count === 2)
  // 逐单明细:完成单有 fee,在途单 fee 为 null
  const byId = Object.fromEntries(r.orders.map(o => [o.id, o]))
  ok('7. per-order fee 明细: completed order has fee', byId[o1] && Math.abs((byId[o1].fee_amount as number) - 0.5) < 1e-9)
  ok('8. in-flight order fee null (未完成尚未计提)', r.orders.some(o => o.status === 'accepted' && o.fee_amount === null))
  ok('9. by_month has 2026-03 (2) and 2026-04 (2)', r.by_month.find(m => m.month === '2026-03')?.order_count === 2 && r.by_month.find(m => m.month === '2026-04')?.order_count === 2)

  // 日期区间
  const mar = (await get('/sellers/me/direct-pay-report?from=2026-03-01&to=2026-03-31')).json as { summary: Record<string, number> }
  ok('10. range 2026-03 → 2 orders, sales 300', mar.summary.order_count === 2 && mar.summary.sales_total === 300)

  // 授权 / 范围
  ok('11. non-seller → 403', (await get('/sellers/me/direct-pay-report', 'b1')).status === 403)
  const oth = (await get('/sellers/me/direct-pay-report', 'other')).json as { summary: Record<string, number> }
  ok('12. other seller sees only own (1 order, 500)', oth.summary.order_count === 1 && oth.summary.sales_total === 500)
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ directpay-sales-report FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay sales report (read-only): direct_p2p-scoped aggregation (escrow/other excluded) + status buckets + range-accrued platform fee + by-month + per-order fee 明细 (LEFT JOIN receivables) + date range + seller-only\n  ✅ pass ${pass}`)
