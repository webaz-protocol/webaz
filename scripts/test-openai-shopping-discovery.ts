#!/usr/bin/env tsx
import Database from 'better-sqlite3'
import express from 'express'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import {
  publicCommerceSqlFilter,
  PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_MAX,
  readPublicCommerceAllowedProductIds,
} from '../src/public-commerce-policy.js'
import { registerSearchRoutes } from '../src/pwa/routes/search.js'

let pass = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => {
  if (condition) pass++
  else failures.push(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

const ids = {
  live: 'prd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  digital: 'prd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  paused: 'prd_cccccccccccccccccccccccccccccccc',
  out: 'prd_dddddddddddddddddddddddddddddddd',
  revoked: 'prd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  unreviewed: 'prd_ffffffffffffffffffffffffffffffff',
}
delete process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS
ok('missing allowlist is fail-closed', readPublicCommerceAllowedProductIds().length === 0)
ok('malformed allowlist is fail-closed', readPublicCommerceAllowedProductIds('["broken"').length === 0)
ok('invalid member invalidates the whole allowlist',
  readPublicCommerceAllowedProductIds(`${ids.live},not-a-product`).length === 0)
const oversizedAllowlist = Array.from(
  { length: PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_MAX + 1 },
  (_, index) => `prd_${String(index).padStart(8, '0')}`,
)
ok('oversized allowlist is fail-closed',
  readPublicCommerceAllowedProductIds(oversizedAllowlist.join(',')).length === 0)
process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS =
  [ids.live, ids.digital, ids.paused, ids.out, ids.revoked].join(',')

const db = new Database(':memory:')
setSeamDb(db)
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, listing_paused INTEGER DEFAULT 0);
  CREATE TABLE products (
    id TEXT PRIMARY KEY, seller_id TEXT, product_type TEXT, status TEXT, stock INTEGER
  );
  CREATE TABLE product_external_links (
    product_id TEXT, verified INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0
  );
`)
db.prepare('INSERT INTO users VALUES (?,?,?)').run('seller-live', 'Live', 0)
db.prepare('INSERT INTO users VALUES (?,?,?)').run('seller-paused', 'Paused', 1)
const insertProduct = db.prepare('INSERT INTO products VALUES (?,?,?,?,?)')
insertProduct.run(ids.live, 'seller-live', 'retail', 'active', 5)
insertProduct.run(ids.digital, 'seller-live', 'digital', 'active', 5)
insertProduct.run(ids.paused, 'seller-paused', 'retail', 'active', 5)
insertProduct.run(ids.out, 'seller-live', 'retail', 'active', 0)
insertProduct.run(ids.revoked, 'seller-live', 'retail', 'active', 5)
insertProduct.run(ids.unreviewed, 'seller-live', 'retail', 'active', 5)
db.prepare('INSERT INTO product_external_links VALUES (?,?,?)').run(ids.revoked, 0, 1)

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

const routeSource = readFileSync(new URL('../src/pwa/routes/products-list.ts', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('../src/layer1-agent/L1-1-mcp-server/server.ts', import.meta.url), 'utf8')
ok('normal search, recovery, anchor and result-fetch all carry the narrowing selector',
  serverSource.includes("qs.set('public_commerce', '1')")
  && serverSource.includes("aqs.set('public_commerce', '1')")
  && serverSource.includes("rqs.set('public_commerce', '1')")
  && serverSource.includes('{ public_commerce: true }')
  && serverSource.includes('body.public_commerce = true'))
ok('catalog and result-fetch independently apply the reviewed policy',
  (routeSource.match(/publicCommerceSqlFilter\('p'\)/g) ?? []).length === 2
  && routeSource.includes("req.query.public_commerce === '1'")
  && routeSource.includes('public_commerce === true'))

const app = express()
app.use(express.json())
const catalogQueries: Array<Record<string, unknown>> = []
app.get('/api/products', (req, res) => {
  catalogQueries.push({ ...req.query })
  const reviewed = req.query.public_commerce === '1' && req.query.fuzzy === 'true'
  res.json({
    schema_version: 'webaz.product_search.model.v1',
    count: reviewed ? 1 : 0,
    total_count: reviewed ? 1 : 0,
    sellers: {},
    products: reviewed ? [{
      id: ids.live,
      title: 'Reviewed Phone Stand',
      price: { amount_minor: 20_000_000, currency: 'USDC', display: '20.00 USDC' },
      stock_status: 'in_stock',
    }] : [],
  })
})
const allProducts = Object.values(ids).map(id => ({ id }))
registerSearchRoutes(app, {
  db,
  auth: (_req, res) => { res.status(401).json({ error: 'unauthorized' }); return null },
  applyCouponToOrder: () => ({ ok: false }),
  extractUrlFromText: () => null,
  extractTitleFromText: text => text,
  parsePlatformUrl: () => null,
  searchByExternalLink: () => ({ matched_by: 'product_title_exact', products: allProducts }),
  detectShareCommandFormat: () => null,
  formatProductForAgent: row => row,
})

let http!: HttpServer
const listenError = await new Promise<Error | null>(resolve => {
  http = app.listen(0, '127.0.0.1')
  http.once('listening', () => resolve(null))
  http.once('error', (error: Error) => resolve(error))
})
if (listenError) {
  if ((listenError as NodeJS.ErrnoException).code === 'EPERM' && process.env.CI !== 'true') {
    console.log('openai shopping discovery: HTTP route matrix skipped locally; CI must execute it')
  } else {
    throw listenError
  }
} else {
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const post = (body: Record<string, unknown>) => fetch(`${base}/api/search-by-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const full = await post({ text: 'exact title' })
  const fullJson = await full.json() as { products?: Array<{ id: string }> }
  ok('full/PWA external-link behavior remains unchanged',
    full.status === 200 && fullJson.products?.length === allProducts.length)

  const reviewed = await post({ text: 'exact title', public_commerce: true })
  const reviewedJson = await reviewed.json() as { products?: Array<{ id: string }> }
  ok('public plugin external-link response excludes every ineligible class',
    reviewed.status === 200
    && JSON.stringify(reviewedJson.products?.map(product => product.id)) === JSON.stringify([ids.live]))

  const oldHome = process.env.HOME
  const oldUserProfile = process.env.USERPROFILE
  const oldMode = process.env.WEBAZ_MODE
  const oldApiUrl = process.env.WEBAZ_API_URL
  const mcpHome = mkdtempSync(join(tmpdir(), 'webaz-openai-shopping-'))
  process.env.HOME = mcpHome
  process.env.USERPROFILE = mcpHome
  process.env.WEBAZ_MODE = 'network'
  process.env.WEBAZ_API_URL = base
  const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer({ isolated: true, surface: 'shopping_v1' }).connect(serverTransport)
  const client = new Client({ name: 'openai-shopping-discovery', version: '0' }, { capabilities: {} })
  await client.connect(clientTransport)

  const listed = await client.listTools()
  ok('shopping_v1 wire advertises exactly one anonymous discovery tool',
    listed.tools.length === 1
    && listed.tools[0]?.name === 'webaz_search'
    && JSON.stringify((listed.tools[0]?._meta as Record<string, unknown> | undefined)?.securitySchemes) === JSON.stringify([{ type: 'noauth' }])
    && /discovery-only/.test(listed.tools[0]?.description ?? ''),
    JSON.stringify(listed.tools))

  const searched = await client.callTool({
    name: 'webaz_search',
    arguments: { query: 'phone stand', max_price: 50 },
  }) as Record<string, unknown>
  const searchPayload = (searched.structuredContent ?? {}) as Record<string, unknown>
  ok('real shopping_v1 call adds reviewed-catalog + keyword fallback selectors and returns public marker',
    catalogQueries.some(query =>
      query.public_commerce === '1'
      && query.fuzzy === 'true'
      && query.q === 'phone stand'
      && query.max_price === '50')
    && searchPayload.public_commerce === true
    && searchPayload.public_product_url_template === `${base}/#product/{product_id}`
    && (searchPayload.products as Array<{ id?: string }> | undefined)?.[0]?.id === ids.live)

  const blocked = await client.callTool({ name: 'webaz_quote_order', arguments: { product_id: ids.live } }) as Record<string, unknown>
  const blockedText = (blocked.content as Array<{ text?: string }> | undefined)?.map(item => item.text ?? '').join('') ?? ''
  ok('cached hidden order-tool call is rejected before quote/order execution',
    /TOOL_NOT_AVAILABLE_ON_SURFACE/.test(blockedText))

  await client.close()
  rmSync(mcpHome, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile
  if (oldMode === undefined) delete process.env.WEBAZ_MODE; else process.env.WEBAZ_MODE = oldMode
  if (oldApiUrl === undefined) delete process.env.WEBAZ_API_URL; else process.env.WEBAZ_API_URL = oldApiUrl
  await new Promise<void>(resolve => http.close(() => resolve()))
}

delete process.env.WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS
db.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`openai shopping discovery: ${pass} assertions passed`)
