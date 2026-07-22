#!/usr/bin/env tsx
/**
 * RFC-029 Design A · PR-1 — 'deferred' payment-rail sentinel + WEBAZ_RAIL_CHOICE flag.
 *
 * Proves:
 *  - flag OFF (production): omit rail → escrow (byte-identical); explicit 'deferred' → rejected.
 *  - flag ON: omit rail → 'deferred'; explicit escrow/direct_p2p still honored.
 *  - deferred renders as PENDING everywhere (railHonesty / quote+draft projections / summary) — never
 *    silently as escrow.
 *  - SAFETY hard-闸:the executor REFUSES a deferred draft (RAIL_NOT_CHOSEN) — no order ever created,
 *    loopback never called.
 * Usage: npm run test:rail-choice-defer
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-raildefer-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY
delete process.env.WEBAZ_RAIL_CHOICE   // start flag OFF

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { computeBuyerQuote } = await import('../src/pwa/buyer-quote.js')
const { approveAndExecuteOrderSubmit } = await import('../src/pwa/order-submit-exec.js')
const { railHonesty, projectQuoteConsumer, projectDraftConsumer, summarizeQuoteResult } = await import('../src/agent-model-projection.js')
const { isDeferredRail, isRealRail, railChoiceEnabled } = await import('../src/direct-pay-rails.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','hb','buyer','k_b','1 Test St / Singapore SG / +65 91234567','SG')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,shipping_template,free_shipping_threshold,has_variants,return_days,warranty_days) VALUES ('prd_s','seller1','Stand','d',30,'WAZ',20,'phone_stand','active',?,null,0,7,90)").run(JSON.stringify([{ region: 'SG', fee: 5, est_days: '3-5' }]))

const gp = <T>(_k: string, f: T): T => f
const deps = { generateId, getProtocolParam: gp }
type QInput = Parameters<typeof computeBuyerQuote>[3]
const qInput = (rail?: string): QInput => ({ product_id: 'prd_s', quantity: 1, ...(rail !== undefined ? { payment_rail: rail } : {}) })
const payOf = (r: Record<string, unknown>): Record<string, unknown> => (r.payment ?? {}) as Record<string, unknown>

// ── pure helpers ──
ok('helper: isDeferredRail', isDeferredRail('deferred') && !isDeferredRail('escrow') && !isDeferredRail('direct_p2p'))
ok('helper: isRealRail', isRealRail('escrow') && isRealRail('direct_p2p') && !isRealRail('deferred'))
ok('helper: flag off by default', railChoiceEnabled() === false)

// ── FLAG OFF — production regression (byte-identical) ──
const qOffOmit = computeBuyerQuote(db, deps, 'buyer1', qInput())
ok('flag off: omit rail → escrow', qOffOmit.ok === true && payOf(qOffOmit.response).rail === 'escrow')
const qOffDef = computeBuyerQuote(db, deps, 'buyer1', qInput('deferred'))
ok('flag off: explicit deferred → rejected PAYMENT_RAIL_DISABLED', qOffDef.ok !== true && (qOffDef as { body: { error_code?: string } }).body?.error_code === 'PAYMENT_RAIL_DISABLED')

// ── FLAG ON ──
process.env.WEBAZ_RAIL_CHOICE = '1'
ok('flag on: railChoiceEnabled true', railChoiceEnabled() === true)
const qOnOmit = computeBuyerQuote(db, deps, 'buyer1', qInput())
ok('flag on: omit rail → deferred', qOnOmit.ok === true && payOf(qOnOmit.response).rail === 'deferred')
ok('flag on: deferred payment block custodied null + pending note', qOnOmit.ok === true && payOf(qOnOmit.response).custodied_by_webaz === null && /not chosen/i.test(String(payOf(qOnOmit.response).note)))
const qOnEscrow = computeBuyerQuote(db, deps, 'buyer1', qInput('escrow'))
ok('flag on: explicit escrow still honored', qOnEscrow.ok === true && payOf(qOnEscrow.response).rail === 'escrow')
const qOnDirect = computeBuyerQuote(db, deps, 'buyer1', qInput('direct_p2p'))
ok('flag on: explicit direct_p2p still evaluated (not silently deferred)', qOnDirect.ok !== true || payOf(qOnDirect.response).rail === 'direct_p2p')   // may be gate-rejected, but never coerced to deferred

// ── deferred renders as PENDING everywhere (never escrow) ──
ok('railHonesty(deferred) = pending note, not escrow copy', /尚未选择/.test(railHonesty('deferred')) && !/模拟托管/.test(railHonesty('deferred')))
const pq = projectQuoteConsumer(qOnOmit.ok === true ? qOnOmit.response : {}, null, () => 'USD')
ok('projectQuoteConsumer(deferred quote) → payment_rail deferred + pending rail_note', pq.payment_rail === 'deferred' && /尚未选择/.test(String(pq.rail_note)))
const draftMock = { draft_id: 'd1', status: 'draft', payment_rail: 'deferred', product: { product_id: 'prd_s', title: 'Stand' }, destination: {}, total: { amount_minor: 35000000 }, payable_total: { amount_minor: 35000000 }, quantity: 1, expires_at: new Date().toISOString() }
const pd = projectDraftConsumer(draftMock, null, () => 'USD')
ok('projectDraftConsumer(deferred draft) → payment_rail deferred + pending rail_note', pd.payment_rail === 'deferred' && /尚未选择/.test(String(pd.rail_note)))
ok('summarizeQuoteResult(deferred) → "not yet chosen"', /not yet chosen/i.test(summarizeQuoteResult({ payment_rail: 'deferred', payable_total: { amount_minor: 35000000 } })))

// ── SAFETY: exec HARD-refuses a deferred draft (no order ever created) ──
const draftId = 'drft_def', reqId = 'req_def'
const now = new Date().toISOString(); const future = new Date(Date.now() + 3600_000).toISOString()
db.prepare("INSERT INTO order_drafts (id, buyer_id, quote_id, product_id, variant_id, seller_id, quantity, unit_price_units, item_units, shipping_units, donation_bps, donation_units, total_units, payable_units, currency, payment_rail, direct_receive_account_id, dest_region, address_summary_hash, anonymous_recipient, status, idempotency_key, expires_at, promised_eta_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?)")
  .run(draftId, 'buyer1', 'q_x', 'prd_s', null, 'seller1', 1, 30000000, 30000000, 5000000, 0, 0, 35000000, 35000000, 'WAZ', 'deferred', null, 'SG', null, 0, 'idem_x', future, null)
db.prepare("INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, intent_hash, action_params, idempotency_key, purchase_intent_instance, operation_attempt_id) VALUES (?,?,?,?, '[]', 'high', 'once', 'pending', ?, 'order_submit', ?, 'order_submit', ?, ?, ?, ?, ?, ?)")
  .run(reqId, 'buyer1', 'g_x', 'agent', future, draftId, 'ph_x', 'ih_x', JSON.stringify({ draft_id: draftId }), 'idem_r', 'inst_x', null)
let loopbackCalled = false
const execRes = await approveAndExecuteOrderSubmit(db, { requestId: reqId, approverId: 'buyer1', nowIso: now, getProtocolParam: gp, generateId, createOrderLoopback: async () => { loopbackCalled = true; return { status: 200, json: {} } } })
ok('exec refuses deferred → RAIL_NOT_CHOSEN', execRes.ok === false && (execRes as { error_code?: string }).error_code === 'RAIL_NOT_CHOSEN')
ok('exec never called order-create loopback for deferred', loopbackCalled === false)
const draftAfter = db.prepare('SELECT order_id FROM order_drafts WHERE id=?').get(draftId) as { order_id: string | null }
ok('exec created NO order for the deferred draft', !draftAfter.order_id)

delete process.env.WEBAZ_RAIL_CHOICE
if (fail > 0) { console.error(`\n❌ rail-choice-defer FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ rail-choice-defer: 'deferred' sentinel + WEBAZ_RAIL_CHOICE flag; flag-off byte-identical; deferred renders pending (never escrow); exec hard-refuses deferred (no order)\n  ✅ pass ${pass}`)
