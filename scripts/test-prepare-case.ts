#!/usr/bin/env tsx
/**
 * RFC-025 PR-6 — webaz_prepare_case(售后案件草稿组装,纯只读)。用法:npm run test:prepare-case
 *
 * 真实 route + 真实 grant。覆盖:本人订单事实包(时间线结构字段/商品声明锚点/证据 ref/分流指引)·
 * 零 PII(notes/evidence 描述/地址全不出)· 零写入(全库快照不变)· 隔离(他人订单 404)·
 * 缺 scope PERMISSION_REQUIRED · 非-grandfathering。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-case-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
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

const PII_NOTE = 'buyer lives at 1 SECRET St, call +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer1','B','holden_b','buyer','k_b'),('buyer2','B2','o','buyer','k_b2'),('seller1','S','sell_h','seller','k_s')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days,warranty_days,commitment_hash) VALUES ('prd_s','seller1','Anchor Stand','d',30,'WAZ',9,'x','active',7,90,'cmh_abc')`).run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,notes) VALUES ('ord_1','buyer1','seller1','prd_s','delivered',1,30,30,30,'escrow','1 SECRET St #05-01 Jane +65 91234567','gift note SECRET')`).run()
db.prepare(`INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,notes) VALUES ('h1','ord_1','created','paid','buyer1','buyer',?)`).run(PII_NOTE)
db.prepare(`INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,notes) VALUES ('h2','ord_1','paid','delivered','seller1','seller','shipped fast')`).run()
db.prepare(`INSERT INTO evidence (id,order_id,uploader_id,type,description) VALUES ('ev1','ord_1','seller1','shipping_proof',?)`).run('receipt shows ' + PII_NOTE)
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address) VALUES ('ord_other','buyer2','seller1','prd_s','paid',1,30,30,30,'escrow','9 Other Rd')`).run()

const auth = (_req: Request, res: Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (g: string, h: string, b: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(g, h, 'CA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(b), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (g: string, b: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [g]: { token: b, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: g, handle: `file:~/.webaz/credentials#${g}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const PII = /SECRET|91234567|#05-01|Jane|gift note|1 SECRET St/i
const C = (a: Record<string, unknown>) => (mcp as unknown as { handlePrepareCase: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handlePrepareCase(a)
const dbSnapshot = () => JSON.stringify({ o: db.prepare('SELECT COUNT(*) c FROM orders').get(), h: db.prepare('SELECT COUNT(*) c FROM order_state_history').get(), e: db.prepare('SELECT COUNT(*) c FROM evidence').get(), d: db.prepare('SELECT COUNT(*) c FROM disputes').get() })

mkGrant('grt_c', 'buyer1', 'gtk_c', ['buyer_case_prepare'])
mkGrant('grt_ns', 'buyer1', 'gtk_ns', ['read_public'])
mkGrant('grt_old', 'buyer1', 'gtk_old', ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal', 'buyer_orders_read_minimal', 'buyer_discover'])

const before = dbSnapshot()
try {
  clearCred()
  ok('C-1 no grant → GRANT_REQUIRED', (await C({ order_id: 'ord_1' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_ns', 'gtk_ns', ['read_public'])
  ok('C-2 missing scope → PERMISSION_REQUIRED + hint', await C({ order_id: 'ord_1' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /buyer_case_prepare/.test(String(r.hint))))
  useCred('grt_old', 'gtk_old', ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal', 'buyer_orders_read_minimal', 'buyer_discover'])
  ok('C-3 NON-GRANDFATHERING: pre-PR read snapshot lacks buyer_case_prepare', (await C({ order_id: 'ord_1' })).error_code === 'PERMISSION_REQUIRED')

  useCred('grt_c', 'gtk_c', ['buyer_case_prepare'])
  const r = await C({ order_id: 'ord_1' })
  ok('C-4 case draft assembled (timeline + claims + evidence refs + routing guide)', r.case_draft === true
    && Array.isArray(r.timeline) && (r.timeline as unknown[]).length === 2
    && (r.original_claims as Record<string, unknown>)?.commitment_hash === 'cmh_abc'
    && Array.isArray(r.evidence_refs) && (r.evidence_refs as unknown[]).length === 1
    && /DELIVERY DISPUTE/.test(String((r.routing_guide as Record<string, unknown>)?.delivery_problem)), JSON.stringify(r).slice(0, 400))
  ok('C-5 timeline = structural fields only (from/to/actor_role/at)', (r.timeline as Array<Record<string, unknown>>).every(t2 => JSON.stringify(Object.keys(t2).sort()) === JSON.stringify(['actor_role', 'at', 'from', 'to'])))
  ok('C-6 evidence refs = id/type/at only (descriptions withheld)', (r.evidence_refs as Array<Record<string, unknown>>).every(e => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['at', 'evidence_ref', 'type'])))
  ok('C-7 ZERO PII (address / PII-laden notes / evidence descriptions all absent)', !PII.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 300))
  ok('C-8 honest posture flags (read-only, human submits on the order page)', r.economic_action_executed === false && /submits anything|Nothing here submits/i.test(JSON.stringify(r.routing_guide)))
  ok('C-9 another buyer\'s order → ORDER_NOT_FOUND', (await C({ order_id: 'ord_other' })).error_code === 'ORDER_NOT_FOUND')
  ok('C-10 unknown order → ORDER_NOT_FOUND', (await C({ order_id: 'ord_nope' })).error_code === 'ORDER_NOT_FOUND')
  ok('C-11 READ-ONLY: zero DB change across the whole suite', dbSnapshot() === before)
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ prepare-case FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ prepare-case: 售后案件草稿 — 结构化事实包 · 零 PII · 零写入 · 隔离 · 分流指引 · 人路径归人\n  ✅ pass ${pass}`)
