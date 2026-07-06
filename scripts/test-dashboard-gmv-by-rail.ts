#!/usr/bin/env tsx
/**
 * 卖家仪表盘 GMV 按支付轨拆分(诚实口径:托管=平台托管收入 / 直接收款=场外收款,平台不经手,不混算)。
 *   两处:GET /api/sellers/me/analytics(SQL CASE 拆)+ GET /api/seller/insights(JS 拆)。只读,无 schema/钱路变更。
 *   + 共用小注模块 app-gmv-rail-split.js 行为(无直付→不显示;有直付→托管/直接收款分列)。
 * Usage: npm run test:dashboard-gmv-by-rail
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'gmvrail-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAnalyticsRoutes } = await import('../src/pwa/routes/analytics.js')
const { registerSellerQuotaRoutes } = await import('../src/pwa/routes/seller-quota.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('b1','b1','buyer','k_b1')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',10,99)").run()
let oc = 0
const mk = (rail: string, status: string, total: number): void => {
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail,created_at) VALUES (?, 'p','b1','s1',1,?,?,0,?,?, datetime('now'))").run(`o_${++oc}`, total, total, status, rail)
}
mk('escrow', 'completed', 100); mk('escrow', 'confirmed', 50)   // 托管完成 = 150
mk('direct_p2p', 'completed', 200)                              // 直接收款完成 = 200
mk('direct_p2p', 'cancelled', 30)                              // 取消:不计
mk('escrow', 'paid', 999)                                     // 在途:不计
// 总 GMV(完成)= 350

const app = express(); app.use(express.json())
const auth = (req: Request, res: Response) => { const u = req.headers['x-test-uid'] as string | undefined; if (!u) { res.status(401).json({ error: 'login' }); return null } return { id: u, role: 'seller' } }
registerAnalyticsRoutes(app, { db, auth } as never)
registerSellerQuotaRoutes(app, { db, auth, generateId: (p: string) => p + '_x', requireUsersAdmin: () => null, safeRoles: () => ['seller'], checkSellerCanList: () => ({ ok: true }), adminCanOperateOn: () => true, logAdminAction: () => {}, QUOTA_TIERS: [200, 500, 1000] } as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const get = (path: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api' + path, headers: { 'x-test-uid': 's1' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve((() => { try { return JSON.parse(d) } catch { return {} } })())) })
  rq.on('error', reject); rq.end()
})

try {
  // ── analytics (SQL CASE 拆)—— analytics 既有口径只算 status='completed'(不含 confirmed);拆分沿用同口径 ──
  const a = (await get('/sellers/me/analytics?window=30')).orders as Record<string, number>
  ok('1. analytics total gmv = 300 (completed-only: escrow 100 + direct 200)', Number(a.gmv) === 300)
  ok('2. analytics gmv_escrow = 100 (托管 completed)', Number(a.gmv_escrow) === 100)
  ok('3. analytics gmv_direct_pay = 200 (直接收款 completed)', Number(a.gmv_direct_pay) === 200)
  ok('4. analytics split sums to total (no conflation lost)', Number(a.gmv_escrow) + Number(a.gmv_direct_pay) === Number(a.gmv))

  // ── insights (JS 拆) ──
  const s = (await get('/seller/insights')).summary as Record<string, number>
  ok('5. insights gmv = 350', Number(s.gmv) === 350)
  ok('6. insights gmv_escrow = 150', Number(s.gmv_escrow) === 150)
  ok('7. insights gmv_direct_pay = 200', Number(s.gmv_direct_pay) === 200)

  // ── 共用小注模块行为 ──
  const g = globalThis as unknown as { window: unknown; t: (x: string) => string }
  g.t = (x: string) => x; g.window = g
  ;(0, eval)(readFileSync('src/pwa/public/app-gmv-rail-split.js', 'utf8'))
  const split = (g.window as { gmvRailSplitHtml: (e: number, d: number, f?: (n: number) => string) => string }).gmvRailSplitHtml
  ok('8. no direct-pay → renders nothing (pure-escrow seller not cluttered)', split(150, 0) === '')
  const html = split(150, 200)
  ok('9. has direct-pay → shows both 托管 150 and 直接收款 200', /托管/.test(html) && /直接收款/.test(html) && html.includes('150') && html.includes('200'))
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ dashboard-gmv-by-rail FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ dashboard GMV split by rail: analytics (SQL) + insights (JS) both report gmv_escrow vs gmv_direct_pay (sum to total, completed-only) + shared split chip (hidden when no direct-pay)\n  ✅ pass ${pass}`)
