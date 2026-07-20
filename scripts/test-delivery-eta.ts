#!/usr/bin/env tsx
/**
 * BUG-02 — promised delivery ETA snapshot helper (region selection §IV, structure §III, parsing, no-PII).
 * Usage: npx tsx scripts/test-delivery-eta.ts
 */
import Database from 'better-sqlite3'
import { buildPromisedEta, parseEtaDays, parsePromisedEta, serializePromisedEta, legacyMissingEta, PROMISED_ETA_SCHEMA } from '../src/delivery-eta.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = new Database(':memory:')
db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, store_shipping_template TEXT, store_shipping_quote_ok INTEGER)')
const NOW = '2026-07-20T00:00:00.000Z'
const tplProduct = { estimated_days: '30', shipping_template: JSON.stringify([{ region: 'SG', fee: 5, est_days: '3-5' }, { region: 'CN', fee: 0, est_days: '2-4' }, { region: '*', fee: 25, est_days: '10-20' }]) }

// ── §IV region selection ──
const sg = buildPromisedEta(db, tplProduct, 'u1', 'SG', NOW)
ok('R1. exact region SG → template_exact "3-5" (min3/max5)', sg.source === 'template_exact' && sg.estimated_days_text === '3-5' && sg.estimated_min_days === 3 && sg.estimated_max_days === 5 && sg.destination_region === 'SG' && sg.unavailable_reason === null)
ok('R2. lowercase sg normalizes to SG (case-insensitive match)', buildPromisedEta(db, tplProduct, 'u1', 'sg', NOW).source === 'template_exact')
ok('R3. mixed " Sg " trims + uppercases → SG', buildPromisedEta(db, tplProduct, 'u1', ' Sg ', NOW).destination_region === 'SG')
const us = buildPromisedEta(db, tplProduct, 'u1', 'US', NOW)
ok('R4. uncovered region US → wildcard(all) "10-20"', us.source === 'template_wildcard' && us.estimated_days_text === '10-20' && us.estimated_min_days === 10 && us.estimated_max_days === 20)
// order-independence: exact must win regardless of array order (CN listed before SG here)
const reordered = { estimated_days: '30', shipping_template: JSON.stringify([{ region: 'CN', fee: 0, est_days: '2-4' }, { region: '*', fee: 25, est_days: '10-20' }, { region: 'SG', fee: 5, est_days: '3-5' }]) }
ok('R5. exact match chosen deterministically regardless of array order (no traversal-order dependence)', buildPromisedEta(db, reordered, 'u1', 'SG', NOW).estimated_days_text === '3-5')

// no wildcard + uncovered → product-level fallback
const noWild = { estimated_days: '9', shipping_template: JSON.stringify([{ region: 'SG', fee: 5, est_days: '3-5' }]) }
ok('R6. no wildcard + uncovered region → product_listing fallback (estimated_days=9)', buildPromisedEta(db, noWild, 'u1', 'JP', NOW).source === 'product_listing' && buildPromisedEta(db, noWild, 'u1', 'JP', NOW).estimated_min_days === 9)
// covered region but that entry has NO est_days → product-level fallback
const noEst = { estimated_days: '14', shipping_template: JSON.stringify([{ region: 'SG', fee: 5 }]) }
ok('R7. region covered but entry lacks est_days → falls back to product_listing (14)', buildPromisedEta(db, noEst, 'u1', 'SG', NOW).source === 'product_listing' && buildPromisedEta(db, noEst, 'u1', 'SG', NOW).estimated_days_text === '14')
// no template, product-level only
ok('R8. no template + product estimated_days → product_listing', buildPromisedEta(db, { estimated_days: '7' }, 'u1', 'SG', NOW).source === 'product_listing')
// no template + no estimated_days → none / no_estimate
const none = buildPromisedEta(db, { estimated_days: null }, 'u1', 'SG', NOW)
ok('R9. no template + no estimated_days → source none + unavailable_reason no_estimate + text null', none.source === 'none' && none.unavailable_reason === 'no_estimate' && none.estimated_days_text === null)
// no wildcard + uncovered + no product estimate → region_not_covered
const noWildNoProd = { estimated_days: null, shipping_template: JSON.stringify([{ region: 'SG', fee: 5, est_days: '3-5' }]) }
ok('R10. uncovered + no wildcard + no product estimate → unavailable (no fabricated ETA)', buildPromisedEta(db, noWildNoProd, 'u1', 'JP', NOW).source === 'none' && buildPromisedEta(db, noWildNoProd, 'u1', 'JP', NOW).estimated_days_text === null)
// empty region → normalized null; product-level fallback still works
ok('R11. empty destination region → destination_region null, still resolves product-level', buildPromisedEta(db, { estimated_days: '5' }, 'u1', '', NOW).destination_region === null)

