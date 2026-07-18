#!/usr/bin/env tsx
/**
 * MCP Token PR-1 — Model Projection + structuredContent + Token 预算基准。
 *   用法:npm run test:mcp-model-projection
 *
 * 覆盖(全部走真实组件,不桩被测投影):
 *   [wire]   in-memory MCP client → CallTool 包装层:三工具 structuredContent + 短摘要 content +
 *            null/空剥离;tools/list 携带版本化 outputSchema;错误结果 text 保留完整结构化错误 JSON。
 *   [search] 真实 /api/products?mode=agent 路由(agent 分支 Model Projection):内部字段(hash/迁移/
 *            回填/commission_rate/source_* 与 score_breakdown)不出现;默认 5 件;next_cursor 真翻页不重叠。
 *   [orders] /api/agent/buyer/orders:全账户 summary + 活跃优先 + 默认 10/上限 50 分页;7 键投影与零 PII 不变。
 *   [quote]  schema_version + 整数金额 + 预算。
 *   [budget] 响应字节数与估算 Token(bytes/4)基准 + 改造前后对比(legacy 基线 = 与旧 agent 分支同构的
 *            SELECT * 行 spread)。核心断言:模型可见字节较 legacy 降 ≥60%。
 *   [sandbox 子进程] handleSearch 本地路径同样输出投影(WEBAZ_MODE=sandbox 是模块加载期常量,须独立进程)。
 *
 * 测试数据全部虚构;dep 注入里 TRENDING_SCORE_EXPR/'formatProductForAgent' 用最小真实语义替身
 * (排序公式与 i18n 不是本测试的被测对象;投影/信封/包装层全为真)。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import express from 'express'
import type { AddressInfo } from 'node:net'

const FORBIDDEN = /commitment_hash|description_hash|price_hash|hashed_at|metrics_backfilled_at|cold_start_remaining|score_breakdown|commission_rate|source_url|source_price|peer_endpoint|content_signature|i18n_titles|i18n_descs|listing_stake_locked|stake_locked_at/
const PII = /SECRET|Jane|91234567|1 Test St|#05-01|shipping_address|gift_recipient/i
const estTokens = (bytes: number): number => Math.ceil(bytes / 4)

// ─── sandbox 子进程分支:本地 handleSearch 路径 ──────────────────────────────────────────────
if (process.env.MODEL_PROJ_PHASE === 'sandbox') {
  const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-mproj-sb-'))
  process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
  process.env.WEBAZ_MODE = 'sandbox'; delete process.env.WEBAZ_API_KEY
  const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
  const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
  const db = initDatabase(); db.pragma('foreign_keys = OFF'); applyWebazRuntimeSchema(db)
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','LocalSeller','seller','k_s')").run()
  const ins = db.prepare('INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days,warranty_days) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  for (let i = 1; i <= 6; i++) ins.run(`prd_l${i}`, 'seller1', `Local Stand ${i}`, 'internal description text', 5 + i, 'WAZ', 10, 'phone_stand', 'active', 7, 0)
  for (const col of ['commitment_hash TEXT', 'source_url TEXT']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
  db.prepare("UPDATE products SET commitment_hash='INTERNAL_HASH_L', source_url='https://pdd.example/internal'").run()
  const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { buildMcpServer: () => { connect: (t: unknown) => Promise<void> } }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer().connect(st)
  const client = new Client({ name: 'sb-test', version: '0' }, { capabilities: {} })
  await client.connect(ct)
  const res = await client.callTool({ name: 'webaz_search', arguments: {} }) as Record<string, unknown>
  const r = (res.structuredContent ?? {}) as Record<string, unknown>
  const j = JSON.stringify(r)
  const okAll =
    r.schema_version === 'webaz.product_search.model.v1'
    && Array.isArray(r.products) && (r.products as unknown[]).length === 5   // 默认 5 件(种了 6)
    && !FORBIDDEN.test(j)
    && !/"description"/.test(j)                                              // 完整描述不进模型
    && !!(r.fx as Record<string, unknown> | undefined)?.rates && typeof (r.fx as Record<string, unknown>)?.stale === 'boolean'   // sandbox 路径同样带 stale 标注的 fx
  if (!okAll) { console.error('sandbox local-path projection FAILED: ' + j.slice(0, 400)); process.exit(1) }
  console.log('sandbox-ok bytes=' + j.length)
  process.exit(0)
}

// ─── 主进程:network 全链路 ─────────────────────────────────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-mproj-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { registerProductsListRoutes } = await import('../src/pwa/routes/products-list.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN listing_paused INTEGER DEFAULT 0') } catch { /* */ }

