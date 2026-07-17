#!/usr/bin/env tsx
/**
 * RFC-025 PR-6 — webaz_prepare_case(售后案件草稿组装,纯读)。用法:npm run test:prepare-case
 *
 * 真实 route + 真实 grant。覆盖:本人订单事实包(时间线结构字段/订单时刻条款快照/当前商品锚点/
 * 证据 ref/两级分流指引)· 无买家 PII(notes/evidence 描述/地址/卖家自由文本条款全不出;
 * evidence.type allowlist 归一化)· 快照权威(商品行事后改动不冒充原始承诺)· 全库内容级
 * 零域写(审计表显式豁免且必须增长)· 隔离(他人订单 404)· 全响应投影 key 锁 · 非-grandfathering。
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
// 下单时刻冻结的条款快照:return_days=7 —— 商品行故意写成 14(卖家事后改过),证明快照赢
const SNAP = JSON.stringify({ v: 1, captured_at: '2026-07-01T00:00:00Z',
  shipping: { source: 'template', region: 'SG', fee: 0, est_days: '3-5' },
  fulfilment: { handling_hours: 24, estimated_days: '3-5', return_days: 7, return_condition: 'unopened only, ship back to 1 SECRET St', warranty_days: 90 },
  logistics: { weight_kg: null, package_size: null, origin_country: null, country_of_origin: null, customs_description: null, hs_code: null },
  declarations: { ship_regions_text: null, sale_regions_rule: null, tax_lines: null, import_duty_terms: 'ddp' }, accept_mode: 'auto' })
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer1','B','holden_b','buyer','k_b'),('buyer2','B2','o','buyer','k_b2'),('seller1','S','sell_h','seller','k_s')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days,warranty_days,commitment_hash) VALUES ('prd_s','seller1','Anchor Stand','d',30,'WAZ',9,'x','active',14,90,'cmh_abc')`).run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,notes,trade_terms_snapshot) VALUES ('ord_1','buyer1','seller1','prd_s','delivered',1,30,30,30,'escrow','1 SECRET St #05-01 Jane +65 91234567','gift note SECRET',?)`).run(SNAP)
db.prepare(`INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,notes) VALUES ('h1','ord_1','created','paid','buyer1','buyer',?)`).run(PII_NOTE)
db.prepare(`INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,notes) VALUES ('h2','ord_1','paid','delivered','seller1','seller','shipped fast')`).run()
// ev1 的 type 本身就是 PII 走私载体(add-evidence 不校验 type)→ 必须归一化为 'other'
db.prepare(`INSERT INTO evidence (id,order_id,uploader_id,type,description) VALUES ('ev1','ord_1','seller1',?,?)`).run('receipt at 1 SECRET St +65 91234567', 'receipt shows ' + PII_NOTE)
db.prepare(`INSERT INTO evidence (id,order_id,uploader_id,type,description) VALUES ('ev2','ord_1','buyer1','image','photo of ' + '1 SECRET St')`).run()
db.prepare(`INSERT INTO disputes (id,order_id,initiator_id,reason,status) VALUES ('dsp_1','ord_1','buyer1',?,'open')`).run('never arrived; I live at 1 SECRET St')
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address) VALUES ('ord_other','buyer2','seller1','prd_s','paid',1,30,30,30,'escrow','9 Other Rd')`).run()
// ord_bad:残缺 v1 快照({"v":1},readTradeTermsSnapshot 会放行)+ 商品已不存在 + 无争议 → null/unavailable 变体
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,trade_terms_snapshot) VALUES ('ord_bad','buyer1','seller1','prd_gone','paid',1,5,5,5,'escrow','x','{"v":1}')`).run()

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
const PII = /SECRET|91234567|#05-01|Jane|gift note|never arrived|unopened|receipt at|shipped fast/i
const C = (a: Record<string, unknown>) => (mcp as unknown as { handlePrepareCase: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handlePrepareCase(a)
const keysOf = (o: unknown) => JSON.stringify(Object.keys(o as Record<string, unknown>).sort())
const K = (...ks: string[]) => JSON.stringify([...ks].sort())
// 全库内容级快照:每张用户表的整表内容哈希。唯一豁免 = agent_grant_auth_log(RFC-020 §3.7:
// 每个 grant 请求都记审计,append-only —— 豁免必须显式且用 C-12 证明它真的在长,不是静默漏掉)
const dbSnapshot = (): string => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'agent_grant_auth_log' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
  return sha(JSON.stringify(tables.map(t => [t, sha(JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()))])))
}
const auditCount = (): number => (db.prepare('SELECT COUNT(*) c FROM agent_grant_auth_log').get() as { c: number }).c

mkGrant('grt_c', 'buyer1', 'gtk_c', ['buyer_case_prepare'])
mkGrant('grt_ns', 'buyer1', 'gtk_ns', ['read_public'])
mkGrant('grt_old', 'buyer1', 'gtk_old', ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal', 'buyer_orders_read_minimal', 'buyer_discover'])

const before = dbSnapshot(); const auditBefore = auditCount()
try {
  clearCred()
  ok('C-1 no grant → GRANT_REQUIRED', (await C({ order_id: 'ord_1' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_ns', 'gtk_ns', ['read_public'])
  ok('C-2 missing scope → PERMISSION_REQUIRED + hint', await C({ order_id: 'ord_1' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /buyer_case_prepare/.test(String(r.hint))))
  useCred('grt_old', 'gtk_old', ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal', 'buyer_orders_read_minimal', 'buyer_discover'])
  ok('C-3 NON-GRANDFATHERING: pre-PR read snapshot lacks buyer_case_prepare', (await C({ order_id: 'ord_1' })).error_code === 'PERMISSION_REQUIRED')

  useCred('grt_c', 'gtk_c', ['buyer_case_prepare'])
  const r = await C({ order_id: 'ord_1' })
  ok('C-4 case draft assembled (timeline + order-time terms + current listing + evidence + dispute + two-tier routing)', r.case_draft === true
    && Array.isArray(r.timeline) && (r.timeline as unknown[]).length === 2
    && (r.current_listing as Record<string, unknown>)?.commitment_hash === 'cmh_abc'
    && Array.isArray(r.evidence_refs) && (r.evidence_refs as unknown[]).length === 2
    && (r.existing_dispute as Record<string, unknown>)?.dispute_id === 'dsp_1'
    && /DELIVERY DISPUTE/.test(String((r.routing_guide as Record<string, unknown>)?.delivery_problem))
    && /10 WAZ.*48h.*3 verifiers/.test(String((r.routing_guide as Record<string, unknown>)?.claim_problem_order))
    && /5 WAZ.*72h.*3 verifiers/.test(String((r.routing_guide as Record<string, unknown>)?.claim_problem_listing)), JSON.stringify(r).slice(0, 400))
  const ott = r.order_time_terms as Record<string, unknown>
  ok('C-5 SNAPSHOT AUTHORITY: order-time terms from frozen snapshot (return_days=7), NOT the seller-edited product row (14)',
    ott?.source === 'order_snapshot' && ott?.return_days === 7 && ott?.warranty_days === 90 && ott?.import_duty_terms === 'ddp'
    && /CURRENT listing/.test(String((r.current_listing as Record<string, unknown>)?.note)), JSON.stringify(ott))
  ok('C-6 PROJECTION LOCKS: exact keys on every response section (timeline / evidence / order / terms / listing / dispute / top level)',
    (r.timeline as Array<Record<string, unknown>>).every(t2 => keysOf(t2) === K('actor_role', 'at', 'from', 'to'))
    && (r.evidence_refs as Array<Record<string, unknown>>).every(e => keysOf(e) === K('at', 'evidence_ref', 'type'))
    && keysOf(r.order) === K('order_id', 'status', 'payment_rail', 'quantity', 'amount', 'created_at', 'item_ref', 'seller_id_hint')
    && keysOf(ott) === K('source', 'captured_at', 'return_days', 'warranty_days', 'handling_hours', 'import_duty_terms', 'note')
    && keysOf(r.current_listing) === K('title', 'commitment_hash', 'description_hash', 'price_hash', 'hashed_at', 'note')
    && keysOf(r.existing_dispute) === K('dispute_id', 'status', 'type', 'at')
    && keysOf(r.routing_guide) === K('delivery_problem', 'claim_problem_order', 'claim_problem_listing', 'note')
    && keysOf(r) === K('case_draft', 'order', 'timeline', 'order_time_terms', 'current_listing', 'evidence_refs', 'existing_dispute', 'routing_guide', 'detail_note', 'economic_action_executed'), keysOf(r))
  ok('C-7 evidence.type NORMALIZED: PII-laden free-text type → other; allowlisted type passes through',
    (r.evidence_refs as Array<Record<string, unknown>>).map(e => e.type).sort().join(',') === 'image,other')
  ok('C-8 ZERO buyer PII (addresses / notes / evidence descriptions / dispute reason / seller free-text terms all absent)', !PII.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 300))
  ok('C-9 honest posture flags (no economic action, human submits on the order page)', r.economic_action_executed === false && /Nothing here submits/i.test(JSON.stringify(r.routing_guide)))
  ok('C-10 another buyer\'s order → ORDER_NOT_FOUND', (await C({ order_id: 'ord_other' })).error_code === 'ORDER_NOT_FOUND')
  ok('C-11 unknown order → ORDER_NOT_FOUND', (await C({ order_id: 'ord_nope' })).error_code === 'ORDER_NOT_FOUND')
  const rb = await C({ order_id: 'ord_bad' })
  ok('C-13 malformed {"v":1} snapshot + missing product → NO crash; unavailable variant + null sections locked',
    rb.case_draft === true
    && (rb.order_time_terms as Record<string, unknown>)?.source === 'unavailable'
    && keysOf(rb.order_time_terms) === K('source', 'note')
    && rb.current_listing === null && rb.existing_dispute === null
    && keysOf(rb) === K('case_draft', 'order', 'timeline', 'order_time_terms', 'current_listing', 'evidence_refs', 'existing_dispute', 'routing_guide', 'detail_note', 'economic_action_executed'), JSON.stringify(rb).slice(0, 300))
  ok('C-12 whole-DB content unchanged (every table hashed; sole exemption agent_grant_auth_log, which MUST have grown — audit is real)',
    dbSnapshot() === before && auditCount() > auditBefore, `audit ${auditBefore}→${auditCount()}`)
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ prepare-case FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ prepare-case: 售后案件草稿 — 快照权威 · 投影全锁 · 无买家 PII · 内容级零域写 · 隔离 · 两级分流 · 人路径归人\n  ✅ pass ${pass}`)
