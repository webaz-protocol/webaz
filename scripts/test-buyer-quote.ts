#!/usr/bin/env tsx
/**
 * RFC-025 PR-3 — webaz_quote_order(OAuth-native · server 权威 · 整数分项 · 零 PII · 零经济执行)。
 *   用法:npm run test:buyer-quote
 *
 * 真实 ephemeral PWA(agent-grants 路由)+ 真实 grant + 真实 MCP wrapper,不桩被测组件。
 * 覆盖矩阵:A OAuth/隔离 · B PII · C Money · D G-QTY-1 · E 库存 · F 地址 · G 轨道 · H token · I 幂等。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-quote-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { verifyQuoteToken } = await import('../src/pwa/buyer-quote.js')
const { mulRate, toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }

const FULL_ADDR = 'Jane SECRET / 1 Test St #05-01 / Singapore SG / +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','holden_b','buyer','k_b',?, 'SG')").run(FULL_ADDR)
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer_noaddr','N','noaddr','buyer','k_n')").run()
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer2','B2','other','buyer','k_b2','9 Other Rd','SG')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
const insP = db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,shipping_template,free_shipping_threshold,has_variants,return_days,warranty_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
insP.run('prd_s', 'seller1', 'Simple Stand', 'd', 30, 'WAZ', 20, 'phone_stand', 'active', JSON.stringify([{ region: 'SG', fee: 5, est_days: '3-5' }]), null, 0, 7, 90)
insP.run('prd_low', 'seller1', 'Low Stock Stand', 'd', 30, 'WAZ', 2, 'phone_stand', 'active', null, null, 0, 7, null)
insP.run('prd_var', 'seller1', 'Variant Stand', 'd', 30, 'WAZ', 9, 'phone_stand', 'active', null, null, 1, 7, null)
insP.run('prd_paused', 'seller1', 'Paused Stand', 'd', 30, 'WAZ', 9, 'phone_stand', 'paused', null, null, 0, 7, null)
insP.run('prd_us', 'seller1', 'US Only Stand', 'd', 30, 'WAZ', 9, 'phone_stand', 'active', JSON.stringify([{ region: 'US', fee: 5, est_days: '5-9' }]), null, 0, 7, null)
db.prepare("INSERT INTO product_variants (id,product_id,sku,options_json,price_override,stock,is_active) VALUES ('var_1','prd_var','SKU1','{\"色\":\"黑\"}',40,3,1)").run()

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
let PLATFORM_BLOCKLIST = '[]'
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true, getProtocolParam: <T>(key: string, fallback: T): T => (key === 'trade.platform_region_blocklist' ? PLATFORM_BLOCKLIST as unknown as T : fallback) })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, humanId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'QA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const PII = /SECRET|Jane|91234567|1 Test St|#05-01|default_address|shipping_address/i
const quoteRows = () => db.prepare('SELECT * FROM order_quotes ORDER BY created_at, id').all() as Array<Record<string, unknown>>
const stockOf = (id: string) => (db.prepare('SELECT stock FROM products WHERE id=?').get(id) as { stock: number }).stock
const Q = (a: Record<string, unknown>) => (mcp as unknown as { handleQuoteOrder: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleQuoteOrder(a)

mkGrant('grt_q', 'buyer1', 'gtk_q', ['price_quote'])
mkGrant('grt_ns', 'buyer1', 'gtk_ns', ['read_public'])
mkGrant('grt_q2', 'buyer2', 'gtk_q2', ['price_quote'])
mkGrant('grt_na', 'buyer_noaddr', 'gtk_na', ['price_quote'])
// 非-grandfathering:PR-3 之前铸的 order:draft 快照(无 price_quote)
mkGrant('grt_old', 'buyer1', 'gtk_old', ['draft_order', 'order_action_request'])

try {
  // ══ A. OAuth 与隔离 ══
  clearCred()
  ok('A-1 no grant → GRANT_REQUIRED', (await Q({ product_id: 'prd_s' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_ns', 'gtk_ns', ['read_public'])
  ok('A-2 missing scope → PERMISSION_REQUIRED + hint', await Q({ product_id: 'prd_s' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /price_quote/.test(String(r.hint))))
  useCred('grt_old', 'gtk_old', ['draft_order', 'order_action_request'])
  ok('A-3 NON-GRANDFATHERING: pre-PR order:draft snapshot grant lacks price_quote', (await Q({ product_id: 'prd_s' })).error_code === 'PERMISSION_REQUIRED')

  useCred('grt_q', 'gtk_q', ['price_quote'])
  const q1 = await Q({ product_id: 'prd_s', quantity: 2, idempotency_key: 'k1' })
  ok('A-4 quote succeeds with price_quote scope', typeof q1.quote_id === 'string' && typeof q1.quote_token === 'string', JSON.stringify(q1).slice(0, 300))
  ok('A-5 acting_as from SERVER-side subject (grant human), not client input', q1.acting_as === '@holden_b' && String(q1.account_id_hint).includes('…'))
  { const r = await Q({ product_id: 'prd_s', human_id: 'buyer2', account_id: 'buyer2' } as Record<string, unknown>)
    ok('A-6 agent-supplied human_id/account ignored (subject stays the grant human)', r.acting_as === '@holden_b' || typeof r.error_code === 'string') }

  // ══ B. PII ══
  ok('B-1 success response carries NO full address / PII', !PII.test(JSON.stringify(q1)), JSON.stringify(q1).slice(0, 400))
  ok('B-2 destination = region-only summary', String((q1.destination as Record<string, unknown>).address_summary).startsWith('Default address ·') && (q1.destination as Record<string, unknown>).region === 'SG')
  ok('B-3 order_quotes DB row carries NO PII (address bound by sha256 only)', !PII.test(JSON.stringify(quoteRows())), JSON.stringify(quoteRows()[0]).slice(0, 300))
  { useCred('grt_na', 'gtk_na', ['price_quote'])
    const r = await Q({ product_id: 'prd_s' })
    // 内容级 PII 正则(不含字段名):错误文案合法提及 webaz_default_address 工具名,字段名正则会误报
    ok('B-4 DEFAULT_ADDRESS_REQUIRED error carries NO address CONTENT + safe next step', r.error_code === 'DEFAULT_ADDRESS_REQUIRED' && !/SECRET|Jane|91234567|1 Test St|#05-01|9 Other Rd/i.test(JSON.stringify(r)) && JSON.stringify(r.next_steps ?? []).includes('change_address_in_pwa'), JSON.stringify(r).slice(0, 250))
    useCred('grt_q', 'gtk_q', ['price_quote']) }

  // ══ C. Money(整数 · 分项=total · 服务器断言) ══
  { const lines = q1.line_items as Array<Record<string, unknown>>
    ok('C-1 every amount is a safe integer', lines.every(l => Number.isSafeInteger(l.amount_minor)) && Number.isSafeInteger((q1.total as Record<string, unknown>).amount_minor as number))
    const sum = lines.filter(l => l.included_in_total).reduce((a, l) => a + Number(l.amount_minor), 0)
    ok('C-2 total == sum(included line items)', sum === Number((q1.total as Record<string, unknown>).amount_minor))
    const item = lines.find(l => l.code === 'item_subtotal')!, ship = lines.find(l => l.code === 'shipping')!
    ok('C-3 qty=2 doubles item subtotal (2×30 WAZ = 60e6 units) + shipping 5 WAZ', Number(item.amount_minor) === toUnits(60) && Number(ship.amount_minor) === toUnits(5))
    ok('C-4 estimated_tax marked estimated + excluded from total (S0-S6 posture)', lines.find(l => l.code === 'estimated_tax')?.estimated === true && lines.find(l => l.code === 'estimated_tax')?.included_in_total === false)
    ok('C-5 currency/exponent consistent (WAZ, 6)', lines.every(l => l.currency === 'WAZ' && l.currency_exponent === 6)) }
  { const qd = await Q({ product_id: 'prd_s', quantity: 2, donation_bps: 100, idempotency_key: 'kdon' })
    const don = (qd.line_items as Array<Record<string, unknown>>).find(l => l.code === 'donation')!
    const expected = mulRate(toUnits(65), 0.01)
    ok('C-6 donation = mulRate(total, bps/10000) — SAME helper as order creation', Number(don.amount_minor) === expected && don.included_in_total === false)
    ok('C-7 payable_total = total + donation', Number((qd.payable_total as Record<string, unknown>).amount_minor) === toUnits(65) + expected) }

  // ══ D. G-QTY-1 ══
  for (const [name, qty] of [['zero', 0], ['negative', -1], ['decimal', 1.5], ['string "2"', '2'], ['NaN', NaN], ['Infinity', Infinity]] as const) {
    const r = await Q({ product_id: 'prd_s', quantity: qty as unknown })
    ok(`D-1 quantity ${name} → INVALID_QUANTITY (no implicit conversion)`, r.error_code === 'INVALID_QUANTITY', JSON.stringify(r).slice(0, 150))
  }
  ok('D-2 quantity > stock → INSUFFICIENT_STOCK', (await Q({ product_id: 'prd_low', quantity: 3 })).error_code === 'INSUFFICIENT_STOCK')
  ok('D-3 quantity > MAX_PER_ORDER(10) → PURCHASE_LIMIT_EXCEEDED', (await Q({ product_id: 'prd_s', quantity: 11 })).error_code === 'PURCHASE_LIMIT_EXCEEDED')
  { const q3 = await Q({ product_id: 'prd_s', quantity: 3, idempotency_key: 'k3' })
    const item = (q3.line_items as Array<Record<string, unknown>>).find(l => l.code === 'item_subtotal')!
    ok('D-4 qty=3: subtotal/total/snapshot all use the SAME validated quantity', Number(item.amount_minor) === toUnits(90) && (q3.quantity as Record<string, unknown>).quoted === 3
      && Number(quoteRows().find(r => r.id === q3.quote_id)?.quantity) === 3) }
  { const v = verifyQuoteToken(db, q1.quote_token, 'buyer1')
    ok('D-5 verifyQuoteToken returns the SERVER row snapshot (quantity=2 as quoted) — client-side copies are irrelevant; PR-4 consumer will enforce snapshot consistency + one-shot', v.ok === true && Number((v as { quote: Record<string, unknown> }).quote.quantity) === 2 && String((v as { quote: Record<string, unknown> }).quote.total_units) === String(quoteRows().find(r => r.id === q1.quote_id)?.total_units)) }
  // orders-create 侧的真修:源守卫(集成测试属钱路套件;此处锁住绑定存在 + 错误码)
  const OC = (await import('node:fs')).readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  ok('D-6 orders-create binds session quantity at consumption (PRICE_SESSION_QTY_MISMATCH)', /PRICE_SESSION_QTY_MISMATCH/.test(OC) && /session\.quantity \?\? 1\) !== reqQty/.test(OC))

  // ══ E. 库存 ══
  ok('E-1 quote does NOT change stock', stockOf('prd_s') === 20)
  ok('E-2 stock_reserved=false + honest note', q1.stock_reserved === false && /re-checked/.test(String(q1.stock_note)))
  ok('E-3 economic_action_executed=false', q1.economic_action_executed === false)

  // ══ F. 地址/配送 ══
  ok('F-1 region-covered template → shipping fee quoted', (q1.shipping as Record<string, unknown>).supported === true)
  ok('F-2 template not covering buyer region → SHIPPING_NOT_SUPPORTED + next_steps', await Q({ product_id: 'prd_us' }).then(r => r.error_code === 'SHIPPING_NOT_SUPPORTED' && JSON.stringify(r.next_steps ?? []).includes('choose_another_offer')))
  ok('F-3 paused product → PRODUCT_NOT_ACTIVE', (await Q({ product_id: 'prd_paused' })).error_code === 'PRODUCT_NOT_ACTIVE')
  ok('F-4 unknown product → PRODUCT_NOT_FOUND', (await Q({ product_id: 'prd_nope' })).error_code === 'PRODUCT_NOT_FOUND')
  ok('F-5 variant product without variant_id → VARIANT_REQUIRED', (await Q({ product_id: 'prd_var' })).error_code === 'VARIANT_REQUIRED')
  { const r = await Q({ product_id: 'prd_var', variant_id: 'var_1', quantity: 2, idempotency_key: 'kv' })
    const item = (r.line_items as Array<Record<string, unknown>>).find(l => l.code === 'item_subtotal')!
    ok('F-6 variant price_override used (2×40)', Number(item.amount_minor) === toUnits(80))
    ok('F-7 variant stock governs (qty 4 > 3)', (await Q({ product_id: 'prd_var', variant_id: 'var_1', quantity: 4 })).error_code === 'INSUFFICIENT_STOCK') }
  ok('F-8 address_source other than default → structured refusal', (await Q({ product_id: 'prd_s', address_source: 'ref:abc' })).error_code === 'ADDRESS_NOT_RESOLVABLE')

  // ══ G. 支付轨道 ══
  ok('G-1 escrow custodied_by_webaz=true + no charge note', (q1.payment as Record<string, unknown>).custodied_by_webaz === true && /charges nothing/.test(String((q1.payment as Record<string, unknown>).note)))
  ok('G-2 disabled rail (psp) → PAYMENT_RAIL_DISABLED', (await Q({ product_id: 'prd_s', payment_rail: 'psp' })).error_code === 'PAYMENT_RAIL_DISABLED')
  { const r = await Q({ product_id: 'prd_s', payment_rail: 'direct_p2p' })
    ok('G-3 direct_p2p ineligible (fresh fixture: controls fail-closed) → structured error, NEVER silent escrow switch',
      typeof r.error_code === 'string' && r.error_code !== 'PAYMENT_RAIL_DISABLED' && r.quote_token === undefined && JSON.stringify(r.next_steps ?? []).includes('escrow'), JSON.stringify(r).slice(0, 250)) }
  ok('G-4 receive account on escrow → DIRECT_RECEIVE_ACCOUNT_INVALID', (await Q({ product_id: 'prd_s', direct_receive_account_id: 'dra_x' })).error_code === 'DIRECT_RECEIVE_ACCOUNT_INVALID')

  // ══ C+. 与建单的价格平价:限时价覆盖(BLOCKER-1)+ 平台合规 overlay(BLOCKER-2) ══
  { db.prepare("INSERT INTO flash_sales (id, product_id, seller_id, sale_price, original_price, starts_at, ends_at, is_active, max_qty, sold_count) VALUES ('fs1','prd_low','seller1',20,30,datetime('now','-1 hour'),datetime('now','+1 hour'),1,0,0)").run()
    const r = await Q({ product_id: 'prd_low', quantity: 1, idempotency_key: 'kflash' })
    const item = (r.line_items as Array<Record<string, unknown>>).find(l => l.code === 'item_subtotal')!
    ok('P-1 flash-sale price overrides (20 not 30) — same getActiveFlashSale as order creation', Number(item.amount_minor) === toUnits(20), JSON.stringify(r).slice(0, 250))
    const rp = await Q({ product_id: 'prd_low', payment_rail: 'direct_p2p' })
    ok('P-2 direct_p2p + active flash → FLASH-SPECIFIC refusal (before launch controls; creation rejects flashActive), NOT silently quoted',
      rp.error_code === 'DIRECT_PAY_NOT_ELIGIBLE' && /flash/i.test(String(rp.reason)) && rp.quote_token === undefined, JSON.stringify(rp).slice(0, 200))
    db.prepare("DELETE FROM flash_sales WHERE id='fs1'").run() }
  { PLATFORM_BLOCKLIST = '["SG"]'
    const r = await Q({ product_id: 'prd_s', quantity: 1 })
    ok('P-3 platform region blocklist enforced (SG blocked → SHIPPING_NOT_SUPPORTED)', r.error_code === 'SHIPPING_NOT_SUPPORTED', JSON.stringify(r).slice(0, 200))
    PLATFORM_BLOCKLIST = 'not-json'
    const r2 = await Q({ product_id: 'prd_s', quantity: 1 })
    ok('P-4 malformed platform policy → fail-closed (same rule as order creation)', r2.error_code === 'QUOTE_CALCULATION_FAILED')
    PLATFORM_BLOCKLIST = '[]' }

  // ══ H. Token ══
  { const v = verifyQuoteToken(db, q1.quote_token, 'buyer1')
    ok('H-1 token verifies for its subject', v.ok === true) }
  ok('H-2 tampered token fails', verifyQuoteToken(db, String(q1.quote_token).slice(0, -2) + 'zz', 'buyer1').ok === false)
  ok('H-3 cross-subject use fails (same code as invalid — no existence oracle)', (verifyQuoteToken(db, q1.quote_token, 'buyer2') as { error_code?: string }).error_code === 'QUOTE_TOKEN_INVALID')
  { db.prepare('UPDATE order_quotes SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', String(q1.quote_id))
    ok('H-4 expired token → TOKEN_EXPIRED', (verifyQuoteToken(db, q1.quote_token, 'buyer1') as { error_code?: string }).error_code === 'TOKEN_EXPIRED')
    db.prepare('UPDATE order_quotes SET expires_at = ? WHERE id = ?').run(new Date(Date.now() + 600_000).toISOString(), String(q1.quote_id)) }
  ok('H-5 raw token never stored (DB has hash only)', quoteRows().every(r => !JSON.stringify(r).includes(String(q1.quote_token))))

  // ══ I. 幂等 ══
  { const before = quoteRows().length
    const again = await Q({ product_id: 'prd_s', quantity: 2, idempotency_key: 'k1' })
    ok('I-1 same subject+key+payload → SAME quote, no new row, token not re-shown', again.quote_id === q1.quote_id && quoteRows().length === before && again.quote_token === undefined && typeof again.quote_token_note === 'string')
    const conflict = await Q({ product_id: 'prd_s', quantity: 3, idempotency_key: 'k1' })
    ok('I-2 same key + DIFFERENT payload → IDEMPOTENCY_CONFLICT', conflict.error_code === 'IDEMPOTENCY_CONFLICT')
    useCred('grt_q2', 'gtk_q2', ['price_quote'])
    const other = await Q({ product_id: 'prd_s', quantity: 2, idempotency_key: 'k1' })
    ok('I-3 different subject reuses the same client key independently', typeof other.quote_id === 'string' && other.quote_id !== q1.quote_id)
    ok('I-4 retries created no extra economic objects (only quote snapshots; stock untouched)', stockOf('prd_s') === 20)
    useCred('grt_q', 'gtk_q', ['price_quote'])
    for (const [nm, key] of [['email', 'a@b.co'], ['phone', '+65 9123 4567'], ['free text', 'call me later!']] as const) {
      const before2 = quoteRows().length
      const r = await Q({ product_id: 'prd_s', idempotency_key: key })
      ok(`I-5 PII-shaped idempotency_key rejected + unstored (${nm})`, r.error_code === 'IDEMPOTENCY_KEY_INVALID' && quoteRows().length === before2, JSON.stringify(r).slice(0, 150))
    } }
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ buyer-quote FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ buyer-quote: OAuth-native 整数分项报价 — subject 绑定 · 零 PII · G-QTY-1 · 零经济执行 · token 不可篡改 · 幂等\n  ✅ pass ${pass}`)
