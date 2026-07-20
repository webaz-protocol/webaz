#!/usr/bin/env tsx
/**
 * BUG-08 §四 — restart-recovery + multi-connection concurrency at the submit-domain layer.
 * A second better-sqlite3 connection to the SAME DB file simulates a process restart / a second process.
 * Proves: after a "restart" the same idempotency_key recovers the original request (no 2nd), the same draft
 * returns the original request, an executed request retried returns the same result; and across two
 * connections the file-level partial unique indexes admit exactly one winner for the same operation while
 * two genuinely-distinct purchase_intent_instances each succeed.
 * NOTE: SQLite (single-writer, serialized) cannot reproduce a true multi-process interleaved race; this
 * proves the DB-level uniqueness invariant across independent connections. A real multi-instance race is
 * a staging item (recorded in KNOWN_LIMITATIONS).
 * Usage: npx tsx scripts/test-bug08-restart-concurrency.ts
 */
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
const HOME = mkdtempSync(join(tmpdir(), 'bug08rc-')); process.env.HOME = HOME
const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { createOrderSubmitRequest } = await import('../src/pwa/order-submit-request.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const DB_PATH = join(HOME, '.webaz', 'webaz.db')
const db1 = initDatabase(); applyWebazRuntimeSchema(db1); db1.pragma('foreign_keys = OFF')
db1.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k')").run()

let seq = 0
function mkDraft(econ: Record<string, unknown> = {}): string {
  const id = generateId('odr'); seq++
  const e = { product_id: 'prd1', seller_id: 'seller1', quantity: 1, unit_price_units: 7_000_000, item_units: 7_000_000, shipping_units: 0, donation_bps: 0, donation_units: 0, total_units: 7_000_000, payable_units: 7_000_000, currency: 'WAZ', payment_rail: 'escrow', dest_region: 'SG', anonymous_recipient: 0, ...econ }
  db1.prepare(`INSERT INTO order_drafts (id,buyer_id,quote_id,product_id,variant_id,seller_id,quantity,unit_price_units,item_units,shipping_units,donation_bps,donation_units,total_units,payable_units,currency,payment_rail,direct_receive_account_id,dest_region,address_summary_hash,anonymous_recipient,status,expires_at)
    VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?, 'draft', datetime('now','+24 hours'))`)
    .run(id, 'buyer1', 'qtk_' + seq, e.product_id, e.seller_id, e.quantity, e.unit_price_units, e.item_units, e.shipping_units, e.donation_bps, e.donation_units, e.total_units, e.payable_units, e.currency, e.payment_rail, e.dest_region, e.anonymous_recipient)
  return id
}
const base = { grantId: 'grt1', humanId: 'buyer1', agentLabel: 'a', generateId }
type R = { ok: true; request_id: string; duplicate?: boolean; duplicate_reason?: string } | { ok: false; error_code: string }

// ── 1. write on db1, then "restart" (fresh connection db2) recovers by the same idempotency_key ──
const dA = mkDraft()
const w = createOrderSubmitRequest(db1, { ...base, draftId: dA, idempotencyKey: 'K-restart' }) as R
const R1 = (w as { request_id: string }).request_id
db1.close()   // simulate process exit AFTER the write committed
const db2 = new Database(DB_PATH); db2.pragma('foreign_keys = OFF')   // "restart" / a second process
const rec = createOrderSubmitRequest(db2, { ...base, draftId: dA, idempotencyKey: 'K-restart' }) as R
ok('1. after restart, same idempotency_key recovers the ORIGINAL request (no 2nd row)', rec.ok === true && (rec as { request_id: string }).request_id === R1 && (rec as { duplicate?: boolean }).duplicate === true)
ok('1b. still exactly one row for that key', (db2.prepare("SELECT count(*) c FROM agent_permission_requests WHERE idempotency_key='K-restart'").get() as { c: number }).c === 1)

// ── 2. after restart, resubmitting the SAME draft returns the original request ──
const rd = createOrderSubmitRequest(db2, { ...base, draftId: dA }) as R
ok('2. restart + same draft → SAME_DRAFT_REPLAY, original request_id', rd.ok === true && (rd as { duplicate_reason?: string }).duplicate_reason === 'SAME_DRAFT_REPLAY' && (rd as { request_id: string }).request_id === R1)

// ── 3. executed request retried (via key) → same original result, no 2nd ──
db2.prepare("UPDATE agent_permission_requests SET status='approved', executed_at=datetime('now'), execution_result=? WHERE id=?").run(JSON.stringify({ ok: true, order_id: 'ord_1' }), R1)
const re = createOrderSubmitRequest(db2, { ...base, draftId: dA, idempotencyKey: 'K-restart' }) as R
ok('3. executed request retried with the same key → RESPONSE_LOSS_RECONCILED, same request_id (one order upstream)', re.ok === true && (re as { duplicate_reason?: string }).duplicate_reason === 'RESPONSE_LOSS_RECONCILED' && (re as { request_id: string }).request_id === R1)

// ── 4. multi-connection: db2 writes intent I (draftB); db3 (independent connection) submits draftC same
//        economics/no new_purchase_intent → hits the FILE-level intent unique index → exactly one winner ──
const dB = mkDraftOn(db2, { quantity: 2, item_units: 14_000_000, total_units: 14_000_000, payable_units: 14_000_000 })
const b = createOrderSubmitRequest(db2, { ...base, draftId: dB }) as R
const RB = (b as { request_id: string }).request_id
const db3 = new Database(DB_PATH); db3.pragma('foreign_keys = OFF')
const dC = mkDraftOn(db3, { quantity: 2, item_units: 14_000_000, total_units: 14_000_000, payable_units: 14_000_000 })   // same economics as dB
const c = createOrderSubmitRequest(db3, { ...base, draftId: dC }) as R
ok('4. two connections, same intent → the 2nd resolves to the 1st (ACTIVE_INTENT_REUSED), one active row', c.ok === true && (c as { duplicate_reason?: string }).duplicate_reason === 'ACTIVE_INTENT_REUSED' && (c as { request_id: string }).request_id === RB)
ok('4b. exactly one active submit row for that intent across connections', (db3.prepare("SELECT count(*) c FROM agent_permission_requests WHERE kind='order_submit' AND status IN ('pending','approved') AND executed_at IS NULL AND params_hash IN (SELECT params_hash FROM agent_permission_requests WHERE id=?)").get(RB) as { c: number }).c === 1)

// ── 5. two genuinely-distinct purchase_intent_instances each succeed (independent), across connections ──
const dD = mkDraftOn(db3, { quantity: 2, item_units: 14_000_000, total_units: 14_000_000, payable_units: 14_000_000 })
const d = createOrderSubmitRequest(db3, { ...base, draftId: dD, newPurchaseIntent: true, purchaseIntentInstance: 'pii-x1' }) as R
ok('5. explicit second instance → NEW independent request (not merged with RB)', d.ok === true && (d as { request_id: string }).request_id !== RB && !((d as { duplicate?: boolean }).duplicate))

// ── 6. same idempotency_key fired twice (rapid double-fire) → one request ──
const dE = mkDraftOn(db3, { quantity: 3, item_units: 21_000_000, total_units: 21_000_000, payable_units: 21_000_000 })
const e1 = createOrderSubmitRequest(db3, { ...base, draftId: dE, idempotencyKey: 'K-dbl' }) as R
const e2 = createOrderSubmitRequest(db3, { ...base, draftId: dE, idempotencyKey: 'K-dbl' }) as R
ok('6. double-fire same key → same request_id (one purchase)', e1.ok && e2.ok && (e1 as { request_id: string }).request_id === (e2 as { request_id: string }).request_id)

function mkDraftOn(db: Database.Database, econ: Record<string, unknown> = {}): string {
  const id = generateId('odr'); seq++
  const e = { product_id: 'prd1', seller_id: 'seller1', quantity: 1, unit_price_units: 7_000_000, item_units: 7_000_000, shipping_units: 0, donation_bps: 0, donation_units: 0, total_units: 7_000_000, payable_units: 7_000_000, currency: 'WAZ', payment_rail: 'escrow', dest_region: 'SG', anonymous_recipient: 0, ...econ }
  db.prepare(`INSERT INTO order_drafts (id,buyer_id,quote_id,product_id,variant_id,seller_id,quantity,unit_price_units,item_units,shipping_units,donation_bps,donation_units,total_units,payable_units,currency,payment_rail,direct_receive_account_id,dest_region,address_summary_hash,anonymous_recipient,status,expires_at)
    VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?, 'draft', datetime('now','+24 hours'))`)
    .run(id, 'buyer1', 'qtk_' + seq, e.product_id, e.seller_id, e.quantity, e.unit_price_units, e.item_units, e.shipping_units, e.donation_bps, e.donation_units, e.total_units, e.payable_units, e.currency, e.payment_rail, e.dest_region, e.anonymous_recipient)
  return id
}

db2.close(); db3.close()
if (fail > 0) { console.error(`\n❌ restart-concurrency FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bug08-restart-concurrency: restart recovers by key/draft · executed retry → same result · cross-connection intent uniqueness (one winner) · distinct instances independent · double-fire key → one\n  ✅ pass ${pass}`)
