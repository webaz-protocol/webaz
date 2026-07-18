#!/usr/bin/env tsx
/**
 * MCP Token PR-2 — result_handle(选择集句柄+按需详情)+ buyer_orders updated_since 增量读。
 *   用法:npm run test:mcp-result-handle
 *
 * 铁则被测:句柄【只存 id 选择集】,详情永远活读 + 重跑 active 谓词 —— 下架商品诚实 unavailable,
 * 句柄不可能变成权限绕过或陈旧数据通道;TTL 过期/越集/超量全部结构化错误;boot 清扫;
 * updated_since 无变化 → 极小 up_to_date,有变化 → timeline 只回新条目。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-rh-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { registerProductsListRoutes } = await import('../src/pwa/routes/products-list.js')
const { initUserModerationSchema, initWebauthnSchema, initMcpResultCacheSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const FORBIDDEN = /commitment_hash|description_hash|price_hash|hashed_at|metrics_backfilled_at|cold_start_remaining|score_breakdown|commission_rate|source_url|source_price|peer_endpoint/

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
for (const c of ['listing_paused INTEGER DEFAULT 0']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${c}`) } catch { /* */ } }
for (const col of ['commitment_hash TEXT', 'source_url TEXT', 'commission_rate REAL', 'claim_loss_count INTEGER DEFAULT 0', 'product_type TEXT', 'category_id TEXT']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`) } catch { /* */ } }
db.exec(`CREATE TABLE IF NOT EXISTS product_categories (id TEXT PRIMARY KEY, seasonal_months TEXT);
CREATE TABLE IF NOT EXISTS order_ratings (id TEXT, product_id TEXT, buyer_id TEXT, stars INTEGER);
CREATE TABLE IF NOT EXISTS dispute_cases (id TEXT, seller_id TEXT, winner TEXT);
CREATE TABLE IF NOT EXISTS product_trial_campaigns (id TEXT, product_id TEXT, status TEXT, quota_total INTEGER, quota_claimed INTEGER);
CREATE TABLE IF NOT EXISTS product_external_links (id TEXT, product_id TEXT, external_title TEXT, verified INTEGER, revoked INTEGER);
CREATE TABLE IF NOT EXISTS user_blocklist (blocker_id TEXT, blocked_id TEXT)`)
for (const col of ['verified INTEGER', 'revoked INTEGER']) { try { db.exec(`ALTER TABLE product_external_links ADD COLUMN ${col}`) } catch { /* */ } }

db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','HandleSeller','seller','k_s'),('buyer1','B','buyer','k_b')").run()
const LONG_DESC = '这是一个很长的商品描述,包含结构细节与材质说明。'.repeat(40)   // >600 chars → 截断
const insP = db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days,warranty_days,handling_hours,specs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
for (let i = 1; i <= 6; i++) insP.run(`prd_h${i}`, 'seller1', `Handle Stand ${i}`, LONG_DESC, 5 + i, 'WAZ', 9, 'phone_stand', 'active', 7, 90, 24, JSON.stringify({ 材质: '铝合金', 轴数: '3' }))
db.prepare("UPDATE products SET commitment_hash='INTERNAL_H', source_url='https://pdd.example/x', commission_rate=0.1").run()

// U-tests 订单 + 状态史(两条事件,时间错开)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,created_at,updated_at)
  VALUES ('ord_u1','buyer1','seller1','prd_h1','accepted',10,10,10,'escrow','SECRET ADDR', datetime('now','-2 days'), datetime('now','-1 hours'))`).run()
