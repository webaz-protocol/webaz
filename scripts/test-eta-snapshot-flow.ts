#!/usr/bin/env tsx
/**
 * BUG-02 end-to-end — promised delivery ETA is FROZEN at quote and INHERITED draft→order, immune to later
 * listing changes; legacy orders (no snapshot) show "not recorded". §XI-B (inheritance) + §XI-C (drift).
 * Usage: npx tsx scripts/test-eta-snapshot-flow.ts
 */
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'etaflow-'))
const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { computeBuyerQuote } = await import('../src/pwa/buyer-quote.js')
const { createOrderDraft, getOrderDraft } = await import('../src/pwa/order-draft.js')
const { buildBuyerOrderFull } = await import('../src/pwa/buyer-order-full-view.js')
const { parsePromisedEta, promisedEtaForOrder } = await import('../src/delivery-eta.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db)
for (const c of ['default_address_text TEXT', 'default_address_region TEXT']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${c}`) } catch { /* exists */ } }
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','b1','buyer','k_b','12 SG Rd','SG')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
// product: product-level estimated_days='30' + a SG shipping template est_days='3-5'
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,estimated_days,shipping_template,has_variants) VALUES ('prd1','seller1','Ring','d',10,'WAZ',50,'jewelry','active','30',?,0)`)
  .run(JSON.stringify([{ region: 'SG', fee: 0, est_days: '3-5' }, { region: '*', fee: 5, est_days: '10-20' }]))
const deps = { generateId, getProtocolParam: <T>(k: string, f: T): T => (k === 'trade.platform_region_blocklist' ? ('[]' as unknown as T) : k === 'payment_rail_waz_escrow_enabled' ? (1 as unknown as T) /* WAZ 退役:验证渠道【开着时】语义 */ : f) }

// ── quote: freeze the SG-resolved ETA (3-5) ──
const q = computeBuyerQuote(db, deps, 'buyer1', { product_id: 'prd1', quantity: 1 }, 'issue') as { ok: boolean; response: Record<string, unknown> }
ok('Q1. quote ok', q.ok === true)
const qResp = q.response
const qPe = qResp.promised_eta as Record<string, unknown> | undefined
ok('Q2. quote carries promised_eta (region-resolved SG template est 3-5)', !!qPe && qPe.source === 'template_exact' && qPe.estimated_days_text === '3-5' && qPe.destination_region === 'SG')
ok('Q3. quote card field shipping.estimated_days shows the FROZEN value 3-5', ((qResp.shipping as Record<string, unknown>).estimated_days) === '3-5')
const token = String(qResp.quote_token)

// ── drift: seller changes the listing AFTER the quote ──
db.prepare("UPDATE products SET estimated_days='999', shipping_template=? WHERE id='prd1'").run(JSON.stringify([{ region: 'SG', fee: 0, est_days: '77-88' }]))

// ── draft inherits the FROZEN quote ETA (not the changed listing) ──
const d = createOrderDraft(db, { generateId }, 'buyer1', { quote_token: token }) as { ok: boolean; response: Record<string, unknown> }
ok('D1. draft ok', d.ok === true)
const dPe = d.response.promised_eta as Record<string, unknown> | undefined
ok('D2. draft inherits FROZEN ETA 3-5 despite listing now 77-88 (drift-immune)', !!dPe && dPe.estimated_days_text === '3-5' && dPe.source === 'template_exact')
const draftId = String(d.response.draft_id)
const dGet = getOrderDraft(db, 'buyer1', draftId) as { ok: boolean; response: Record<string, unknown> }
ok('D3. draft get/list returns the SAME frozen snapshot', ((dGet.response.promised_eta as Record<string, unknown>)?.estimated_days_text) === '3-5')
// the persisted column equals the quote's
const draftRow = db.prepare('SELECT promised_eta_snapshot FROM order_drafts WHERE id=?').get(draftId) as { promised_eta_snapshot: string }
ok('D4. draft persisted promised_eta_snapshot === parsed frozen', parsePromisedEta(draftRow.promised_eta_snapshot)?.estimated_days_text === '3-5')

// ── order inherits the draft snapshot (mirror orders-create: copy draft snapshot into orders) ──
const orderId = generateId('ord')
db.prepare(`INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,ship_to_region,shipping_est_days,draft_id,promised_eta_snapshot,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?, 'created', 'SG', '77-88', ?, ?, datetime('now'), datetime('now'))`)
  .run(orderId, 'prd1', 'buyer1', 'seller1', 1, 10, 10, 10, draftId, draftRow.promised_eta_snapshot)
const ofull = buildBuyerOrderFull(db, 'buyer1', orderId) as { ok: boolean; response: Record<string, unknown> }
ok('O1. order full view ok', ofull.ok === true)
const logi = (ofull.response.logistics ?? {}) as Record<string, unknown>
const oPe = logi.promised_eta as Record<string, unknown> | undefined
ok('O2. order promised_eta === frozen 3-5 (下单时承诺)', !!oPe && oPe.estimated_days_text === '3-5')
ok('O3. order logistics_eta (shipping_est_days) is the SEPARATE template value 77-88 — two ETAs not merged', logi.shipping_est_days === '77-88')

// ── legacy order (no snapshot) → legacy_missing ──
const legId = generateId('ord')
db.prepare(`INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,ship_to_region,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?, 'created', 'SG', datetime('now'), datetime('now'))`).run(legId, 'prd1', 'buyer1', 'seller1', 1, 10, 10, 10)
const legFull = buildBuyerOrderFull(db, 'buyer1', legId) as { ok: boolean; response: Record<string, unknown> }
const legPe = ((legFull.response.logistics ?? {}) as Record<string, unknown>).promised_eta as Record<string, unknown> | undefined
ok('L1. legacy order (no snapshot) → legacy_missing true (never backfilled from current listing)', !!legPe && legPe.legacy_missing === true && legPe.estimated_days_text === null)

// ── §IV / adversarial F1: lowercase "sg" resolves the SAME exact tier for BOTH fee and ETA (no case-drift) ──
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer_lc','B','blc','buyer','k_lc','7 SG Rd','sg')").run()
db.prepare("UPDATE products SET estimated_days='30', shipping_template=? WHERE id='prd1'").run(JSON.stringify([{ region: 'SG', fee: 0, est_days: '3-5' }, { region: '*', fee: 9, est_days: '10-20' }]))
const qlc = computeBuyerQuote(db, deps, 'buyer_lc', { product_id: 'prd1', quantity: 1 }, 'issue') as { ok: boolean; response: Record<string, unknown> }
const lcPe = qlc.response.promised_eta as Record<string, unknown>
ok('F1a. lowercase "sg" → ETA exact SG tier (3-5, not wildcard 10-20) + region normalized to SG', lcPe.source === 'template_exact' && lcPe.estimated_days_text === '3-5' && lcPe.destination_region === 'SG')
const lcShip = (qlc.response.line_items as Array<Record<string, unknown>>).find(l => l.code === 'shipping')
ok('F1b. lowercase "sg" → fee tier ALSO exact SG (shipping 0, not wildcard 9) — fee/ETA no case-drift', Number(lcShip?.amount_minor) === 0)

// ── §F2: order-level promised ETA — draft inherits; direct buy-now (no draft) freezes the CURRENT listing ──
//   (direct buy-now = webaz_place_order / PWA #buy — a live production path; must NOT be legacy_missing)
const nowIso = '2026-07-20T00:00:00.000Z'
const peDraft = promisedEtaForOrder(db, {}, 'seller1', 'SG', draftId, nowIso)
ok('F2a. order(draftId) inherits the draft snapshot (3-5), ignores product arg / current listing', parsePromisedEta(peDraft)?.estimated_days_text === '3-5')
const peDirect = promisedEtaForOrder(db, { estimated_days: '30', shipping_template: JSON.stringify([{ region: 'SG', fee: 0, est_days: '6-8' }]) }, 'seller1', 'SG', null, nowIso)
ok('F2b. direct buy-now (no draft) freezes the CURRENT listing (SG 6-8 = what buyer saw), NOT legacy_missing', parsePromisedEta(peDirect)?.estimated_days_text === '6-8' && parsePromisedEta(peDirect)?.legacy_missing !== true && parsePromisedEta(peDirect)?.source === 'template_exact')
ok('F2c. direct buy-now with no ETA data → source none / no_estimate (honest, not fabricated)', parsePromisedEta(promisedEtaForOrder(db, {}, 'seller1', 'SG', null, nowIso))?.source === 'none')

db.close()
if (fail > 0) { console.error(`\n❌ eta snapshot flow FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ eta snapshot flow: freeze@quote → inherit draft → inherit order · drift-immune · promised≠logistics · legacy_missing\n  ✅ pass ${pass}`)