const FULL_ADDR = 'Jane SECRET / 1 Test St #05-01 / Singapore SG / +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','holden_b','buyer','k_b',?,'SG')").run(FULL_ADDR)
db.prepare("INSERT INTO users (id,name,role,api_key,created_at) VALUES ('seller1','TokenSeller','seller','k_s', datetime('now','-10 days'))").run()

// 7 件在售商品(触发翻页)+ 满仓内部字段(投影必须全滤)
const insP = db.prepare('INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days,warranty_days,handling_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
for (let i = 1; i <= 7; i++) {
  insP.run(`prd_${i}`, 'seller1', `Magsafe Stand ${i}`, 'LONG internal description '.repeat(20), 4 + i, 'WAZ', i === 2 ? 2 : 15, 'phone_stand', 'active', 7, 90, 24)
}
for (const col of ['commitment_hash TEXT', 'description_hash TEXT', 'price_hash TEXT', 'source_url TEXT', 'source_price REAL', 'commission_rate REAL', 'claim_loss_count INTEGER DEFAULT 0', 'product_type TEXT', 'category_id TEXT']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
// products-list innerSelect 引用的旁表(生产由 pwa/server 内联 DDL 建;此处建最小同构,非被测对象)
db.exec(`CREATE TABLE IF NOT EXISTS product_categories (id TEXT PRIMARY KEY, seasonal_months TEXT);
CREATE TABLE IF NOT EXISTS order_ratings (id TEXT, product_id TEXT, buyer_id TEXT, stars INTEGER);
CREATE TABLE IF NOT EXISTS dispute_cases (id TEXT, seller_id TEXT, winner TEXT);
CREATE TABLE IF NOT EXISTS product_trial_campaigns (id TEXT, product_id TEXT, status TEXT, quota_total INTEGER, quota_claimed INTEGER);
CREATE TABLE IF NOT EXISTS product_external_links (id TEXT, product_id TEXT, external_title TEXT, verified INTEGER, revoked INTEGER);
CREATE TABLE IF NOT EXISTS user_blocklist (blocker_id TEXT, blocked_id TEXT)`)
for (const col of ['verified INTEGER', 'revoked INTEGER']) { try { db.exec(`ALTER TABLE product_external_links ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("UPDATE products SET commitment_hash='INTERNAL_HASH', description_hash='INTERNAL_HASH2', price_hash='INTERNAL_HASH3', source_url='https://pdd.example/secret-source', source_price=1.99, commission_rate=0.1").run()

// buyer1 的 12 单:9 completed + accepted/delivered/disputed 各 1(active-first + 分页 + summary)
const insO = db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now', ?))`)
for (let i = 1; i <= 9; i++) insO.run(`ord_c${String(i).padStart(2, '0')}`, 'buyer1', 'seller1', 'prd_1', 'completed', 10, 10, 10, 'escrow', '1 Test St SECRET', `-${20 + i} hours`)
insO.run('ord_act', 'buyer1', 'seller1', 'prd_1', 'accepted', 10, 10, 10, 'escrow', '1 Test St SECRET', '-1 hours')
insO.run('ord_del', 'buyer1', 'seller1', 'prd_2', 'delivered', 10, 10, 0, 'direct_p2p', '1 Test St SECRET', '-2 hours')
insO.run('ord_dis', 'buyer1', 'seller1', 'prd_3', 'disputed', 10, 10, 10, 'escrow', '1 Test St SECRET', '-3 hours')

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
// products-list:投影/信封为被测对象;排序公式与 i18n 非被测 → 最小真实语义替身(TRENDING=0,format 附 agent_summary)
registerProductsListRoutes(app, {
  db, getUser: () => null,
  VALID_PRODUCT_TYPES: new Set(['retail', 'wholesale', 'service', 'digital']),
  RAW_MODE_MIN_TRUST: 30, getAgentTrustCached: () => null,
  VALID_SORTS: new Set(['trending', 'newest', 'rating', 'price_asc', 'price_desc', 'random', 'recommended', 'seller_win_rate']),
  PRODUCT_LIMITS: { pwa: 30, agent: 200, raw: 500 },
  TRENDING_SCORE_EXPR: 'p.price',
  findProductsByAlias: () => new Set<string>(),
  decodeProductCursor: (c: string) => { try { const [s, id] = Buffer.from(c, 'base64url').toString().split(':'); return { score: Number(s), id } } catch { return null } },
  encodeProductCursor: (score: number, id: string) => Buffer.from(`${score}:${id}`).toString('base64url'),
  MASTER_SEED: 'test-seed',
  formatProductForAgent: (p: Record<string, unknown>) => ({ ...p, agent_summary: `${p.title} — ships fast` }),
})
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, humanId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'TP', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
mkGrant('grt_tp', 'buyer1', 'gtk_tp', ['buyer_orders_read_minimal', 'price_quote'])
useCred('grt_tp', 'gtk_tp', ['buyer_orders_read_minimal', 'price_quote'])

const H = mcp as unknown as {
  buildMcpServer: (opts?: Record<string, unknown>) => { connect: (t: unknown) => Promise<void> }
  handleBuyerOrders: (a: Record<string, unknown>) => Promise<Record<string, unknown>>
  handleQuoteOrder: (a: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const budgets: Array<{ surface: string; bytes: number; tokens: number; budget: number }> = []
const budgetOk = (surface: string, bytes: number, budget: number): boolean => {
  budgets.push({ surface, bytes, tokens: estTokens(bytes), budget })
  return bytes <= budget
}

try {
  // ── [wire] in-memory client:tools/list outputSchema + search e2e structuredContent ──────────
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const mcpServer = H.buildMcpServer()
  await mcpServer.connect(serverT)
  const client = new Client({ name: 'model-proj-test', version: '0' }, { capabilities: {} })
  await client.connect(clientT)

  const { tools } = await client.listTools()
  const byName = Object.fromEntries(tools.map(t => [t.name, t])) as Record<string, { outputSchema?: Record<string, unknown> }>
  const osOf = (n: string): Record<string, unknown> => (byName[n]?.outputSchema ?? {}) as Record<string, unknown>
  ok('W-1 exactly the 3 core tools carry outputSchema (search/buyer_orders/quote_order; others unchanged)',
    tools.filter(t => t.outputSchema).map(t => t.name).sort().join(',') === 'webaz_buyer_orders,webaz_quote_order,webaz_search')
  ok('W-2 outputSchema carries versioned schema ids (webaz.*.model.v1)',
    JSON.stringify(osOf('webaz_search')).includes('webaz.product_search.model.v1')
    && JSON.stringify(osOf('webaz_buyer_orders')).includes('webaz.order_status.model.v1')
    && JSON.stringify(osOf('webaz_quote_order')).includes('webaz.order_quote.model.v1'))

  const sr = await client.callTool({ name: 'webaz_search', arguments: {} }) as Record<string, unknown>
  const sc = sr.structuredContent as Record<string, unknown> | undefined
  const stext = (sr.content as Array<{ text: string }>)[0]?.text ?? ''
  const scJson = JSON.stringify(sc ?? {})
  ok('S-1 search (wire) returns structuredContent with schema_version', sc?.schema_version === 'webaz.product_search.model.v1', scJson.slice(0, 200))
  ok('S-2 search content = short ACTIONABLE summary (ids + next_cursor present, not the JSON blob)', stext.length > 0 && stext.length <= 480 && !stext.trimStart().startsWith('{') && /prd_/.test(stext) && (!sc?.next_cursor || stext.includes(String(sc.next_cursor))), `len=${stext.length} ${stext}`)
  ok('S-3 default page = 5 products (7 seeded)', Array.isArray(sc?.products) && (sc?.products as unknown[]).length === 5)
  ok('S-4 NO internal/DB fields reach the model (hashes/migration/backfill/commission/source/score)', !FORBIDDEN.test(scJson), scJson.slice(0, 300))
  ok('S-5 full description does NOT reach the model', !/LONG internal description/.test(scJson))
  ok('S-6 nulls / empty objects stripped from the wire form', !/":null/.test(scJson), scJson.slice(0, 200))
  ok('S-7 sellers deduped once (7 products, 1 seller) + products use seller_ref', !!(sc?.sellers as Record<string, unknown>)?.seller1 && scJson.split('"TokenSeller"').length === 2)
  ok('S-8 decision_flags are server-asserted facts (NO_SALES_HISTORY expected on fresh catalog)', /NO_SALES_HISTORY/.test(scJson))
  ok('S-9 next_cursor present on page 1 (more results exist)', typeof sc?.next_cursor === 'string' && (sc?.next_cursor as string).length > 0)

  // USDC 显示线(Holden 指令):商品价 display=USDC + fx 换算表(display-only,绝非结算)
  const p0 = (sc?.products as Array<Record<string, unknown>>)[0]
  ok('S-14 product price displays USDC (never WAZ) + envelope fx table with display-only note',
    (p0.price as Record<string, unknown>).currency === 'USDC' && String((p0.price as Record<string, unknown>).display).endsWith(' USDC')
    && !scJson.includes(' WAZ') && Number(((sc?.fx as Record<string, unknown>)?.rates as Record<string, unknown>)?.SGD) > 0
    && /display-only/.test(String((sc?.fx as Record<string, unknown>)?.note))
    && typeof (sc?.fx as Record<string, unknown>)?.stale === 'boolean', scJson.slice(0, 200))

  // 真翻页:page2 与 page1 不重叠(newest 排序走 keyset)
  const p1 = await client.callTool({ name: 'webaz_search', arguments: { sort: 'newest', limit: 5 } }) as Record<string, unknown>
  const p1sc = p1.structuredContent as Record<string, unknown>
  const p1ids = ((p1sc.products as Array<Record<string, unknown>>) ?? []).map(p => String(p.id))
  const p2 = await client.callTool({ name: 'webaz_search', arguments: { sort: 'newest', limit: 5, cursor: String(p1sc.next_cursor) } }) as Record<string, unknown>
  const p2sc = p2.structuredContent as Record<string, unknown>
  const p2ids = ((p2sc.products as Array<Record<string, unknown>>) ?? []).map(p => String(p.id))
  ok('S-10 cursor pages are disjoint and complete (5 + 2 of 7)', p1ids.length === 5 && p2ids.length === 2 && !p2ids.some(id => p1ids.includes(id)), `${p1ids.join('|')} // ${p2ids.join('|')}`)

  // budget: search 5 件(模型可见 = structuredContent + content 摘要)
  const searchBytes = scJson.length + stext.length
  ok('S-11 search 5-item model-visible bytes within budget (≤3600B ≈ 900 tokens)', budgetOk('search 5 items', searchBytes, 3600), `bytes=${searchBytes}`)

  // legacy 基线(与旧 agent 分支同构:SELECT * 行 spread × 5 + metrics/score_breakdown 近似)
  const legacyRows = db.prepare("SELECT p.*, u.name as seller_name, u.created_at as seller_created_at FROM products p JOIN users u ON u.id=p.seller_id WHERE p.status='active' LIMIT 5").all()
  const legacyBytes = JSON.stringify({ mode: 'agent', products: legacyRows.map(r => ({ ...(r as Record<string, unknown>), metrics: { completion_count: 0, dispute_loss_count: 0, unique_sharer_count: 0, last_sold_at: null, first_sold_at: null, rep_points: 0, rep_level: 'new' }, score: 0, score_breakdown: { completion: 0, rep: 0, unique_sharer: 0, freshness: 0, first_sale_boost: 0, seasonal_penalty: 0, dispute_penalty: 0 } })) }, null, 2).length
  const reduction = 1 - searchBytes / legacyBytes
  ok('S-12 model-visible bytes reduced ≥60% vs legacy full-row spread (acceptance)', reduction >= 0.6, `legacy=${legacyBytes}B now=${searchBytes}B reduction=${(reduction * 100).toFixed(1)}%`)
  console.log(`  [benchmark] search5: legacy=${legacyBytes}B (~${estTokens(legacyBytes)} tok) → now=${searchBytes}B (~${estTokens(searchBytes)} tok) — ↓${(reduction * 100).toFixed(1)}%`)

  // 0 命中(strict):错误/恢复语义保持 + 摘要仍短
  const zr = await client.callTool({ name: 'webaz_search', arguments: { query: 'no such product exists xyz' } }) as Record<string, unknown>
  const zsc = zr.structuredContent as Record<string, unknown>
  const ztext = (zr.content as Array<{ text: string }>)[0]?.text ?? ''
  ok('S-13 strict 0-hit keeps recovery object in structuredContent + short summary', (zsc.found === 0) && !!zsc.recovery && ztext.length <= 300, JSON.stringify(zsc).slice(0, 200))
  const zsample = (((zsc.recovery ?? {}) as Record<string, unknown>).catalog_sample as Array<Record<string, unknown>> | undefined) ?? []
  ok('S-13b zero-hit catalog sample prices display USDC (no WAZ on any product surface)',
    zsample.length > 0 && zsample.every(x => String(x.price_display ?? '').endsWith(' USDC')), JSON.stringify(zsample).slice(0, 150))

  // ── [orders] summary + 分页 + 7 键 + 零 PII(handler 级 + wire 级)─────────────────────────
  const r1 = await H.handleBuyerOrders({})
  const s1 = (r1.summary ?? {}) as Record<string, number>
  const o1 = (r1.orders ?? []) as Array<Record<string, unknown>>
  ok('O-1 schema_version + whole-account summary (12 total / 3 active / 1 awaiting_you(delivered) / 1 disputed / 9 completed)',
    r1.schema_version === 'webaz.order_status.model.v1' && s1.total === 12 && s1.active === 3 && s1.disputed === 1 && s1.completed === 9 && s1.awaiting_you >= 1,
    JSON.stringify(s1))
  ok('O-2 default page = 10 of 12 + next_cursor', o1.length === 10 && typeof r1.next_cursor === 'string', `len=${o1.length}`)
  ok('O-3 ACTIVE orders first (accepted/delivered/disputed all on page 1, before completed history)',
    ['ord_act', 'ord_del', 'ord_dis'].every(id => o1.slice(0, 3).map(o => o.order_id).includes(id)), o1.map(o => o.order_id).join(','))
  const EXPECT7 = 'amount,deadline,item_ref,next_actor,order_id,payment_rail,status'
  ok('O-4 每单仍是 7 键 allowlist(RFC-025 契约不破)', o1.every(o => Object.keys(o).sort().join(',') === EXPECT7))
  const r2 = await H.handleBuyerOrders({ cursor: String(r1.next_cursor) })
  const o2 = (r2.orders ?? []) as Array<Record<string, unknown>>
  ok('O-5 page 2 = remaining 2, disjoint, no next_cursor', o2.length === 2 && !o2.some(o => o1.map(x => x.order_id).includes(o.order_id)) && r2.next_cursor === undefined, JSON.stringify(o2.map(o => o.order_id)))
  ok('O-6 zero PII in the paged list', !PII.test(JSON.stringify(r1)) && !PII.test(JSON.stringify(r2)))
  ok('O-7 bad cursor → structured BAD_CURSOR (retryable)', (await H.handleBuyerOrders({ cursor: '!!notb64!!' })).error_code === 'BAD_CURSOR')
  ok('O-8 limit clamped to 50', ((await H.handleBuyerOrders({ limit: 500 })).orders as unknown[]).length === 12)

  const wr = await client.callTool({ name: 'webaz_buyer_orders', arguments: {} }) as Record<string, unknown>
  const wsc = wr.structuredContent as Record<string, unknown> | undefined
  const wtext = (wr.content as Array<{ text: string }>)[0]?.text ?? ''
  ok('O-9 buyer_orders (wire) → structuredContent + short ACTIONABLE summary (order ids present)', !!wsc && wsc.schema_version === 'webaz.order_status.model.v1' && wtext.length <= 800 && !wtext.trimStart().startsWith('{') && /ord_/.test(wtext), wtext)
  ok('O-10 wire orders keep EXACTLY the 7-key minimal contract (null placeholders preserved — buyer_orders is exempt from null-stripping)',
    Array.isArray(wsc?.orders) && (wsc?.orders as Array<Record<string, unknown>>).every(o => Object.keys(o).sort().join(',') === EXPECT7))
  const ordersBytes = JSON.stringify(wsc).length + wtext.length
  ok('O-11 orders list model-visible bytes within budget (≤2800B ≈ 700 tokens)', budgetOk('orders list (10)', ordersBytes, 2800), `bytes=${ordersBytes}`)

  // ── [quote] schema_version + 整数金额 + 预算(handler 级 + wire 级)───────────────────────
  const q = await H.handleQuoteOrder({ product_id: 'prd_1', quantity: 1 })
  ok('Q-1 quote carries schema_version + single-use token + integer money', q.schema_version === 'webaz.order_quote.model.v1' && String(q.quote_token ?? '').startsWith('qtk_') && Number.isInteger((q.total as Record<string, unknown>)?.amount_minor), JSON.stringify(q).slice(0, 200))
  ok('Q-2 quote keeps address masked (region only, full address never present)', !PII.test(JSON.stringify(q)))
  const qw = await client.callTool({ name: 'webaz_quote_order', arguments: { product_id: 'prd_2', quantity: 1 } }) as Record<string, unknown>
  const qsc = qw.structuredContent as Record<string, unknown> | undefined
  const qtext = (qw.content as Array<{ text: string }>)[0]?.text ?? ''
  ok('Q-3 quote (wire) → short summary carries quote_token + no-charge semantics (text-only clients can continue to draft)', !!qsc && /不扣款|nothing charged/i.test(qtext) && /qtk_/.test(qtext) && qtext.length <= 480, qtext)
  const quoteBytes = JSON.stringify(qsc).length + qtext.length
  ok('Q-4 quote model-visible bytes within budget (≤3000B ≈ 750 tokens — 托管/退款披露与 quote_token 可行动摘要为审计要求保留,不为预算裁安全文案)', budgetOk('quote', quoteBytes, 3000), `bytes=${quoteBytes}`)

  // ── [error path] 声明了 outputSchema 的工具,错误也走 structuredContent + 完整错误 text ────
  const er = await client.callTool({ name: 'webaz_quote_order', arguments: { product_id: 'prd_missing' } }) as Record<string, unknown>
  const esc = er.structuredContent as Record<string, unknown> | undefined
  const etext = (er.content as Array<{ text: string }>)[0]?.text ?? ''
  ok('E-1 error result: isError:true + structuredContent carries error_code AND text keeps the full structured error JSON (recovery fields survive for text-only clients)',
    er.isError === true && !!esc && typeof esc.error_code === 'string' && etext.trimStart().startsWith('{') && etext.includes(String(esc.error_code)), etext.slice(0, 200))

  // ── [paste] extracted 白名单:原始粘贴文本/URL(可携 PII/token)绝不回显进模型上下文 ────────
  app.post('/api/search-by-link', (_req, res) => { res.json({ matched_by: 'none', products: [], extracted: { platform: 'taobao', external_id: 'abc-123', external_title: 'Jane SECRET +65 91234567 raw paste', url: 'https://x.example/?token=SECRETTOKEN' } }) })
  const pr = await client.callTool({ name: 'webaz_search', arguments: { paste_text: 'Jane SECRET +65 91234567 https://x.example/?token=SECRETTOKEN' } }) as Record<string, unknown>
  const prAll = JSON.stringify(pr)
  const prx = ((pr.structuredContent ?? {}) as Record<string, unknown>).extracted as Record<string, unknown>
  ok('P-1 paste path: extracted reduced to shape-checked {platform, external_id}; raw title/url/PII never reach the model',
    prx?.platform === 'taobao' && prx?.external_id === 'abc-123' && !/SECRET|91234567|x\.example|SECRETTOKEN|external_title/.test(prAll), prAll.slice(0, 300))

  // ── [limits] 非整数 limit 不得炸 SQL(floor 收整)────────────────────────────────────────────
  const f1 = await H.handleBuyerOrders({ limit: 2.5 })
  ok('F-1 fractional buyer_orders limit → floored page (no SQL error)', !f1.error && (f1.orders as unknown[]).length === 2, JSON.stringify(f1).slice(0, 150))
  const f2 = await client.callTool({ name: 'webaz_search', arguments: { limit: 2.5, sort: 'newest' } }) as Record<string, unknown>
  ok('F-2 fractional search limit → floored page (no query_failed)', !((f2.structuredContent ?? {}) as Record<string, unknown>).error, JSON.stringify(f2.structuredContent).slice(0, 150))

  // ── [trending 注入翻页] 新卖家 slot 注入后 cursor 不得永久跳品(锚=原序展示集 keepHead)──────
  db.prepare("INSERT INTO users (id,name,role,api_key,created_at) VALUES ('seller2','FreshSeller','seller','k_s2', datetime('now'))").run()
  insP.run('prd_8', 'seller2', 'Fresh Seller Stand 8', 'd', 1, 'WAZ', 15, 'phone_stand', 'active', 7, 0, 24)
  const seen = new Set<string>()
  let cur: string | null = null
  for (let i = 0; i < 6; i++) {
    const pg = await client.callTool({ name: 'webaz_search', arguments: { sort: 'trending', limit: 3, ...(cur ? { cursor: cur } : {}) } }) as Record<string, unknown>
    const pgsc = pg.structuredContent as Record<string, unknown>
    for (const it of (pgsc.products as Array<Record<string, unknown>> ?? [])) seen.add(String(it.id))
    cur = typeof pgsc.next_cursor === 'string' ? pgsc.next_cursor : null
    if (!cur) break
  }
  ok('T-1 trending pages with new-seller slot injection cover ALL 8 products (duplicates allowed, permanent loss forbidden)', seen.size === 8, `seen=${[...seen].sort().join(',')}`)

  console.log(`  [tools/list] total serialized: ${JSON.stringify(tools).length}B (outputSchema on ${tools.filter(t => t.outputSchema).length} tools)`)

  // ── [sandbox 子进程] 本地路径投影 ──────────────────────────────────────────────────────────
  const sb = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/test-mcp-model-projection.ts'], { env: { ...process.env, MODEL_PROJ_PHASE: 'sandbox', WEBAZ_API_URL: '' }, encoding: 'utf8', timeout: 120_000 })
  ok('L-1 sandbox(local) handleSearch path emits the same projection (child process)', sb.status === 0 && /sandbox-ok/.test(sb.stdout), (sb.stdout + sb.stderr).slice(-400))

  console.log('\n  [token benchmark] model-visible surface (bytes ≈ tokens×4):')
  for (const b of budgets) console.log(`    ${b.surface.padEnd(18)} ${String(b.bytes).padStart(6)}B ~${String(b.tokens).padStart(4)} tok (budget ${b.budget}B)`)
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ mcp-model-projection FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-model-projection: structuredContent + model.v1 投影 + 分页 + 预算基准 — 全绿\n  ✅ pass ${pass}`)