db.prepare("INSERT INTO order_state_history (order_id, from_status, to_status, actor_id, actor_role, created_at) VALUES ('ord_u1','created','paid','buyer1','buyer', datetime('now','-2 days'))").run()
db.prepare("INSERT INTO order_state_history (order_id, from_status, to_status, actor_id, actor_role, created_at) VALUES ('ord_u1','paid','accepted','seller1','seller', datetime('now','-1 hours'))").run()

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
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
  formatProductForAgent: (p: Record<string, unknown>) => ({ ...p, agent_summary: `${p.title} — solid` }),
})
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as {
  buildMcpServer: () => { connect: (t: unknown) => Promise<void> }
  handleBuyerOrders: (a: Record<string, unknown>) => Promise<Record<string, unknown>>
}
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const webazDir = join(tmpHome, '.webaz')
db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES ('grt_rh','buyer1','RH',?,?, 'active', ?)")
  .run(JSON.stringify(['buyer_orders_read_minimal', 'buyer_orders_read'].map(c => ({ capability: c }))), sha('gtk_rh'), new Date(Date.now() + 3600_000).toISOString())
mkdirSync(webazDir, { recursive: true })
writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ grt_rh: { token: 'gtk_rh', stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: 'grt_rh', handle: 'file:~/.webaz/credentials#grt_rh', capabilities: [{ capability: 'buyer_orders_read_minimal' }, { capability: 'buyer_orders_read' }], expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })

const [ct, st] = InMemoryTransport.createLinkedPair()
await mcp.buildMcpServer().connect(st)
const client = new Client({ name: 'rh-test', version: '0' }, { capabilities: {} })
await client.connect(ct)
const call = async (a: Record<string, unknown>): Promise<Record<string, unknown>> => await client.callTool({ name: 'webaz_search', arguments: a }) as Record<string, unknown>
const scOf = (r: Record<string, unknown>): Record<string, unknown> => (r.structuredContent ?? {}) as Record<string, unknown>