// store-level template fallback (product has none)
db.prepare('UPDATE users SET store_shipping_template = ? WHERE id = ?').run(JSON.stringify([{ region: 'SG', fee: 3, est_days: '4-6' }]), 'u1')
db.prepare('INSERT INTO users (id, store_shipping_template) VALUES (?, ?)').run('u2', JSON.stringify([{ region: 'SG', fee: 3, est_days: '4-6' }]))
ok('R12. store-level template used when product has none', buildPromisedEta(db, { estimated_days: '30' }, 'u2', 'SG', NOW).estimated_days_text === '4-6')

// ── §III structure + parsing ──
ok('S1. snapshot carries schema_version + captured_at (UTC passthrough)', sg.schema_version === PROMISED_ETA_SCHEMA && sg.captured_at === NOW && sg.legacy_missing === false)
ok('P1. parseEtaDays "12" → {12,12}', JSON.stringify(parseEtaDays('12')) === JSON.stringify({ min: 12, max: 12 }))
ok('P2. parseEtaDays "7-10" → {7,10}', JSON.stringify(parseEtaDays('7-10')) === JSON.stringify({ min: 7, max: 10 }))
ok('P3. parseEtaDays "约12天" → {12,12}', JSON.stringify(parseEtaDays('约12天')) === JSON.stringify({ min: 12, max: 12 }))
ok('P4. parseEtaDays non-numeric/empty → {null,null}', JSON.stringify(parseEtaDays('soon')) === JSON.stringify({ min: null, max: null }) && JSON.stringify(parseEtaDays('')) === JSON.stringify({ min: null, max: null }))
ok('P5. parseEtaDays absurd value ignored (>3650 days dropped)', JSON.stringify(parseEtaDays('99999')) === JSON.stringify({ min: null, max: null }))

// serialize/parse round-trip; malformed → null; legacy marker
ok('SP1. serialize→parse round-trip', JSON.stringify(parsePromisedEta(serializePromisedEta(sg))) === JSON.stringify(sg))
ok('SP2. parse malformed/absent → null (never throws)', parsePromisedEta('not json') === null && parsePromisedEta(null) === null && parsePromisedEta('{"schema_version":"other"}') === null)
const leg = legacyMissingEta()
ok('SP3. legacyMissingEta → legacy_missing true + legacy_not_recorded (never backfilled)', leg.legacy_missing === true && leg.unavailable_reason === 'legacy_not_recorded' && leg.estimated_days_text === null)

// ── no-PII: the snapshot only ever contains region code + day counts + reason ──
const keys = Object.keys(sg).sort()
const ALLOWED = ['captured_at', 'destination_region', 'estimated_days_text', 'estimated_max_days', 'estimated_min_days', 'legacy_missing', 'schema_version', 'source', 'unavailable_reason']
ok('Z1. snapshot key-set is fixed (no address/token/PII fields ever added)', JSON.stringify(keys) === JSON.stringify(ALLOWED))
ok('Z2. no snapshot field name hints at PII', !keys.some(k => /address|token|passkey|payment|phone|email|name/i.test(k)))

db.close()
if (fail > 0) { console.error(`\n❌ delivery-eta FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ delivery-eta: region selection (exact/wildcard/product/none) · parsing · round-trip · legacy marker · no-PII\n  ✅ pass ${pass}`)
