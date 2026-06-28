#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 反作弊生命周期(PR-⑥):商品【重大编辑】后,其逐品验证被作废,硬门重新拦截。
 * 经【真实 PUT /api/products/:id 路由】验证(非桩):
 *   - 验证通过的商品,编辑标题/价格/详情 → product verification → stale,productStoreVerified=false。
 *   - 非重大编辑(仅库存)→ 验证保持 verified。
 * Usage: npm run test:product-verification-reverify
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'pv-reverify-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerProductsUpdateRoutes } = await import('../src/pwa/routes/products-update.js')
const { productStoreVerified, getProductVerification } = await import('../src/product-verification.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); setSeamDb(db)
db.pragma('foreign_keys = OFF')
// products-update writes columns added by runtime ALTER migrations (not in base initDatabase); add them here.
for (const col of ['specs TEXT', 'brand TEXT', 'model TEXT', 'handling_hours INTEGER', 'ship_regions TEXT', 'estimated_days TEXT', 'fragile INTEGER', 'return_days INTEGER', 'return_condition TEXT', 'warranty_days INTEGER', 'low_stock_threshold INTEGER', 'auto_delist_on_zero INTEGER', 'low_stock_alerted_at TEXT', 'origin_claims TEXT', 'i18n_titles TEXT', 'i18n_descs TEXT', 'commitment_hash TEXT', 'description_hash TEXT', 'price_hash TEXT', 'hashed_at TEXT']) {
  try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`) } catch { /* already exists */ }
}
const seedVerified = (pid: string) => db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES (?,?,?,?, 'verified','admin1',datetime('now'))").run('pvf_' + pid, pid, 'seller1', 'wzv_' + pid)
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p1','seller1','Orig','d1',50,10,'active')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('p2','seller1','Orig2','d2',50,10,'active')").run()
seedVerified('p1'); seedVerified('p2')

const app = express(); app.use(express.json())
registerProductsUpdateRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'seller' } },
  makeCommitmentHash: () => 'c', makeDescriptionHash: () => 'd', makePriceHash: () => 'p',
  notifyWaitlist: () => {}, notifyWishlistPriceDrop: () => {}, checkStockAndMaybeDelist: () => {},
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
function req(method: string, path: string, body: Record<string, unknown> | null, h: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...h }
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
    rq.on('error', reject); if (payload) rq.write(payload); rq.end()
  })
}

ok('precondition: p1 + p2 verified', productStoreVerified(db, 'p1') && productStoreVerified(db, 'p2'))
// 重大编辑:改标题 → 作废
const e1 = await req('PUT', '/api/products/p1', { title: 'CHANGED INTO ANOTHER PRODUCT' }, { 'x-uid': 'seller1' })
ok('edit succeeds', e1.status === 200 && e1.json?.success === true, JSON.stringify(e1.json))
ok('material edit (title) → verification invalidated → productStoreVerified=false', productStoreVerified(db, 'p1') === false)
ok('p1 verification status now stale', getProductVerification(db, 'p1')?.status === 'stale')
// 非重大编辑:仅改库存 → 验证保持
const e2 = await req('PUT', '/api/products/p2', { stock: 7 }, { 'x-uid': 'seller1' })
ok('stock-only edit succeeds', e2.status === 200)
ok('non-material edit (stock only) → verification stays verified', productStoreVerified(db, 'p2') === true)
// 改价格 → 作废
const e3 = await req('PUT', '/api/products/p2', { price: 999 }, { 'x-uid': 'seller1' })
ok('price edit → verification invalidated', e3.status === 200 && productStoreVerified(db, 'p2') === false)

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} product-verification-reverify tests passed`)