try {
  // H-1 搜索签发 result_handle
  const s1 = scOf(await call({ sort: 'newest', limit: 5 }))
  const handle = String(s1.result_handle ?? '')
  ok('H-1 search issues result_handle (res_<32hex>) + TTL hint', /^res_[0-9a-f]{32}$/.test(handle) && s1.result_handle_expires_in_s === 600, JSON.stringify(s1).slice(0, 200))
  const ids = (s1.products as Array<Record<string, unknown>>).map(p => String(p.id))

  // H-2 按需详情:活读 + 截断 + 零内部字段 + 预算
  const d1r = await call({ result_handle: handle, selected_ids: ids.slice(0, 2) })
  const d1 = scOf(d1r)
  const d1j = JSON.stringify(d1)
  const dp = (d1.products as Array<Record<string, unknown>>) ?? []
  ok('H-2a detail fetch → webaz.product_detail.model.v1, 2 items, live data', d1.schema_version === 'webaz.product_detail.model.v1' && dp.length === 2, d1j.slice(0, 200))
  ok('H-2b description truncated at 600 + flag; specs surfaced', dp.every(p => String(p.description).length <= 600 && p.description_truncated === true) && !!dp[0].specs)
  ok('H-2c NO internal fields in detail projection', !FORBIDDEN.test(d1j), d1j.slice(0, 200))
  const perItem = Math.round(d1j.length / dp.length)
  ok('H-2d detail budget ≤1600B/item', perItem <= 1600, `perItem=${perItem}`)
  ok('H-2e detail summary text carries the ids (text-only clients keep working)', ids.slice(0, 2).every(id => String((d1r.content as Array<{ text: string }>)[0].text).includes(id)))

  // H-3 越集 id 拒绝
  const notInSet = ['prd_h1', 'prd_h2', 'prd_h3', 'prd_h4', 'prd_h5', 'prd_h6'].find(x => !ids.includes(x))!
  const d2 = scOf(await call({ result_handle: handle, selected_ids: [notInSet] }))
  ok('H-3 ids outside the handle set → SELECTED_IDS_NOT_IN_HANDLE', d2.error_code === 'SELECTED_IDS_NOT_IN_HANDLE', JSON.stringify(d2).slice(0, 150))

  // H-4 过期句柄:结构化错误 + next_steps 穿透 MCP 错误整形
  db.prepare("UPDATE mcp_result_cache SET expires_at = datetime('now','-1 minutes') WHERE handle_id = ?").run(handle)
  const d3r = await call({ result_handle: handle, selected_ids: [ids[0]] })
  const d3 = scOf(d3r)
  ok('H-4 expired handle → RESULT_HANDLE_EXPIRED + isError + next_steps survive', d3.error_code === 'RESULT_HANDLE_EXPIRED' && d3r.isError === true && JSON.stringify(d3).includes('search_again'), JSON.stringify(d3).slice(0, 200))

  // H-5/H-7 形状与未知句柄
  const s2 = scOf(await call({ sort: 'newest', limit: 5 }))
  const h2 = String(s2.result_handle)
  const d4 = scOf(await call({ result_handle: h2, selected_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }))
  ok('H-5 >5 selected_ids → SELECTED_IDS_INVALID', d4.error_code === 'SELECTED_IDS_INVALID')
  const d5 = scOf(await call({ result_handle: 'res_' + '0'.repeat(32), selected_ids: ['x'] }))
  ok('H-7 unknown handle → RESULT_HANDLE_INVALID', d5.error_code === 'RESULT_HANDLE_INVALID')

  // H-6 句柄期内商品下架 → 活读诚实 unavailable(绝不吐缓存)
  const sid = (s2.products as Array<Record<string, unknown>>).map(p => String(p.id))
  db.prepare("UPDATE products SET status = 'paused' WHERE id = ?").run(sid[0])
  const d6 = scOf(await call({ result_handle: h2, selected_ids: [sid[0], sid[1]] }))
  ok('H-6 deactivated-after-issue product → unavailable_ids (live re-check, no stale cache)', (d6.count === 1) && Array.isArray(d6.unavailable_ids) && (d6.unavailable_ids as string[])[0] === sid[0], JSON.stringify(d6).slice(0, 200))

  // H-8 boot 清扫
  db.prepare("INSERT INTO mcp_result_cache (handle_id, subject, tool, item_ids, expires_at) VALUES ('res_dead', NULL, 'webaz_search', '[]', datetime('now','-1 hours'))").run()
  initMcpResultCacheSchema(db)
  ok('H-8 boot purge removes expired handles', !db.prepare("SELECT 1 FROM mcp_result_cache WHERE handle_id = 'res_dead'").get())

  // U-1..U-4 updated_since 增量读(经 MCP handler → 真路由)
  const u1 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true })
  ok('U-1 full view baseline: 2 timeline entries, no incremental marker', Array.isArray(u1.timeline) && (u1.timeline as unknown[]).length === 2 && u1.incremental === undefined, JSON.stringify(u1).slice(0, 200))
  const u2 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() + 3600_000).toISOString() })
  const u2j = JSON.stringify(u2)
  ok('U-2 updated_since in the future → tiny up_to_date response (no timeline/terms/actions)', u2.up_to_date === true && !u2.timeline && u2j.length < 400, u2j.slice(0, 200))
  const u3 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 12 * 3600_000).toISOString() })
  ok('U-3 updated_since between events → ONLY newer timeline entries + incremental marker', Array.isArray(u3.timeline) && (u3.timeline as unknown[]).length === 1 && !!(u3.incremental as Record<string, unknown>)?.timeline_new, JSON.stringify(u3.incremental ?? {}))
  const u4 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: 'not-a-timestamp' })
  ok('U-4 malformed updated_since → UPDATED_SINCE_INVALID (structured, retryable)', u4.error_code === 'UPDATED_SINCE_INVALID')
  ok('U-5 no PII in any incremental form', !/SECRET/.test(JSON.stringify([u1, u2, u3])))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ mcp-result-handle FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-result-handle: 选择集句柄活读详情(零陈货/零绕权)+ TTL/越集/清扫 + updated_since 增量 — 全绿\n  ✅ pass ${pass}`)
