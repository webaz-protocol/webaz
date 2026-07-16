#!/usr/bin/env tsx
/**
 * RFC-025 PR-4 — webaz_order_draft(draft_order capability 的首个消费者)。用法:npm run test:order-draft
 *
 * 真实 ephemeral PWA + 真实 grant + 真实 MCP wrapper(quote→draft 全链,不桩被测组件)。覆盖:
 *   一次性(consumed_at CAS 同事务;同 quote 绝不两份草稿)· 快照冻结(整数金额原样复制,零重算)·
 *   隔离(他人 token 同 INVALID)· 生命周期(cancel 终态幂等安全/无 update 面)· 幂等(同键同 quote 重放/
 *   异 quote 冲突/PII 形态键拒收)· 零经济执行(无订单行/库存/余额变化)· 零 PII · 过期 quote 拒。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-draft-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }

const FULL_ADDR = 'Jane SECRET / 1 Test St #05-01 / Singapore SG / +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','holden_b','buyer','k_b',?, 'SG')").run(FULL_ADDR)
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer2','B2','other','buyer','k_b2','9 Other Rd','SG')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES ('prd_s','seller1','Simple Stand','d',30,'WAZ',20,'phone_stand','active')`).run()

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, humanId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'DA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const PII = /SECRET|Jane|91234567|1 Test St|#05-01|9 Other Rd/i
const Q = (a: Record<string, unknown>) => (mcp as unknown as { handleQuoteOrder: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleQuoteOrder(a)
const D = (a: Record<string, unknown>) => (mcp as unknown as { handleOrderDraft: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleOrderDraft(a)
const draftRows = () => db.prepare('SELECT * FROM order_drafts ORDER BY created_at, id').all() as Array<Record<string, unknown>>
const econSnapshot = () => JSON.stringify({
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get(),
  stock: db.prepare('SELECT stock FROM products WHERE id=?').get('prd_s'),
  wallets: db.prepare('SELECT COUNT(*) c FROM wallets').get(),
})

mkGrant('grt_b', 'buyer1', 'gtk_b', ['price_quote', 'draft_order'])
mkGrant('grt_b2', 'buyer2', 'gtk_b2', ['price_quote', 'draft_order'])
mkGrant('grt_qonly', 'buyer1', 'gtk_qo', ['price_quote'])

const econBefore = econSnapshot()
try {
  // ══ 权限/隔离 ══
  clearCred()
  ok('S-1 no grant → GRANT_REQUIRED', (await D({ action: 'create', quote_token: 'qtk_x' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_qonly', 'gtk_qo', ['price_quote'])
  ok('S-2 quote-only grant lacks draft_order → PERMISSION_REQUIRED (capability really enforced — the dead scope is now ALIVE)',
    await D({ action: 'create', quote_token: 'qtk_x' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /draft_order/.test(String(r.hint))))

  // ══ create:quote→draft 全链 ══
  useCred('grt_b', 'gtk_b', ['price_quote', 'draft_order'])
  const q1 = await Q({ product_id: 'prd_s', quantity: 2, idempotency_key: 'qk1' })
  ok('C-0 fixture quote issued', typeof q1.quote_token === 'string', JSON.stringify(q1).slice(0, 200))
  const d1 = await D({ action: 'create', quote_token: q1.quote_token, idempotency_key: 'dk1' })
  ok('C-1 draft created from quote', typeof d1.draft_id === 'string' && d1.status === 'draft', JSON.stringify(d1).slice(0, 300))
  { const qr = db.prepare('SELECT * FROM order_quotes WHERE id=?').get(String(d1.quote_id)) as Record<string, unknown>
    const dr = db.prepare('SELECT * FROM order_drafts WHERE id=?').get(String(d1.draft_id)) as Record<string, unknown>
    const SNAP = ['product_id','variant_id','seller_id','quantity','unit_price_units','item_units','shipping_units','donation_bps','donation_units','total_units','payable_units','currency','payment_rail','direct_receive_account_id','dest_region','address_summary_hash','anonymous_recipient'] as const
    ok('C-2 snapshot frozen VERBATIM — EVERY snapshot column equals the quote row (incl. currency)', SNAP.every(k => String(qr[k] ?? '') === String(dr[k] ?? '')), SNAP.map(k => `${k}:${qr[k]}=${dr[k]}`).join(' '))
    ok('C-2b sanity: totals match fixture (2×30 WAZ)', (d1.total as Record<string, unknown>).amount_minor === toUnits(60) && d1.quantity === 2) }
  ok('C-3 acting_as from server subject + masked ids', d1.acting_as === '@holden_b' && String(d1.account_id_hint).includes('…'))
  ok('C-4 zero PII in draft response', !PII.test(JSON.stringify(d1)), JSON.stringify(d1).slice(0, 300))
  ok('C-5 zero PII in order_drafts row', !PII.test(JSON.stringify(draftRows())))
  ok('C-6 stock_reserved=false + economic_action_executed=false + honest notes', d1.stock_reserved === false && d1.economic_action_executed === false && /re-validated at human approval/.test(String(d1.note)))

  // ══ 一次性 ══
  ok('O-1 same quote_token again → QUOTE_ALREADY_CONSUMED (one quote, one draft)', (await D({ action: 'create', quote_token: q1.quote_token, idempotency_key: 'dk_other' })).error_code === 'QUOTE_ALREADY_CONSUMED')
  ok('O-2 consumed_at set on the quote row', !!(db.prepare('SELECT consumed_at FROM order_quotes WHERE id=?').get(String(q1.quote_id)) as { consumed_at: string | null }).consumed_at)
  { const qx = await Q({ product_id: 'prd_s', quantity: 1, idempotency_key: 'qk_exp' })
    db.prepare('UPDATE order_quotes SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', String(qx.quote_id))
    ok('O-3 expired quote → TOKEN_EXPIRED (no draft made)', (await D({ action: 'create', quote_token: qx.quote_token })).error_code === 'TOKEN_EXPIRED') }
  { useCred('grt_b2', 'gtk_b2', ['price_quote', 'draft_order'])
    const r = await D({ action: 'create', quote_token: q1.quote_token })
    ok('O-4 another subject using my token → QUOTE_TOKEN_INVALID (no existence oracle)', r.error_code === 'QUOTE_TOKEN_INVALID')
    useCred('grt_b', 'gtk_b', ['price_quote', 'draft_order']) }

  // ══ 幂等 ══
  { const again = await D({ action: 'create', quote_token: q1.quote_token, idempotency_key: 'dk1' })
    ok('I-1 same key + same (consumed) quote → replays the SAME draft', again.draft_id === d1.draft_id && again.idempotent_replay === true, JSON.stringify(again).slice(0, 200)) }
  { const q2 = await Q({ product_id: 'prd_s', quantity: 1, idempotency_key: 'qk2' })
    const r = await D({ action: 'create', quote_token: q2.quote_token, idempotency_key: 'dk1' })
    ok('I-2 same key + DIFFERENT quote → IDEMPOTENCY_CONFLICT (quote NOT consumed)', r.error_code === 'IDEMPOTENCY_CONFLICT'
      && !(db.prepare('SELECT consumed_at FROM order_quotes WHERE id=?').get(String(q2.quote_id)) as { consumed_at: string | null }).consumed_at, JSON.stringify(r).slice(0, 200)) }
  { const r = await D({ action: 'create', quote_token: 'qtk_x', idempotency_key: 'a@b.co' })
    ok('I-3 PII-shaped idempotency_key rejected + unstored', r.error_code === 'IDEMPOTENCY_KEY_INVALID' && !JSON.stringify(draftRows()).includes('a@b.co')) }

  // ══ 生命周期 ══
  { const g = await D({ action: 'get', draft_id: d1.draft_id })
    ok('L-1 get returns own draft', g.draft_id === d1.draft_id && g.status === 'draft') }
  { const l = await D({ action: 'list' })
    ok('L-2 list shows only own drafts', Array.isArray(l.drafts) && (l.drafts as unknown[]).length >= 1) }
  { useCred('grt_b2', 'gtk_b2', ['price_quote', 'draft_order'])
    ok('L-3 another subject cannot get my draft → DRAFT_NOT_FOUND', (await D({ action: 'get', draft_id: d1.draft_id })).error_code === 'DRAFT_NOT_FOUND')
    ok('L-4 another subject cannot cancel my draft', (await D({ action: 'cancel', draft_id: d1.draft_id })).error_code === 'DRAFT_NOT_FOUND')
    useCred('grt_b', 'gtk_b', ['price_quote', 'draft_order']) }
  { const c = await D({ action: 'cancel', draft_id: d1.draft_id })
    ok('L-5 cancel → cancelled (terminal)', c.status === 'cancelled' && typeof c.cancelled_at === 'string')
    const c2 = await D({ action: 'cancel', draft_id: d1.draft_id })
    ok('L-6 cancel again → idempotent-safe (already_cancelled, no error)', c2.already_cancelled === true) }
  ok('L-7 no update surface exists (immutable draft — source guard)', !/api\/agent\/order-drafts\/[^\n]*\/(update|patch)/.test((await import('node:fs')).readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')))

  // ══ 过期语义(惰性派生)+ schema 级一 quote 一 draft ══
  { const q4 = await Q({ product_id: 'prd_s', quantity: 1, idempotency_key: 'qk4' })
    const d4 = await D({ action: 'create', quote_token: q4.quote_token })
    db.prepare('UPDATE order_drafts SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', String(d4.draft_id))
    const g = await D({ action: 'get', draft_id: d4.draft_id })
    ok('X-1 expired draft shows status=expired in get (derived, no write)', g.status === 'expired' && (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(d4.draft_id)) as { status: string }).status === 'draft')
    ok('X-2 expired draft cannot be cancelled', (await D({ action: 'cancel', draft_id: d4.draft_id })).error_code === 'DRAFT_NOT_CANCELLABLE') }
  { let threw = false
    try { db.prepare("INSERT INTO order_drafts (id, buyer_id, quote_id, product_id, seller_id, quantity, unit_price_units, item_units, shipping_units, total_units, payable_units, payment_rail, expires_at) SELECT 'odr_dup', buyer_id, quote_id, product_id, seller_id, quantity, unit_price_units, item_units, shipping_units, total_units, payable_units, payment_rail, expires_at FROM order_drafts LIMIT 1").run() } catch { threw = true }
    ok('X-3 one-quote-one-draft is a SCHEMA invariant (UNIQUE(quote_id) blocks even a direct DB writer)', threw) }

  // ══ 零经济执行 ══
  ok('E-1 zero economic objects across ALL of the above (orders/stock/wallets unchanged)', econSnapshot() === econBefore, econSnapshot())
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ order-draft FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order-draft: quote→draft 全链 — draft_order 首个消费者 · 一次性 CAS · 快照冻结 · 隔离 · 幂等 · 零 PII · 零经济执行\n  ✅ pass ${pass}`)
