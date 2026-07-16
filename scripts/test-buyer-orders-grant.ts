#!/usr/bin/env tsx
/**
 * RFC-025 PR-1 — grant-wired buyer minimal order read (webaz_buyer_orders + GET /api/agent/buyer/orders(/:id)).
 *   用法:npm run test:buyer-orders-grant
 *
 * 镜像 test-mcp-agent-order-tools 的手法:真实 ephemeral PWA 挂真实 agent-grants 路由 + 真实 grant 凭证,
 * 【不桩被测组件】。覆盖:GRANT_REQUIRED(无凭证)· 买家 list/single 最小投影(恰 7 键)· 零 PII(地址/
 * 收件人/notes/gift/recipient_code 全不出现)· 卖家侧订单不可见(角色边界)· 他人订单 404 · 缺 scope →
 * PERMISSION_REQUIRED + hint · 纯只读(订单行零变化)。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-buyord-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'          // grant tools require network mode (set BEFORE importing MCP)
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('buyer2','B2','buyer','k_b2'),('seller1','S','seller','k_s')").run()
const FUT = '2099-01-01 00:00:00'
// buyer1 的两单(escrow + direct_p2p,均带 PII 地址/notes)——投影必须全滤掉
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,notes,ship_deadline)
  VALUES ('ord_b1a','buyer1','seller1','prd_x','accepted',30,30,30,'escrow','123 SECRET St · Jane · +6591234567','private NOTE',?)`).run(FUT)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,confirm_deadline)
  VALUES ('ord_b1b','buyer1','seller1','prd_y','delivered',40,40,0,'direct_p2p','999 SECRET Rd · Bob',?)`).run(FUT)
// buyer2 的一单(用于 404 边界)+ buyer1 作为【卖家】的一单(角色边界:不得出现在买家列表)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address)
  VALUES ('ord_b2','buyer2','seller1','prd_z','paid',10,10,10,'escrow','777 SECRET Ave')`).run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address)
  VALUES ('ord_sell','buyer2','buyer1','prd_w','paid',20,20,20,'escrow','555 SECRET Blvd')`).run()

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, humanId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'BA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const PII = /SECRET|Jane|Bob|6591234567|shipping_address|private NOTE|recipient/i
const rowsSnapshot = () => JSON.stringify(db.prepare('SELECT * FROM orders ORDER BY id').all())

mkGrant('grt_buyer', 'buyer1', 'gtk_buyer', ['buyer_orders_read_minimal'])
mkGrant('grt_noscope', 'buyer1', 'gtk_ns', ['read_public'])
// 非-grandfathering 钉死:模拟【本 PR 之前】铸出的 OAuth 'read' grant —— capabilities 是铸造时的 JSON 快照
//   (旧 read 集,不含 buyer_orders_read_minimal)。校验读的是存储快照而非按 coarse scope 动态推导,
//   所以旧 grant 绝不自动获得新能力 —— 若未来有人把校验改成动态推导,这条立刻红。
const OLD_READ_SET = ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal']
mkGrant('grt_oldread', 'buyer1', 'gtk_old', OLD_READ_SET)

const before = rowsSnapshot()
try {
  clearCred()
  ok('B-1 no grant → GRANT_REQUIRED', (await mcp.handleBuyerOrders({})).error_code === 'GRANT_REQUIRED')

  useCred('grt_buyer', 'gtk_buyer', ['buyer_orders_read_minimal'])
  { const r = await mcp.handleBuyerOrders({})   // list
    const orders = r.orders as Array<Record<string, unknown>> | undefined
    ok('B-2 list → exactly buyer1\'s 2 buyer orders (seller-side ord_sell EXCLUDED)', Array.isArray(orders) && orders.length === 2 && !orders.some(o => o.order_id === 'ord_sell'), JSON.stringify(r).slice(0, 300))
    const EXPECT = 'amount,deadline,item_ref,next_actor,order_id,payment_rail,status'
    ok('B-3 EVERY order = exactly 7 minimal keys (incl. payment_rail; no reshape/extra)',
      !!orders?.length && orders.every(o => Object.keys(o).sort().join(',') === EXPECT), orders?.map(o => Object.keys(o).sort().join(',')).join(' | '))
    ok('B-4 list output carries NO PII (address/notes/gift/recipient_code all absent)', !PII.test(JSON.stringify(r)))
    const rail = orders?.find(o => o.order_id === 'ord_b1b')?.payment_rail
    ok('B-5 payment_rail passes through (direct_p2p order labeled)', rail === 'direct_p2p', String(rail)) }
  { const r = await mcp.handleBuyerOrders({ order_id: 'ord_b1a' })   // single
    const o = r.order as Record<string, unknown> | undefined
    ok('B-6 single → minimal order (order_id/status/rail)', o?.order_id === 'ord_b1a' && o?.status === 'accepted' && o?.payment_rail === 'escrow')
    ok('B-7 single output carries NO PII', !PII.test(JSON.stringify(r))) }
  { const r = await mcp.handleBuyerOrders({ order_id: 'ord_b2' })   // 他人订单
    ok('B-8 another buyer\'s order → ORDER_NOT_FOUND (no existence oracle beyond 404)', r.error_code === 'ORDER_NOT_FOUND', JSON.stringify(r).slice(0, 200)) }
  { const r = await mcp.handleBuyerOrders({ order_id: 'ord_sell' })   // 自己是卖家的订单
    ok('B-9 own SELLER-side order → ORDER_NOT_FOUND on the buyer surface', r.error_code === 'ORDER_NOT_FOUND') }

  useCred('grt_noscope', 'gtk_ns', ['read_public'])
  { const r = await mcp.handleBuyerOrders({})
    ok('B-10 missing scope → PERMISSION_REQUIRED passthrough + hint + retry flag',
      r.error_code === 'PERMISSION_REQUIRED' && r.retry_after_approval === true && /buyer_orders_read_minimal/.test(String(r.hint)), JSON.stringify(r).slice(0, 200)) }

  useCred('grt_oldread', 'gtk_old', OLD_READ_SET)
  { const r = await mcp.handleBuyerOrders({})
    ok('B-11 NON-GRANDFATHERING: a pre-PR OAuth read grant (old capability snapshot) does NOT gain buyer read',
      r.error_code === 'PERMISSION_REQUIRED', JSON.stringify(r).slice(0, 200)) }

  ok('B-12 read-only: zero change to any order row', rowsSnapshot() === before)
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ buyer-orders-grant FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ buyer-orders-grant: minimal buyer read via real routes+grant — 7-key allowlist · zero PII · role boundary · read-only\n  ✅ pass ${pass}`)
