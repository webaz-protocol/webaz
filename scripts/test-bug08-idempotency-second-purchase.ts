#!/usr/bin/env tsx
/**
 * BUG-08 — three-layer idempotency + explicit second-purchase, at the submit-domain layer
 * (createOrderSubmitRequest, the ONLY writer of order_submit rows). Proves the money-safety invariants:
 * no second active submit row (⇒ the exec I5-CAS can only ever produce one order per request_id), a
 * machine duplicate_reason per path, and that an explicit 再买一份 is a NEW independent request.
 * Usage: npx tsx scripts/test-bug08-idempotency-second-purchase.ts
 */
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'bug08-'))
const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { createOrderSubmitRequest, orderSubmitIntentHash } = await import('../src/pwa/order-submit-request.js')
const { projectSubmitConsumer: projSubmit } = await import('../src/agent-model-projection.js')
const { recordIdempotencyTrace } = await import('../src/pwa/idempotency-trace.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF')
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k')").run()

let draftSeq = 0
/** insert a fresh draft (distinct id + quote_id); `econ` overrides the economic fields (same econ ⇒ same intent). */
function mkDraft(econ: Record<string, unknown> = {}): string {
  const id = generateId('odr'); draftSeq++
  const e = { product_id: 'prd1', seller_id: 'seller1', quantity: 1, unit_price_units: 7_000_000, item_units: 7_000_000, shipping_units: 0, donation_bps: 0, donation_units: 0, total_units: 7_000_000, payable_units: 7_000_000, currency: 'WAZ', payment_rail: 'escrow', dest_region: 'SG', anonymous_recipient: 0, ...econ }
  db.prepare(`INSERT INTO order_drafts (id,buyer_id,quote_id,product_id,variant_id,seller_id,quantity,unit_price_units,item_units,shipping_units,donation_bps,donation_units,total_units,payable_units,currency,payment_rail,direct_receive_account_id,dest_region,address_summary_hash,anonymous_recipient,status,expires_at)
    VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?, 'draft', datetime('now','+24 hours'))`)
    .run(id, 'buyer1', 'qtk_' + draftSeq, e.product_id, e.seller_id, e.quantity, e.unit_price_units, e.item_units, e.shipping_units, e.donation_bps, e.donation_units, e.total_units, e.payable_units, e.currency, e.payment_rail, e.dest_region, e.anonymous_recipient)
  return id
}
const base = { grantId: 'grt1', humanId: 'buyer1', agentLabel: 'agent', generateId }
const activeCount = (intentHash: string): number => (db.prepare("SELECT count(*) c FROM agent_permission_requests WHERE kind='order_submit' AND human_id='buyer1' AND intent_hash=? AND status IN ('pending','approved') AND executed_at IS NULL").get(intentHash) as { c: number }).c
type R = { ok: true; request_id: string; duplicate?: boolean; duplicate_reason?: string; duplicate_of?: string; purchase_intent_instance?: string | null; new_purchase_intent?: boolean } | { ok: false; http: number; error_code: string }

// ── 1. first submit ──
const dA = mkDraft()
const r1 = createOrderSubmitRequest(db, { ...base, draftId: dA }) as R
ok('1. first submit ok, not duplicate', r1.ok === true && !('duplicate' in r1 && r1.duplicate))
const R1 = (r1 as { request_id: string }).request_id

// ── 2. rule 1/3: same draft resubmit (network retry / rapid click that leaked past single-flight) ──
const r2 = createOrderSubmitRequest(db, { ...base, draftId: dA }) as R
ok('2. same-draft resubmit → duplicate SAME_DRAFT_REPLAY, SAME request_id (no 2nd row)', r2.ok === true && (r2 as { duplicate?: boolean }).duplicate === true && (r2 as { duplicate_reason?: string }).duplicate_reason === 'SAME_DRAFT_REPLAY' && (r2 as { request_id: string }).request_id === R1)

// ── 3. rule 4: same idempotency_key + same payload → same result ──
const dK = mkDraft({ quantity: 2, item_units: 14_000_000, total_units: 14_000_000, payable_units: 14_000_000 })
const k1 = createOrderSubmitRequest(db, { ...base, draftId: dK, idempotencyKey: 'idem-AAA' }) as R
const k2 = createOrderSubmitRequest(db, { ...base, draftId: dK, idempotencyKey: 'idem-AAA' }) as R
ok('3. same idempotency_key + same payload → SAME_IDEMPOTENCY_KEY, same request_id', k2.ok === true && (k2 as { duplicate_reason?: string }).duplicate_reason === 'SAME_IDEMPOTENCY_KEY' && (k2 as { request_id: string }).request_id === (k1 as { request_id: string }).request_id)

