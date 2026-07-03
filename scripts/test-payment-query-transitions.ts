#!/usr/bin/env tsx
/**
 * PR-A state-machine guard — Direct Pay 货款协商(payment_query)转移。
 * 争议(协商)≠仲裁:卖家报未收款 accepted→payment_query(非仲裁);买家/卖家可协商关单、卖家可确认已收恢复履约、
 * 协商未果才 payment_query→disputed(需证据)升举证仲裁。验角色门 + 证据门 + 非法转移拒绝。
 * Usage: npm run test:payment-query-transitions
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'pq-tx-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { VALID_TRANSITIONS } = await import('../src/layer0-foundation/L0-2-state-machine/transitions.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
initOrderChainSchema(db)
initSystemUser(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s','seller','ks')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','b','buyer','kb')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('sys1','sys','system','ksys')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price) VALUES ('p1','s1','T','d',50)").run()
let oc = 0
const mkAccepted = (): string => { const id = `o_${++oc}`; db.prepare(`INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p1','b1','s1',1,50,50,0,'accepted','direct_p2p')`).run(id); return id }
const st = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status

try {
  // ── 1. transition-table shape (doc=code) ──
  ok('1a. accepted→payment_query exists, seller-only, no evidence', VALID_TRANSITIONS['accepted→payment_query']?.allowedRoles.join() === 'seller' && !VALID_TRANSITIONS['accepted→payment_query']?.requiresEvidence)
  ok('1b. payment_query→accepted seller-only (confirm received, resume)', VALID_TRANSITIONS['payment_query→accepted']?.allowedRoles.join() === 'seller')
  ok('1c. payment_query→cancelled buyer/seller/system', VALID_TRANSITIONS['payment_query→cancelled']?.allowedRoles.join() === 'buyer,seller,system')
  ok('1d. payment_query→disputed buyer/seller, REQUIRES evidence', VALID_TRANSITIONS['payment_query→disputed']?.allowedRoles.join() === 'buyer,seller' && VALID_TRANSITIONS['payment_query→disputed']?.requiresEvidence === true)
  ok('1e. disputed→payment_query (party withdraw + arbitrator dismiss via system) buyer/seller/system, no evidence', VALID_TRANSITIONS['disputed→payment_query']?.allowedRoles.join() === 'buyer,seller,system' && !VALID_TRANSITIONS['disputed→payment_query']?.requiresEvidence)

  // ── 2. accepted→payment_query: seller yes, buyer no ──
  const o1 = mkAccepted()
  ok('2a. seller reports non-payment (accepted→payment_query)', transition(db, o1, 'payment_query', 's1', [], 'seller: no payment received').success && st(o1) === 'payment_query')
  const o2 = mkAccepted()
  ok('2b. buyer CANNOT accepted→payment_query', !transition(db, o2, 'payment_query', 'b1', [], 'x').success)

  // ── 3. from payment_query ──
  const o3 = mkAccepted(); transition(db, o3, 'payment_query', 's1', [], '')
  ok('3a. seller confirms received → back to accepted (resume)', transition(db, o3, 'accepted', 's1', [], 'confirmed received').success && st(o3) === 'accepted')

  const o4 = mkAccepted(); transition(db, o4, 'payment_query', 's1', [], '')
  ok('3b. buyer cancels (concede) → cancelled', transition(db, o4, 'cancelled', 'b1', [], 'I did not pay').success && st(o4) === 'cancelled')

  const o5 = mkAccepted(); transition(db, o5, 'payment_query', 's1', [], '')
  ok('3c. escalate → disputed REQUIRES evidence (empty → rejected)', !transition(db, o5, 'disputed', 'b1', [], 'no evidence').success)
  ok('3d. escalate → disputed WITH evidence → disputed (举证仲裁)', transition(db, o5, 'disputed', 'b1', ['ev1'], 'payment proof').success && st(o5) === 'disputed')
  ok('3e. withdraw arbitration (disputed→payment_query) before ruling → back to negotiation', transition(db, o5, 'payment_query', 'b1', [], 'withdraw, keep negotiating').success && st(o5) === 'payment_query')

  // ── 4. no illegal shortcut: payment_query cannot jump to fulfilment ──
  const o6 = mkAccepted(); transition(db, o6, 'payment_query', 's1', [], '')
  ok('4a. payment_query→shipped is NOT a valid transition', !transition(db, o6, 'shipped', 's1', [], 'x').success)

  if (fail > 0) { console.error(`\n❌ payment_query transitions FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ payment_query transitions: seller-reported non-payment opens negotiation (not arbitration); confirm-received resumes; buyer/seller cancel; escalate→disputed only with evidence; no fulfilment shortcut\n  ✅ pass ${pass}`)
} catch (e) {
  console.error('❌ threw:', (e as Error).message, (e as Error).stack); process.exit(1)
}
