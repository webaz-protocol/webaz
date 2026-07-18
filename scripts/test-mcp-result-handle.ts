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
const { OUTPUT_SCHEMAS } = await import('../src/layer1-agent/L1-1-mcp-server/tool-output-schemas.js')
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
  ok('H-2b description byte-capped (≤900B UTF-8) + flag; specs surfaced', dp.every(p => Buffer.byteLength(String(p.description), 'utf8') <= 900 && p.description_truncated === true) && !!dp[0].specs)
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

  // H-6b/H-6c 其余公共可见性谓词同样活跑(Codex H-1):库存归零 / 外链 revoked-未-verified → unavailable
  const s3 = scOf(await call({ sort: 'newest', limit: 5 }))
  const h3 = String(s3.result_handle); const sid3 = (s3.products as Array<Record<string, unknown>>).map(p => String(p.id))
  db.prepare("UPDATE products SET stock = 0 WHERE id = ?").run(sid3[0])
  const pelCols = (db.prepare("PRAGMA table_info(product_external_links)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>)
  const pelExtra = pelCols.filter(c => c.notnull === 1 && c.dflt_value == null && !['id', 'product_id', 'verified', 'revoked'].includes(c.name)).map(c => c.name)
  db.prepare(`INSERT INTO product_external_links (id, product_id, verified, revoked${pelExtra.map(c => ', ' + c).join('')}) VALUES ('pel_rvk', ?, 0, 1${pelExtra.map(() => ", 'x'").join('')})`).run(sid3[1])
  const d7 = scOf(await call({ result_handle: h3, selected_ids: [sid3[0], sid3[1], sid3[2]] }))
  ok('H-6b/H-6c stock-zero + revoked-link products → unavailable (same predicates as search, live)',
    d7.count === 1 && Array.isArray(d7.unavailable_ids) && (d7.unavailable_ids as string[]).sort().join(',') === [sid3[0], sid3[1]].sort().join(','), JSON.stringify(d7).slice(0, 250))
  db.prepare("UPDATE products SET stock = 9 WHERE id = ?").run(sid3[0]); db.prepare("DELETE FROM product_external_links WHERE id = 'pel_rvk'").run()

  // H-9 结构化输出符合 tools/list 广告的 outputSchema(联合 schema_version)
  const schemaEnum = ((OUTPUT_SCHEMAS.webaz_search as Record<string, Record<string, Record<string, unknown>>>).properties.schema_version.enum ?? []) as string[]
  ok('H-9 search + detail schema_version both admitted by the advertised outputSchema enum',
    schemaEnum.includes(String(s3.schema_version)) && schemaEnum.includes('webaz.product_detail.model.v1') && schemaEnum.length === 2, JSON.stringify(schemaEnum))

  // H-10 污染的 item_ids 行 → fail-closed 结构化错误,绝不 500
  db.prepare("INSERT INTO mcp_result_cache (handle_id, subject, tool, item_ids, expires_at) VALUES ('res_" + 'f'.repeat(32) + "', NULL, 'webaz_search', '{}', datetime('now','+10 minutes'))").run()
  const d8 = scOf(await call({ result_handle: 'res_' + 'f'.repeat(32), selected_ids: ['x'] }))
  ok('H-10 poisoned item_ids (non-array JSON) → RESULT_HANDLE_INVALID, no 500', d8.error_code === 'RESULT_HANDLE_INVALID', JSON.stringify(d8).slice(0, 150))

  // H-11 specs 超限封顶:巨型 specs → specs 省略 + specs_truncated,预算仍守住
  db.prepare("UPDATE products SET specs = ? WHERE id = ?").run(JSON.stringify({ k: '规'.repeat(400) }), sid3[2])   // ~410 字符(旧字符实现放行)但 ~1200 UTF-8 字节 → 必须触发字节封顶
  const s4 = scOf(await call({ sort: 'newest', limit: 5 }))
  const d9 = scOf(await call({ result_handle: String(s4.result_handle), selected_ids: [sid3[2]] }))
  const d9p = (d9.products as Array<Record<string, unknown>>)[0]
  ok('H-11 oversized seller specs → omitted + specs_truncated flag, per-item budget holds',
    d9p.specs === undefined && d9p.specs_truncated === true && JSON.stringify(d9).length <= 1600 + 400, `len=${JSON.stringify(d9).length}`)

  // H-6d 卖家暂停谓词同样活跑
  const s5 = scOf(await call({ sort: 'newest', limit: 3 }))
  db.prepare("UPDATE users SET listing_paused = 1 WHERE id = 'seller1'").run()
  const d10 = scOf(await call({ result_handle: String(s5.result_handle), selected_ids: [String((s5.products as Array<Record<string, unknown>>)[0].id)] }))
  ok('H-6d seller paused after issue → unavailable (live predicate)', d10.count === 0 && Array.isArray(d10.unavailable_ids), JSON.stringify(d10).slice(0, 150))
  db.prepare("UPDATE users SET listing_paused = 0 WHERE id = 'seller1'").run()

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
  const u4b = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: '2026-99-99T99:99:99Z' })
  ok('U-4b shape-valid but SEMANTICALLY invalid timestamp → UPDATED_SINCE_INVALID (real Date parse)', u4b.error_code === 'UPDATED_SINCE_INVALID', JSON.stringify(u4b).slice(0, 120))
  const u4c = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: '2026-02-30T12:00:00Z' })
  ok('U-4c NONEXISTENT civil date (2026-02-30, Date-normalizable) → UPDATED_SINCE_INVALID (UTC roundtrip lock)', u4c.error_code === 'UPDATED_SINCE_INVALID', JSON.stringify(u4c).slice(0, 120))

  // U-6 同秒边界:与 since 同一秒的事件【绝不丢】(up_to_date 用严格 <;timeline 过滤 >=)
  const sameSec = new Date().toISOString().slice(0, 19)
  db.prepare("INSERT INTO order_state_history (order_id, from_status, to_status, actor_id, actor_role, created_at) VALUES ('ord_u1','accepted','shipped','seller1','seller', ?)").run(sameSec.replace('T', ' '))
  const u6 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: sameSec + 'Z' })
  ok('U-6 same-second event is NOT hidden behind up_to_date and IS included (dup-allowed, loss-forbidden)',
    u6.up_to_date === undefined && Array.isArray(u6.timeline) && (u6.timeline as Array<Record<string, unknown>>).some(t => String(t.to) === 'shipped'), JSON.stringify(u6).slice(0, 200))

  // U-8 退货变化被锚点覆盖(Codex H-2):orders.updated_at 未动但新退货行 → 不得 up_to_date
  db.prepare(`INSERT INTO return_requests (id, order_id, buyer_id, seller_id, product_id, reason, refund_amount, status, created_at) VALUES ('rr_u1','ord_u1','buyer1','seller1','prd_h1','quality',10,'pending', datetime('now'))`).run()
  const u8since = new Date(Date.now() - 120_000).toISOString()
  db.prepare("UPDATE orders SET updated_at = datetime('now','-1 days') WHERE id = 'ord_u1'").run()
  const u8 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: u8since })
  ok('U-8 new return request (order row untouched) → NOT up_to_date, refund_status carries it',
    u8.up_to_date === undefined && JSON.stringify(u8.refund_status ?? {}).includes('pending'), JSON.stringify(u8).slice(0, 200))

  // U-9 退货 resolved_at 也是锚点(仅 resolve 不新建行 → 仍不得 up_to_date)
  db.prepare("UPDATE orders SET updated_at = datetime('now','-1 days') WHERE id = 'ord_u1'").run()
  db.prepare("UPDATE return_requests SET resolved_at = datetime('now'), status = 'rejected' WHERE id = 'rr_u1'").run()
  const u9 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 120_000).toISOString() })
  ok('U-9 return resolved_at change alone defeats up_to_date', u9.up_to_date === undefined, JSON.stringify(u9).slice(0, 120))

  // U-10 agent 发货追踪 executed_at 是锚点
  db.prepare("DELETE FROM return_requests WHERE id = 'rr_u1'").run()
  db.prepare(`INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, executed_at, created_at)
    VALUES ('apr_trk','buyer1','grt_rh','RH','[]','high','once','executed', datetime('now','+1 days'),'order_action','ord_u1','ship', datetime('now'), datetime('now','-2 days'))`).run()
  const u10 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 120_000).toISOString() })
  ok('U-10 agent ship-tracking executed_at defeats up_to_date', u10.up_to_date === undefined, JSON.stringify(u10).slice(0, 120))
  db.prepare("DELETE FROM agent_permission_requests WHERE id = 'apr_trk'").run()

  // U-11 协商取消提案是锚点(存储态;表按需建 —— 与生产 initMutualCancelSchema 同构最小面)
  db.exec("CREATE TABLE IF NOT EXISTS mutual_cancel_proposals (id TEXT PRIMARY KEY, order_id TEXT, proposer_id TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT, resolved_by TEXT)")
  db.prepare("INSERT INTO mutual_cancel_proposals (id, order_id, proposer_id, created_at) VALUES ('mcp_u1','ord_u1','seller1', datetime('now'))").run()
  const u11 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 120_000).toISOString() })
  ok('U-11 mutual-cancel proposal (no transition) defeats up_to_date', u11.up_to_date === undefined, JSON.stringify(u11).slice(0, 120))
  db.prepare("DELETE FROM mutual_cancel_proposals WHERE id = 'mcp_u1'").run()
  const u12 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() + 3600_000).toISOString() })
  ok('U-12 after clearing anchors, future updated_since is up_to_date again (anchors are live MAX reads)', u12.up_to_date === true, JSON.stringify(u12).slice(0, 120))

  // U-13 pre-snapshot 订单:卖家改现商品行(products.updated_at)不得 up_to_date
  db.prepare("UPDATE orders SET trade_terms_snapshot = NULL, updated_at = datetime('now','-1 days') WHERE id = 'ord_u1'").run()
  db.prepare("UPDATE products SET return_days = 14, updated_at = datetime('now') WHERE id = 'prd_h1'").run()
  const u13 = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 120_000).toISOString() })
  ok('U-13 pre-snapshot order + live listing term change → NOT up_to_date (product row anchored)', u13.up_to_date === undefined, JSON.stringify(u13).slice(0, 120))
  // U-13b 降级快照(坏 JSON)同样走 live 路径 → 商品行仍纳锚(判定与 effectiveReturnDays 同源)
  db.prepare("UPDATE orders SET trade_terms_snapshot = '{not json' WHERE id = 'ord_u1'").run()
  db.prepare("UPDATE products SET updated_at = datetime('now') WHERE id = 'prd_h1'").run()
  const u13b = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 120_000).toISOString() })
  ok('U-13b DEGRADED snapshot (bad JSON → live fallback) + product change → NOT up_to_date', u13b.up_to_date === undefined, JSON.stringify(u13b).slice(0, 120))
  // U-13c 权威快照(source_read null=不可退)不读 live → 商品行变化不打扰 up_to_date
  db.prepare(`UPDATE orders SET trade_terms_snapshot = '{"v":1,"fulfilment":{"return_days":7}}' WHERE id = 'ord_u1'`).run()
  db.prepare("UPDATE order_state_history SET created_at = datetime('now','-2 days') WHERE order_id = 'ord_u1'").run()   // 钉死其余锚,只留商品行churn
  const u13c = await mcp.handleBuyerOrders({ order_id: 'ord_u1', full: true, updated_since: new Date(Date.now() - 120_000).toISOString() })
  ok('U-13c AUTHORITATIVE snapshot order ignores product-row churn → up_to_date preserved', u13c.up_to_date === true, JSON.stringify(u13c).slice(0, 120))
  db.prepare("UPDATE products SET updated_at = datetime('now','-3 days') WHERE id = 'prd_h1'").run()

  // H-12 限流(公共端点资源滥用护栏):RPM=1 → 立即 429 结构化;恢复默认后可用
  process.env.WEBAZ_RESULT_FETCH_RPM = '1'
  const rl = scOf(await call({ result_handle: String(s4.result_handle), selected_ids: [sid3[2]] }))
  ok('H-12 per-IP rate limit → structured RATE_LIMITED (retryable)', rl.error_code === 'RATE_LIMITED', JSON.stringify(rl).slice(0, 120))
  delete process.env.WEBAZ_RESULT_FETCH_RPM
  ok('U-5 no PII in any incremental form', !/SECRET/.test(JSON.stringify([u1, u2, u3])))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ mcp-result-handle FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-result-handle: 选择集句柄活读详情(零陈货/零绕权)+ TTL/越集/清扫 + updated_since 增量 — 全绿\n  ✅ pass ${pass}`)