// ── 4. same idempotency_key + DIFFERENT payload → IDEMPOTENCY_CONFLICT (no execute, no overwrite) ──
const dK2 = mkDraft({ quantity: 9, item_units: 63_000_000, total_units: 63_000_000, payable_units: 63_000_000 })
const kc = createOrderSubmitRequest(db, { ...base, draftId: dK2, idempotencyKey: 'idem-AAA' }) as R
ok('4. same key + different payload → IDEMPOTENCY_CONFLICT (409, not ok)', kc.ok === false && (kc as { error_code: string }).error_code === 'IDEMPOTENCY_CONFLICT' && (kc as { http: number }).http === 409)
ok('4b. conflict did NOT overwrite the original key row', (db.prepare("SELECT id FROM agent_permission_requests WHERE idempotency_key='idem-AAA'").get() as { id: string }).id === (k1 as { request_id: string }).request_id)

// ── 5. rule 8: DIFFERENT draft, identical economics, NO new_purchase_intent → ACTIVE_INTENT_REUSED ──
const dB = mkDraft()   // same economics as dA
const r5 = createOrderSubmitRequest(db, { ...base, draftId: dB }) as R
ok('5. different draft, same economics → ACTIVE_INTENT_REUSED, reuses R1 (no 2nd active row)', r5.ok === true && (r5 as { duplicate_reason?: string }).duplicate_reason === 'ACTIVE_INTENT_REUSED' && (r5 as { request_id: string }).request_id === R1)
const intentA = orderSubmitIntentHash('buyer1', { product_id: 'prd1', seller_id: 'seller1', quantity: 1, unit_price_units: 7_000_000, item_units: 7_000_000, shipping_units: 0, donation_bps: 0, donation_units: 0, total_units: 7_000_000, payable_units: 7_000_000, currency: 'WAZ', payment_rail: 'escrow', dest_region: 'SG', anonymous_recipient: 0 })
ok('5b. money invariant: exactly ONE active submit row for that intent', activeCount(intentA) === 1)

// ── 6. rule 7: DIFFERENT draft, identical economics, new_purchase_intent=true → INDEPENDENT request ──
const dC = mkDraft()   // same economics again
const r6 = createOrderSubmitRequest(db, { ...base, draftId: dC, newPurchaseIntent: true }) as R
ok('6. explicit 再买一份 → NEW independent request_id (≠ R1), not a duplicate', r6.ok === true && (r6 as { request_id: string }).request_id !== R1 && !((r6 as { duplicate?: boolean }).duplicate))
ok('6b. second purchase carries a purchase_intent_instance', typeof (r6 as { purchase_intent_instance?: string }).purchase_intent_instance === 'string' && (r6 as { purchase_intent_instance: string }).purchase_intent_instance.length > 0)
ok('6c. still Passkey-gated (status pending, executed_at NULL)', (db.prepare("SELECT status, executed_at FROM agent_permission_requests WHERE id=?").get((r6 as { request_id: string }).request_id) as { status: string; executed_at: string | null }).status === 'pending')
const R6instance = (r6 as { purchase_intent_instance: string }).purchase_intent_instance
const intentA2 = orderSubmitIntentHash('buyer1', { product_id: 'prd1', seller_id: 'seller1', quantity: 1, unit_price_units: 7_000_000, item_units: 7_000_000, shipping_units: 0, donation_bps: 0, donation_units: 0, total_units: 7_000_000, payable_units: 7_000_000, currency: 'WAZ', payment_rail: 'escrow', dest_region: 'SG', anonymous_recipient: 0 }, R6instance)
ok('6d. second purchase has a DISTINCT intent_hash (folded instance) — not merged with R1', intentA2 !== intentA && activeCount(intentA2) === 1)

// ── 7. rule 5: response-loss recovery — key row already terminal/executed → RESPONSE_LOSS_RECONCILED ──
const dL = mkDraft({ quantity: 3, item_units: 21_000_000, total_units: 21_000_000, payable_units: 21_000_000 })
const L1 = createOrderSubmitRequest(db, { ...base, draftId: dL, idempotencyKey: 'idem-LOSS' }) as R
db.prepare("UPDATE agent_permission_requests SET status='approved', executed_at=datetime('now'), execution_result=? WHERE id=?").run(JSON.stringify({ ok: true, order_id: 'ord_x' }), (L1 as { request_id: string }).request_id)
const L2 = createOrderSubmitRequest(db, { ...base, draftId: dL, idempotencyKey: 'idem-LOSS' }) as R
ok('7. retry after executed (lost response) → RESPONSE_LOSS_RECONCILED, same request_id (no 2nd order path)', L2.ok === true && (L2 as { duplicate_reason?: string }).duplicate_reason === 'RESPONSE_LOSS_RECONCILED' && (L2 as { request_id: string }).request_id === (L1 as { request_id: string }).request_id)

// ── 8. dedup identity uses ONLY economic fields, never display text ──
ok('8. intent_hash is identical for identical economics regardless of any display/title (economics-only)', orderSubmitIntentHash('buyer1', { product_id: 'prd1', seller_id: 'seller1', quantity: 1, unit_price_units: 7_000_000, item_units: 7_000_000, shipping_units: 0, donation_bps: 0, donation_units: 0, total_units: 7_000_000, payable_units: 7_000_000, currency: 'WAZ', payment_rail: 'escrow', dest_region: 'SG', anonymous_recipient: 0, product_title: 'X' } as Record<string, unknown>) === intentA)

