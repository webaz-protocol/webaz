#!/usr/bin/env tsx
/**
 * 订单按支付轨(类型)筛选 + 导出分轨(对账基础)。GET /api/orders?rail= 与 /api/orders/export?rail=,
 * 加 CSV 的 payment_rail 列。只读、无钱路、无 schema 变更。
 *   1. 无 rail → 两轨都在;2. rail=direct_p2p → 仅直付;3. rail=escrow → 仅托管;4. 非法 rail → 忽略(=无筛选)。
 *   5. 参与方 OR 括号正确(不会因 AND 优先级把别人的单漏出)。6. 导出含 payment_rail 列 + rail 筛选生效。
 * Usage: npm run test:orders-rail-filter
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'ord-rail-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { getOrderStatus } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { registerOrdersReadRoutes } = await import('../src/pwa/routes/orders-read.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db)   // bridge 给 users.handle 等
// 导出路由读的这些 orders 列在 server.ts 迁移段(非 base/helpers)—— 裸 init 补齐
for (const c of ['coupon_discount REAL DEFAULT 0', 'variant_options_snapshot TEXT']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* 已有 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('b1','b1','buyer','k_b1'),('other','other','buyer','k_other')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,images) VALUES ('p','s1','P','d',50,9,'[]')").run()
let oc = 0
const mkOrder = (rail: string, seller = 's1', buyer = 'b1'): string => {
  const id = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p',?,?,1,50,50,0,'completed',?)").run(id, buyer, seller, rail)
  return id
}
mkOrder('escrow'); mkOrder('escrow'); mkOrder('direct_p2p'); mkOrder('direct_p2p'); mkOrder('direct_p2p')
mkOrder('direct_p2p', 'other', 'other')   // 别人的单:s1 不应看到

const app = express(); app.use(express.json())
registerOrdersReadRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'seller', api_key: 'k_' + uid } },
  getOrderStatus, getOrderChain: () => ({}), verifyOrderChain: () => ({}), getOrderDispute: () => null,
} as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const get = (path: string, uid = 's1'): Promise<{ status: number; body: string; json: unknown }> => new Promise((resolve, reject) => {
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api' + path, headers: { 'x-test-uid': uid } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode || 0, body: d, json: (() => { try { return JSON.parse(d) } catch { return null } })() })) })
  rq.on('error', reject); rq.end()
})

try {
  // ── 列表筛选 ──
  const all = (await get('/orders')).json as { id: string; payment_rail: string }[]
  ok('1a. no rail → both rails present', all.some(o => o.payment_rail === 'escrow') && all.some(o => o.payment_rail === 'direct_p2p'))
  ok('1b. no rail → excludes other seller order (party-scoped)', all.every(o => o.id !== 'o_6'))
  const dp = (await get('/orders?rail=direct_p2p')).json as { payment_rail: string }[]
  ok('2. rail=direct_p2p → only direct_p2p', dp.length === 3 && dp.every(o => o.payment_rail === 'direct_p2p'))
  const es = (await get('/orders?rail=escrow')).json as { payment_rail: string }[]
  ok('3. rail=escrow → only escrow', es.length === 2 && es.every(o => o.payment_rail === 'escrow'))
  const bad = (await get('/orders?rail=nonsense')).json as unknown[]
  ok('4. invalid rail ignored (= no filter, party-scoped 5)', bad.length === 5)
  // 括号正确性:即便有 rail 也绝不漏别人的单
  const dpOther = (await get('/orders?rail=direct_p2p', 'other')).json as { id: string }[]
  ok('5. other seller sees only own direct_p2p (OR parenthesized correctly)', dpOther.length === 1 && dpOther[0].id === 'o_6')

  // ── 导出 ──
  const expAll = (await get('/orders/export?role=seller')).body
  const header = expAll.replace(/^﻿/, '').split('\n')[0]
  ok('6a. export CSV has payment_rail column', header.split(',').includes('payment_rail'))
  ok('6b. export (no rail) includes both rails', /,escrow,/.test(expAll) && /,direct_p2p,/.test(expAll))
  const expDp = (await get('/orders/export?role=seller&rail=direct_p2p')).body
  const dpRows = expDp.replace(/^﻿/, '').trim().split('\n').slice(1)
  ok('6c. export rail=direct_p2p → only direct_p2p rows', dpRows.length === 3 && dpRows.every(r => r.includes(',direct_p2p,')))
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ orders-rail-filter FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ orders rail filter + export: list ?rail= (escrow/direct_p2p, invalid ignored, party-scoped, OR parenthesized) + CSV payment_rail column + rail-scoped export\n  ✅ pass ${pass}`)
