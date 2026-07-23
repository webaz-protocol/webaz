#!/usr/bin/env tsx
import express from 'express'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  publicCommerceSqlFilter,
  PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_MAX,
  readPublicCommerceAllowedProductIds,
} from '../src/public-commerce-policy.js'

let pass = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => {
  if (condition) pass++
  else failures.push(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}
const payloadOf = (result: Record<string, unknown>): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>
const productIdsOf = (result: Record<string, unknown>): string[] =>
  ((result.products ?? []) as Array<Record<string, unknown>>).map(product => String(product.id ?? ''))

const ids = {
  live: 'prd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  digital: 'prd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  paused: 'prd_cccccccccccccccccccccccccccccccc',
  out: 'prd_dddddddddddddddddddddddddddddddd',
  revoked: 'prd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  unreviewed: 'prd_ffffffffffffffffffffffffffffffff',
  lamps: [
    'prd_11111111111111111111111111111111',
    'prd_22222222222222222222222222222222',
    'prd_33333333333333333333333333333333',
    'prd_44444444444444444444444444444444',
    'prd_55555555555555555555555555555555',
    'prd_66666666666666666666666666666666',
  ],
}

delete process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS
ok('missing allowlist is fail-closed', readPublicCommerceAllowedProductIds().length === 0)
ok('malformed allowlist is fail-closed', readPublicCommerceAllowedProductIds('["broken"').length === 0)
ok('invalid member invalidates the whole allowlist',
  readPublicCommerceAllowedProductIds(`${ids.live},not-a-product`).length === 0)
ok('empty CSV member invalidates the whole allowlist',
  [
    `${ids.live},`,
    `,${ids.live}`,
    `${ids.live},,${ids.revoked}`,
  ].every(value => readPublicCommerceAllowedProductIds(value).length === 0))
const oversizedAllowlist = Array.from(
  { length: PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_MAX + 1 },
  (_, index) => `prd_${String(index).padStart(8, '0')}`,
)
ok('oversized allowlist is fail-closed',
  readPublicCommerceAllowedProductIds(oversizedAllowlist.join(',')).length === 0)
process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS =
  [ids.live, ids.digital, ids.paused, ids.out, ids.revoked].join(',')

const oldHome = process.env.HOME
const oldUserProfile = process.env.USERPROFILE
const oldMode = process.env.WEBAZ_MODE
const oldApiUrl = process.env.WEBAZ_API_URL
const testHome = mkdtempSync(join(tmpdir(), 'webaz-openai-shopping-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { initMcpResultCacheSchema, initUserModerationSchema } =
  await import('../src/runtime/webaz-schema-helpers.js')
const { registerProductsListRoutes } = await import('../src/pwa/routes/products-list.js')
const { registerSearchRoutes } = await import('../src/pwa/routes/search.js')

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
initUserModerationSchema(db)
applyWebazRuntimeSchema(db)
initMcpResultCacheSchema(db)
for (const column of ['listing_paused INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${column}`) } catch { /* existing runtime column */ }
}
for (const column of [
  'product_type TEXT',
  'category_id TEXT',
  'claim_loss_count INTEGER DEFAULT 0',
  'return_days INTEGER DEFAULT 0',
  'warranty_days INTEGER DEFAULT 0',
  'handling_hours INTEGER DEFAULT 0',
  'specs TEXT',
]) {
  try { db.exec(`ALTER TABLE products ADD COLUMN ${column}`) } catch { /* existing runtime column */ }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS product_categories (id TEXT PRIMARY KEY, seasonal_months TEXT);
  CREATE TABLE IF NOT EXISTS order_ratings (id TEXT, product_id TEXT, buyer_id TEXT, stars INTEGER);
  CREATE TABLE IF NOT EXISTS dispute_cases (id TEXT, seller_id TEXT, winner TEXT);
  CREATE TABLE IF NOT EXISTS product_trial_campaigns (
    id TEXT, product_id TEXT, status TEXT, quota_total INTEGER, quota_claimed INTEGER
  );
  CREATE TABLE IF NOT EXISTS product_external_links (
    id TEXT, product_id TEXT, external_title TEXT, verified INTEGER, revoked INTEGER
  );
  CREATE TABLE IF NOT EXISTS user_blocklist (blocker_id TEXT, blocked_id TEXT);
`)
for (const column of ['verified INTEGER', 'revoked INTEGER']) {
  try { db.exec(`ALTER TABLE product_external_links ADD COLUMN ${column}`) } catch { /* existing runtime column */ }
}

db.prepare("INSERT INTO users (id,name,role,api_key,listing_paused) VALUES ('seller-live','Live','seller','k_live',0)").run()
db.prepare("INSERT INTO users (id,name,role,api_key,listing_paused) VALUES ('seller-paused','Paused','seller','k_paused',1)").run()
const insertProduct = db.prepare(`
  INSERT INTO products (
    id,seller_id,title,description,price,currency,stock,category,status,
    return_days,warranty_days,handling_hours,product_type,specs
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`)
const addProduct = (
  id: string,
  sellerId: string,
  title: string,
  productType: string,
  stock: number,
): void => {
  insertProduct.run(
    id, sellerId, title, `${title} description`, 20, 'USDC', stock,
    'phone_stand', 'active', 7, 90, 24, productType, JSON.stringify({ material: 'metal' }),
  )
}
addProduct(ids.live, 'seller-live', 'Reviewed Phone Stand', 'retail', 5)
addProduct(ids.digital, 'seller-live', 'Digital Phone Stand Guide', 'digital', 5)
addProduct(ids.paused, 'seller-paused', 'Paused Phone Stand', 'retail', 5)
addProduct(ids.out, 'seller-live', 'Out Phone Stand', 'retail', 0)
addProduct(ids.revoked, 'seller-live', 'Revoked Phone Stand', 'retail', 5)
addProduct(ids.unreviewed, 'seller-live', 'Unreviewed Phone Stand', 'retail', 5)

const externalLinkColumns = db.prepare('PRAGMA table_info(product_external_links)').all() as
  Array<{ name: string; notnull: number; dflt_value: unknown }>
const externalLinkExtras = externalLinkColumns
  .filter(column =>
    column.notnull === 1
    && column.dflt_value == null
    && !['id', 'product_id', 'verified', 'revoked'].includes(column.name))
  .map(column => column.name)
db.prepare(`
  INSERT INTO product_external_links (
    id, product_id, verified, revoked${externalLinkExtras.map(name => `, ${name}`).join('')}
  ) VALUES ('pel_revoked', ?, 0, 1${externalLinkExtras.map(() => ", 'test'").join('')})
`).run(ids.revoked)

const policy = publicCommerceSqlFilter('p')
const eligible = db.prepare(`
  SELECT p.id FROM products p JOIN users u ON u.id = p.seller_id
  WHERE p.status = 'active' AND p.stock > 0
    AND COALESCE(u.listing_paused, 0) = 0
    AND NOT (
      EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.revoked = 1)
      AND NOT EXISTS (
        SELECT 1 FROM product_external_links pel
        WHERE pel.product_id = p.id AND pel.verified = 1
          AND (pel.revoked IS NULL OR pel.revoked = 0)
      )
    )
    AND ${policy.clause}
  ORDER BY p.id
`).all(...policy.params) as Array<{ id: string }>
ok('policy matrix allows only reviewed live physical goods',
  JSON.stringify(eligible.map(row => row.id)) === JSON.stringify([ids.live]))
ids.lamps.forEach((id, index) =>
  addProduct(id, 'seller-live', `Reviewed Desk Lamp ${index + 1}`, 'retail', 5))
process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS =
  [ids.live, ids.digital, ids.paused, ids.out, ids.revoked, ...ids.lamps].join(',')

const app = express()
app.use(express.json())
registerProductsListRoutes(app, {
  db,
  getUser: () => null,
  VALID_PRODUCT_TYPES: new Set(['retail', 'wholesale', 'service', 'digital']),
  RAW_MODE_MIN_TRUST: 30,
  getAgentTrustCached: () => null,
  VALID_SORTS: new Set([
    'trending', 'newest', 'rating', 'price_asc', 'price_desc',
    'random', 'recommended', 'seller_win_rate',
  ]),
  PRODUCT_LIMITS: { pwa: 30, agent: 200, raw: 500 },
  TRENDING_SCORE_EXPR: 'p.price',
  findProductsByAlias: (input: string) => {
    if (input === 'mixed-handle') return new Set([ids.live, ids.unreviewed])
    const matches = db.prepare(`
      SELECT id FROM products WHERE (id = ? OR title = ?) AND status = 'active'
    `).all(input, input) as Array<{ id: string }>
    return new Set(matches.map(match => match.id))
  },
  decodeProductCursor: (cursor: string) => {
    try {
      const [score, id] = Buffer.from(cursor, 'base64url').toString().split(':')
      return { score: Number(score), id }
    } catch { return null }
  },
  encodeProductCursor: (score: number, id: string) =>
    Buffer.from(`${score}:${id}`).toString('base64url'),
  MASTER_SEED: 'test-seed',
  formatProductForAgent: (product: Record<string, unknown>) => ({
    ...product,
    agent_summary: `${product.title}`,
  }),
})
const allProducts = db.prepare('SELECT * FROM products ORDER BY id').all() as Array<Record<string, unknown>>
registerSearchRoutes(app, {
  db,
  auth: (_req, res) => { res.status(401).json({ error: 'unauthorized' }); return null },
  applyCouponToOrder: () => ({ ok: false }),
  extractUrlFromText: () => null,
  extractTitleFromText: text => text,
  parsePlatformUrl: () => null,
  searchByExternalLink: ({ external_title }) => ({
    matched_by: 'product_title_exact',
    products: allProducts.filter(product => String(product.title) === String(external_title)),
  }),
  detectShareCommandFormat: () => null,
  formatProductForAgent: product => product,
})
app.get('/api/anchor/:code/lookup', (req, res) => {
  const map: Record<string, string> = {
    reviewed: ids.live,
    hidden12: ids.unreviewed,
  }
  const productId = map[String(req.params.code)]
  if (!productId) return void res.status(404).json({ found: false })
  const product = db.prepare('SELECT id, title FROM products WHERE id = ?').get(productId)
  res.json({ found: true, status: 'active', product })
})

let http!: HttpServer
const listenError = await new Promise<Error | null>(resolve => {
  http = app.listen(0, '127.0.0.1')
  http.once('listening', () => resolve(null))
  http.once('error', (error: Error) => resolve(error))
})
if (listenError) throw listenError

const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
process.env.WEBAZ_API_URL = base
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const connect = async (surface: 'shopping_v1' | 'full') => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer({ isolated: true, surface }).connect(serverTransport)
  const client = new Client({ name: `openai-${surface}`, version: '0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return client
}

const shopping = await connect('shopping_v1')
const listed = await shopping.listTools()
ok('shopping_v1 wire advertises exactly one anonymous discovery tool',
  listed.tools.length === 1
  && listed.tools[0]?.name === 'webaz_search'
  && JSON.stringify((listed.tools[0]?._meta as Record<string, unknown> | undefined)?.securitySchemes)
    === JSON.stringify([{ type: 'noauth' }])
  && /discovery-only/.test(listed.tools[0]?.description ?? ''),
  JSON.stringify(listed.tools))
const publicOutputSchema = listed.tools[0]?.outputSchema as Record<string, unknown> | undefined
const publicOutputProperties = publicOutputSchema?.properties as Record<string, unknown> | undefined
const publicProductProperties = (((publicOutputProperties?.products as Record<string, unknown> | undefined)
  ?.items as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined)
ok('shopping_v1 schema exposes an inline public seller summary and no internal seller reference/map',
  !!publicProductProperties?.seller
  && !publicProductProperties?.seller_ref
  && !publicOutputProperties?.sellers,
  JSON.stringify(publicOutputSchema))

const callShopping = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  payloadOf(await shopping.callTool({ name: 'webaz_search', arguments: args }) as Record<string, unknown>)

const keyword = await callShopping({ query: 'phone stand', max_price: 50 })
ok('real MCP keyword search returns only the reviewed live retail product',
  JSON.stringify(productIdsOf(keyword)) === JSON.stringify([ids.live])
  && keyword.public_commerce === true
  && keyword.public_product_url_template === 'https://webaz.xyz/#product/{product_id}',
  JSON.stringify(keyword).slice(0, 500))
const handle = String(keyword.result_handle ?? '')
ok('public keyword search issues a real result handle', /^res_[0-9a-f]{32}$/.test(handle), handle)

const detail = await callShopping({ result_handle: handle, selected_ids: [ids.live] })
ok('real result_handle detail re-applies the reviewed policy',
  JSON.stringify(productIdsOf(detail)) === JSON.stringify([ids.live]),
  JSON.stringify(detail).slice(0, 500))

const reviewedAnchor = await callShopping({ query: '@reviewed' })
ok('reviewed anchor resolves through the real public product route',
  reviewedAnchor.matched_by === 'anchor'
  && JSON.stringify(productIdsOf(reviewedAnchor)) === JSON.stringify([ids.live]),
  JSON.stringify(reviewedAnchor).slice(0, 500))
const hiddenAnchor = await callShopping({ query: '@hidden12' })
ok('anchor cannot expose a product outside the reviewed allowlist',
  productIdsOf(hiddenAnchor).length === 0
  && hiddenAnchor.matched_by === 'anchor_stale',
  JSON.stringify(hiddenAnchor).slice(0, 500))

const external = await callShopping({ paste_text: 'Reviewed Phone Stand' })
ok('external-link search is narrowed by the real public-commerce route',
  JSON.stringify(productIdsOf(external)) === JSON.stringify([ids.live]),
  JSON.stringify(external).slice(0, 500))
ok('public external-link result never instructs a hidden transaction tool',
  !JSON.stringify(external).includes('webaz_verify_price'),
  JSON.stringify(external).slice(0, 500))

const multi = await callShopping({ query: 'Reviewed Desk Lamp' })
ok('public more-results link is the canonical WebAZ discovery URL',
  productIdsOf(multi).length === 5
  && multi.more_url === 'https://webaz.xyz/#discover',
  JSON.stringify(multi).slice(0, 500))
const publicEntryOutputs = [keyword, detail, reviewedAnchor, hiddenAnchor, external, multi]
ok('all public search entry modes expose only de-identified public seller summaries',
  publicEntryOutputs.every(output => {
    const wire = JSON.stringify(output)
    const products = (output.products ?? []) as Array<Record<string, unknown>>
    return !wire.includes('seller-live')
      && !Object.hasOwn(output, 'sellers')
      && products.every(product => {
        const seller = product.seller as Record<string, unknown> | undefined
        return !Object.hasOwn(product, 'seller_ref')
          && !!seller
          && Object.keys(seller).every(key => ['name', 'level', 'rep_points'].includes(key))
      })
  }),
  JSON.stringify(publicEntryOutputs.map(output => ({
    matched_by: output.matched_by,
    sellers: output.sellers,
    products: output.products,
  }))).slice(0, 5000))

const recovery = await callShopping({ query: 'no-such-reviewed-product' })
ok('reviewed catalog no-match remains empty and gives reviewed recovery',
  productIdsOf(recovery).length === 0
  && (recovery.recovery as Record<string, unknown> | undefined)?.reason === 'reviewed_catalog_no_match',
  JSON.stringify(recovery).slice(0, 500))

const blocked = await shopping.callTool({
  name: 'webaz_quote_order',
  arguments: { product_id: ids.live },
}) as Record<string, unknown>
const blockedText = (blocked.content as Array<{ text?: string }> | undefined)
  ?.map(item => item.text ?? '').join('') ?? ''
ok('cached hidden order-tool call is rejected before quote/order execution',
  /TOOL_NOT_AVAILABLE_ON_SURFACE/.test(blockedText))

const full = await connect('full')
const mixed = payloadOf(await full.callTool({
  name: 'webaz_search',
  arguments: { query: 'mixed-handle' },
}) as Record<string, unknown>)
const mixedHandle = String(mixed.result_handle ?? '')
const reviewedFromMixedHandle = await callShopping({
  result_handle: mixedHandle,
  selected_ids: [ids.live],
  card: true,
})
ok('public fetch revalidates the whole cross-surface handle before total/more metadata',
  reviewedFromMixedHandle.total_count === 1
  && reviewedFromMixedHandle.more_url === undefined
  && JSON.stringify(productIdsOf(reviewedFromMixedHandle)) === JSON.stringify([ids.live]),
  JSON.stringify(reviewedFromMixedHandle).slice(0, 500))
const forged = payloadOf(await full.callTool({
  name: 'webaz_search',
  arguments: {
    query: 'Unreviewed Phone Stand',
    __tool_surface__: 'shopping_v1',
  },
}) as Record<string, unknown>)
ok('caller-forged surface marker cannot force public mode on a full server',
  JSON.stringify(productIdsOf(forged)) === JSON.stringify([ids.unreviewed])
  && forged.public_commerce !== true
  && JSON.stringify(forged).includes('seller-live')
  && Object.hasOwn(forged, 'sellers'),
  JSON.stringify(forged).slice(0, 500))

await full.close()
await shopping.close()
await new Promise<void>(resolve => http.close(() => resolve()))
db.close()
delete process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS
if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile
if (oldMode === undefined) delete process.env.WEBAZ_MODE; else process.env.WEBAZ_MODE = oldMode
if (oldApiUrl === undefined) delete process.env.WEBAZ_API_URL; else process.env.WEBAZ_API_URL = oldApiUrl
rmSync(testHome, { recursive: true, force: true })

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`openai shopping discovery: ${pass} assertions passed`)
