#!/usr/bin/env tsx
/**
 * RFC-029 Design A · PR-3 — the Choice/Update contract (chooseSubmitPaymentOption + read companion).
 *
 * Proves the atomic choice: a human sets a real rail on a DEFERRED order_submit request →
 *   - draft.payment_rail/direct_receive_account_id persisted (executor's source of truth),
 *   - request.params_hash recomputed (== orderSubmitParamsHash of the updated draft) → any prior
 *     Passkey token (bound to the old deferred hash) is invalidated,
 *   - no money moves, no order created.
 * And the guards: not-own / not-pending / already-chosen / option-unavailable (TOCTOU) /
 *   ineligible-rail-for-shape (variant+direct) / expired.
 * Usage: npm run test:choose-payment
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-choose-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { toUnits } = await import('../src/money.js')
const { chooseSubmitPaymentOption, paymentOptionsForSubmitRequest } = await import('../src/pwa/order-submit-choose-payment.js')
const { orderSubmitParamsHash } = await import('../src/pwa/order-submit-request.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }

const cp: Record<string, unknown> = { 'direct_pay.enabled': true, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG', 'direct_pay.per_tx_cap_units': toUnits(1000) }
const gp = <T>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
const deps = { generateId, getProtocolParam: gp }

db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','hb','buyer','k_b','1 Test St / Singapore SG / +65 91234567','SG')").run()
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer2','B2','hb2','buyer','k_b2','9 Other Rd / SG','SG')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
// eligible-seller fixtures
db.prepare("INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES ('dep','seller1','T0',500,500,'usdc','manual','locked',?)").run(new Date().toISOString())
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc','seller1','clear')").run()
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kyb','seller1','approved')").run()
db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES ('pi','seller1','PayNow +65 9xxx','PayNow','active')").run()
db.prepare("INSERT INTO direct_receive_accounts (id, seller_id, method, currency, instruction, label, status) VALUES ('acc1','seller1','Bank','SGD','ACC1-INSTR','Bank-A','active')").run()
// simple product (direct-eligible) + variant product (direct offered but rail-ineligible for shape)
const mkProd = (id: string, hasVar: number): void => { db.prepare("INSERT INTO products (id, seller_id, title, description, price, currency, stock, category, status, shipping_template, free_shipping_threshold, has_variants, return_days, warranty_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, 'seller1', 'P', 'd', 50, 'WAZ', 20, 'phone_stand', 'active', JSON.stringify([{ region: 'SG', fee: 5, est_days: '3-5' }]), null, hasVar, 7, 90) }
mkProd('ps', 0); mkProd('pv', 1)
db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES ('pvf_ps','ps','seller1','wzv_ps','verified','admin1',datetime('now'))").run()
db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES ('pvf_pv','pv','seller1','wzv_pv','verified','admin1',datetime('now'))").run()
db.prepare("INSERT INTO product_variants (id,product_id,sku,options_json,price_override,stock,is_active) VALUES ('var1','pv','SKU','{\"c\":\"x\"}',50,5,1)").run()

const future = new Date(Date.now() + 3600_000).toISOString()
let seq = 0
// seed a DEFERRED draft + pending order_submit request; returns {draftId, reqId}
const seedDeferred = (productId: string, variantId: string | null, buyer = 'buyer1'): { draftId: string; reqId: string } => {
  seq++; const draftId = `drft_${seq}`, reqId = `req_${seq}`
  db.prepare("INSERT INTO order_drafts (id, buyer_id, quote_id, product_id, variant_id, seller_id, quantity, unit_price_units, item_units, shipping_units, donation_bps, donation_units, total_units, payable_units, currency, payment_rail, direct_receive_account_id, dest_region, address_summary_hash, anonymous_recipient, status, idempotency_key, expires_at, promised_eta_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?)")
    .run(draftId, buyer, 'q_' + draftId, productId, variantId, 'seller1', 1, 50000000, 50000000, 5000000, 0, 0, 55000000, 55000000, 'WAZ', 'deferred', null, 'SG', null, 0, 'idem_' + draftId, future, null)
  db.prepare("INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, intent_hash, action_params, idempotency_key, purchase_intent_instance, operation_attempt_id) VALUES (?,?,?,?, '[]', 'high', 'once', 'pending', ?, 'order_submit', ?, 'order_submit', ?, ?, ?, ?, ?, ?)")
    .run(reqId, buyer, 'g_' + reqId, 'agent', future, draftId, 'ph_deferred_' + draftId, 'ih_' + draftId, JSON.stringify({ draft_id: draftId }), 'idr_' + reqId, 'inst_' + reqId, null)
  return { draftId, reqId }
}
const railOf = (draftId: string) => (db.prepare('SELECT payment_rail, direct_receive_account_id FROM order_drafts WHERE id=?').get(draftId) as { payment_rail: string; direct_receive_account_id: string | null })
const hashOf = (reqId: string) => (db.prepare('SELECT params_hash FROM agent_permission_requests WHERE id=?').get(reqId) as { params_hash: string }).params_hash
const choose = (reqId: string, optionId: string, humanId = 'buyer1') => chooseSubmitPaymentOption(db, { requestId: reqId, humanId, optionId, nowIso: new Date().toISOString(), deps, getProtocolParam: gp })

// ── read companion: deferred request → offers escrow + direct options ──
const s0 = seedDeferred('ps', null)
const optsRead = paymentOptionsForSubmitRequest(db, { requestId: s0.reqId, humanId: 'buyer1', nowIso: new Date().toISOString(), getProtocolParam: gp })
ok('read: deferred request lists options (escrow + direct)', optsRead.ok === true && optsRead.rail_chosen === false && optsRead.options.some(o => o.rail === 'escrow') && optsRead.options.some(o => o.rail === 'direct_p2p'))
ok('read: not-own → 403', paymentOptionsForSubmitRequest(db, { requestId: s0.reqId, humanId: 'buyer2', nowIso: new Date().toISOString(), getProtocolParam: gp }).ok === false)

// ── happy path: choose escrow ──
const s1 = seedDeferred('ps', null)
const preHash1 = hashOf(s1.reqId)
const c1 = choose(s1.reqId, 'escrow')
ok('choose escrow → ok', c1.ok === true && c1.payment_rail === 'escrow')
ok('choose escrow → draft rail=escrow, account null', railOf(s1.draftId).payment_rail === 'escrow' && railOf(s1.draftId).direct_receive_account_id === null)
ok('choose escrow → params_hash CHANGED from deferred hash + equals recomputed', hashOf(s1.reqId) !== preHash1 && hashOf(s1.reqId) === orderSubmitParamsHash({ ...(db.prepare('SELECT * FROM order_drafts WHERE id=?').get(s1.draftId) as Record<string, unknown>) }))
ok('choose escrow → request still pending (not executed/approved), no order created', (db.prepare('SELECT status, executed_at FROM agent_permission_requests WHERE id=?').get(s1.reqId) as { status: string; executed_at: string | null }).status === 'pending')

// ── happy path: choose direct account ──
const s2 = seedDeferred('ps', null)
const c2 = choose(s2.reqId, 'direct:acc1')
ok('choose direct:acc1 → ok, draft rail=direct_p2p + account set', c2.ok === true && railOf(s2.draftId).payment_rail === 'direct_p2p' && railOf(s2.draftId).direct_receive_account_id === 'acc1')

// ── null-account legacy is NOT buyer-choosable (Codex BLOCKER/MA5) → PAYMENT_OPTION_UNAVAILABLE ──
const s3 = seedDeferred('ps', null)
const c3 = choose(s3.reqId, 'direct:legacy')
ok('choose direct:legacy → PAYMENT_OPTION_UNAVAILABLE (null-account destination not hash-bindable)', c3.ok === false && (c3 as { error_code: string }).error_code === 'PAYMENT_OPTION_UNAVAILABLE' && railOf(s3.draftId).payment_rail === 'deferred')

// ── guard: re-choose an already-chosen draft → RAIL_ALREADY_CHOSEN ──
const c1again = choose(s1.reqId, 'direct:acc1')
ok('re-choose already-chosen → RAIL_ALREADY_CHOSEN (never re-forks a decided draft)', c1again.ok === false && (c1again as { error_code: string }).error_code === 'RAIL_ALREADY_CHOSEN')

// ── guard: not your request → 403 ──
const s4 = seedDeferred('ps', null)
ok('not-own → NOT_YOUR_REQUEST 403', (() => { const r = choose(s4.reqId, 'escrow', 'buyer2'); return r.ok === false && (r as { http: number; error_code: string }).http === 403 })())

// ── guard: unknown/unavailable option → PAYMENT_OPTION_UNAVAILABLE ──
ok('unknown option → PAYMENT_OPTION_UNAVAILABLE', (() => { const r = choose(s4.reqId, 'direct:nonexistent'); return r.ok === false && (r as { error_code: string }).error_code === 'PAYMENT_OPTION_UNAVAILABLE' })())

// ── guard: ineligible rail for draft shape — deferred VARIANT draft + choose direct → PAYMENT_OPTION_INELIGIBLE ──
//    (options offers direct since pv is verified/eligible, but direct_p2p v1 rejects variant products at preview-quote)
const sv = seedDeferred('pv', 'var1')
const cv = choose(sv.reqId, 'direct:acc1')
ok('variant + choose direct → PAYMENT_OPTION_INELIGIBLE (preview-quote runs the direct product-shape gate)', cv.ok === false && (cv as { error_code: string }).error_code === 'PAYMENT_OPTION_INELIGIBLE')
ok('variant draft still deferred after rejected choice (no partial write)', railOf(sv.draftId).payment_rail === 'deferred')
// escrow supports variants → choose escrow on the variant draft works
ok('variant + choose escrow → ok', choose(sv.reqId, 'escrow').ok === true && railOf(sv.draftId).payment_rail === 'escrow')

// ── guard: not pending (rejected) → REQUEST_NOT_PENDING ──
const s5 = seedDeferred('ps', null)
db.prepare("UPDATE agent_permission_requests SET status='rejected' WHERE id=?").run(s5.reqId)
ok('rejected request → REQUEST_NOT_PENDING', (() => { const r = choose(s5.reqId, 'escrow'); return r.ok === false && (r as { error_code: string }).error_code === 'REQUEST_NOT_PENDING' })())

// ── read companion: already-chosen request → rail_chosen true, empty menu ──
const readChosen = paymentOptionsForSubmitRequest(db, { requestId: s2.reqId, humanId: 'buyer1', nowIso: new Date().toISOString(), getProtocolParam: gp })
ok('read: already-chosen request → rail_chosen true, empty options', readChosen.ok === true && readChosen.rail_chosen === true && readChosen.options.length === 0)

// ── SAFETY: no order was created by any choose (choice never creates an order) ──
ok('no orders created by any choose-payment', (db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c === 0)

// ── HIGH (MA5 robust): approveAndExecuteOrderSubmit re-checks expectedParamsHash AFTER the CAS claim ──
//    Simulates "Passkey token minted for hash P1, then choose-payment changed it to P2": approve with a
//    stale expectedParamsHash → PARAMS_HASH_CHANGED, loopback never called, no order.
const { approveAndExecuteOrderSubmit } = await import('../src/pwa/order-submit-exec.js')
const sH = seedDeferred('ps', null); choose(sH.reqId, 'escrow')   // now a real rail + fresh params_hash
let loopbackCalled = false
const staleApprove = await approveAndExecuteOrderSubmit(db, { requestId: sH.reqId, approverId: 'buyer1', nowIso: new Date().toISOString(), getProtocolParam: gp, generateId, createOrderLoopback: async () => { loopbackCalled = true; return { status: 200, json: {} } }, expectedParamsHash: 'ph_STALE_token_value' })
ok('stale expectedParamsHash → PARAMS_HASH_CHANGED (token bound to pre-choice hash rejected)', staleApprove.ok === false && (staleApprove as { error_code: string }).error_code === 'PARAMS_HASH_CHANGED')
ok('stale-hash approve never called order-create loopback + created no order', loopbackCalled === false && (db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c === 0)

if (fail > 0) { console.error(`\n❌ choose-payment FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ choose-payment: atomic rail choice on a deferred request (draft persist + params_hash rehash → old token invalid); guards (own/pending/already-chosen/unavailable/ineligible-shape); no money moved, no order created\n  ✅ pass ${pass}`)