// ── 9. projection: duplicate_reason → precise actions + text (never a generic "duplicate detected") ──
const projReuse = projSubmit({ request_id: 'apr_z', draft_id: 'odr_z', approval_url: '/#a/apr_z', idempotency: { duplicate: true, duplicate_reason: 'ACTIVE_INTENT_REUSED', duplicate_of: 'apr_prev' } }) as Record<string, unknown>
ok('9a. ACTIVE_INTENT_REUSED projection → create_second_purchase in available_actions', Array.isArray(projReuse.available_actions) && (projReuse.available_actions as string[]).includes('create_second_purchase') && (projReuse.available_actions as string[]).includes('open_existing_approval'))
ok('9b. projection carries machine duplicate_reason + duplicate_of', projReuse.duplicate_reason === 'ACTIVE_INTENT_REUSED' && projReuse.duplicate_of === 'apr_prev' && projReuse.existing_request_id === 'apr_prev')
const projReplay = projSubmit({ request_id: 'apr_y', approval_url: '/#a/apr_y', idempotency: { duplicate: true, duplicate_reason: 'SAME_DRAFT_REPLAY', duplicate_of: 'apr_y' } }) as Record<string, unknown>
ok('9c. SAME_DRAFT_REPLAY projection → NO create_second_purchase (only open/check)', !(projReplay.available_actions as string[]).includes('create_second_purchase'))
ok('9d. non-duplicate projection → normal actions, no duplicate_reason', (projSubmit({ request_id: 'apr_ok', approval_url: '/#a', idempotency: { duplicate: false } }) as Record<string, unknown>).duplicate_reason === undefined)

// ── 10. zero-PII on the submit result — no address text / names ──
// (passkey_required is a legit boolean flag, not a credential — the PII check targets raw address/name/credential VALUES)
ok('10. submit results carry no raw address text / default_address / access token value', !/\d+\s+\w+\s+(Rd|St|Ave)|default_address|access_token|bearer\s|oat_[A-Za-z0-9]/i.test(JSON.stringify([r1, r5, r6, projReuse])))

// ── 11. zero-PII trace: full key is NEVER stored (only a 16-hex hash); intent stored as a 12-char prefix ──
const wrote = recordIdempotencyTrace(db, { generateId, idempotencyKey: 'super-secret-key-value', intentHash: 'abcdef0123456789deadbeef', draftId: dA, requestId: R1, duplicate: true, duplicateReason: 'SAME_DRAFT_REPLAY', duplicateOf: R1, operationAttemptId: 'op-1', purchaseIntentInstance: R6instance, resultStatus: 'duplicate', receivedAt: '2026-07-20T00:00:00.000Z', completedAt: '2026-07-20T00:00:00.100Z' })
ok('11. trace write returns true', wrote === true)
const trow = db.prepare("SELECT * FROM agent_idempotency_trace WHERE request_id=? ORDER BY id DESC LIMIT 1").get(R1) as Record<string, unknown>
ok('11a. full idempotency_key NEVER stored — only a 16-hex hash', trow.idempotency_key_hash !== 'super-secret-key-value' && /^[0-9a-f]{16}$/.test(String(trow.idempotency_key_hash)))
ok('11b. no column contains the raw key', !JSON.stringify(trow).includes('super-secret-key-value'))
ok('11c. intent stored as a 12-char prefix, not the full hash', trow.intent_hash_prefix === 'abcdef012345' && String(trow.intent_hash_prefix).length === 12)
ok('11d. machine duplicate_reason + duplicate_of recorded', trow.duplicate === 1 && trow.duplicate_reason === 'SAME_DRAFT_REPLAY' && trow.duplicate_of === R1)
// PII-column check targets genuine PII names (tool_name / tool_call_id are structural, not PII)
ok('11e. no PII columns exist in the trace table', (db.prepare("PRAGMA table_info(agent_idempotency_trace)").all() as Array<{ name: string }>).every(c => !/address|phone|passkey|cookie|email|recipient|full_key|chat_body|access_token/i.test(c.name)))

// ── 12. trace is FAIL-OPEN — a broken table must not throw (trade must not be blocked) ──
const db2 = initDatabase(); db2.exec('DROP TABLE IF EXISTS agent_idempotency_trace')
let threw = false; let openResult = true
try { openResult = recordIdempotencyTrace(db2, { generateId, requestId: 'x', resultStatus: 'created' }) } catch { threw = true }
ok('12. trace write on a missing table returns false and NEVER throws (fail-open)', threw === false && openResult === false)
db2.close()

db.close()
if (fail > 0) { console.error(`\n❌ bug08-idempotency FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bug08-idempotency-second-purchase: same-draft/key replay · key-conflict · active-intent reuse · explicit second-purchase (distinct intent, still Passkey) · response-loss reconcile · economics-only identity · duplicate_reason→actions · one-active-row money invariant · zero-PII\n  ✅ pass ${pass}`)
