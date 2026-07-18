#!/usr/bin/env tsx
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerDisputeCasesRoutes } from '../src/pwa/routes/dispute-cases.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => { if (condition) pass++; else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`), fail++ }
const db = new Database(':memory:')
db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, category TEXT);
  CREATE TABLE dispute_cases (id TEXT PRIMARY KEY, product_id TEXT, seller_id TEXT, buyer_id TEXT, category_tag TEXT, winner TEXT, resolution TEXT, amount_bucket TEXT, buyer_argument TEXT, seller_argument TEXT, ruling_text TEXT, fairness_yes INTEGER, fairness_no INTEGER, comment_count INTEGER, published_at TEXT);`)
db.prepare(`INSERT INTO products VALUES ('p-a','Tea set','retail'),('p-b','Lamp','retail')`).run()
const put = db.prepare(`INSERT INTO dispute_cases VALUES (@id,@product_id,@seller_id,@buyer_id,@category_tag,@winner,@resolution,'0-50','PRIVATE BUYER','PRIVATE SELLER','PRIVATE RULING',0,0,0,datetime('now'))`)
put.run({ id: 'a-win', product_id: 'p-a', seller_id: 'seller-a', buyer_id: 'buyer-a', category_tag: 'quality', winner: 'seller', resolution: 'release' })
put.run({ id: 'a-loss', product_id: 'p-a', seller_id: 'seller-a', buyer_id: 'buyer-b', category_tag: 'shipping', winner: 'buyer', resolution: 'refund' })
put.run({ id: 'a-split', product_id: 'p-a', seller_id: 'seller-a', buyer_id: 'buyer-c', category_tag: 'quality', winner: 'split', resolution: 'partial' })
put.run({ id: 'b-win', product_id: 'p-b', seller_id: 'seller-b', buyer_id: 'buyer-d', category_tag: 'quality', winner: 'seller', resolution: 'release' })
setSeamDb(db)

let server: Server, port = 0
const get = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path }, res => { let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(body) })) })
  req.on('error', reject); req.end()
})

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerDisputeCasesRoutes(app, { db, auth: () => null, getUser: () => null, generateId: p => `${p}_x`, piiSanitize: s => s, detectFraud: () => [], commentBlocklistHit: () => null, llmModerateComment: async () => ({ ok: true }) })
  server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { port = Number((server.address() as { port: number }).port); resolve() }))
  const r = await get('/api/disputes/cases?seller_id=seller-a&limit=50')
  const items = r.json.items || []
  ok('seller filter returns only the requested seller rows', r.status === 200 && items.length === 3 && items.every((item: any) => item.id.startsWith('a-')), JSON.stringify(items))
  ok('summary preserves wins, losses, and split separately', r.json.summary?.total === 3 && r.json.summary?.seller_wins === 1 && r.json.summary?.seller_losses === 1 && r.json.summary?.split === 1, JSON.stringify(r.json.summary))
  ok('category counts use the same seller filter', (r.json.category_counts || []).reduce((sum: number, row: any) => sum + Number(row.n || 0), 0) === 3, JSON.stringify(r.json.category_counts))
  const sellerCategory = await get('/api/disputes/cases?seller_id=seller-a&category=quality&limit=50')
  ok('seller category counts remain seller-scoped without hiding its other filter choices', (sellerCategory.json.category_counts || []).reduce((sum: number, row: any) => sum + Number(row.n || 0), 0) === 3, JSON.stringify(sellerCategory.json.category_counts))
  const publicCategory = await get('/api/disputes/cases?category=quality&limit=50')
  ok('global category counts retain the prior all-category filter behavior', (publicCategory.json.category_counts || []).reduce((sum: number, row: any) => sum + Number(row.n || 0), 0) === 4, JSON.stringify(publicCategory.json.category_counts))
  ok('public listing never returns private parties or case text', items.every((item: any) => !('seller_id' in item) && !('buyer_id' in item) && !('buyer_argument' in item) && !('seller_argument' in item) && !('ruling_text' in item)), JSON.stringify(items[0]))
  server.close()

  const product = readFileSync('src/pwa/public/app-product-presentation.js', 'utf8')
  const shop = readFileSync('src/pwa/public/app-shop.js', 'utf8')
  const rulings = readFileSync('src/pwa/public/app-shop-rulings.js', 'utf8')
  const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('product chip delegates to the public-rulings projection', /publicSellerRulingsHtml/.test(product) && !/tab=disputes/.test(product))
  ok('legacy disputes tab aliases to the public rulings tab', /requestedTab === 'rulings' \|\| requestedTab === 'disputes'/.test(shop))
  ok('shop page hydrates a dedicated public-rulings panel', /shop-rulings-content/.test(shop) && /hydrateShopRulings/.test(shop))
  ok('shop companion queries seller-filtered public cases', /disputes\/cases\?seller_id=/.test(rulings))
  for (const key of ['公开裁决', '部分责任', '仅展示已公开、已脱敏的终局裁决']) ok(`i18n EN exists: ${key}`, new RegExp(`'${key}'\\s*:`).test(i18n))
  if (fail) { console.error(`\n❌ public seller rulings failed\n${failures.join('\n')}`); process.exit(1) }
  console.log(`\n✅ public seller rulings: seller-filtered, redacted final cases + accurate three-outcome summary\n  ✅ pass ${pass}`)
}
main().catch(error => { console.error(error); process.exit(1) })
