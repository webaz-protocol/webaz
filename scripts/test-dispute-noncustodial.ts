#!/usr/bin/env tsx
/**
 * P0 regression — non-custodial (direct_p2p) dispute arbitration must move ZERO funds.
 *
 * For a direct_p2p order the protocol never held the buyer's principal (escrow_amount=0, buyer paid the seller
 * off-app). The dispute engine used to run executeSettlement/executeLiabilitySplit unconditionally, which for a
 * refund_buyer ruling did applyWalletDelta(buyer,{escrowed:-total,balance:+total}) — minting real balance out of
 * escrow that never existed, and (release/partial) charging phantom commission/fees. This guards the fix:
 * non_custodial → reputation-only terminal transition, no wallet/escrow/stake/commission/arbitration-fee moves.
 * Escrow orders must still settle (regression).
 * Usage: npm run test:dispute-noncustodial
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dispute-nc-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initDisputeSchema, arbitrateDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { applyWalletDelta } = await import('../src/ledger.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
initOrderChainSchema(db)
initSystemUser(db)
initDisputeSchema(db)
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance, escrowed, staked, earned) VALUES ('sys_protocol',0,0,0,0)").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','b','buyer','kb')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','s','seller','ks')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('arb1','a','arbitrator','ka')").run()
db.prepare("INSERT INTO wallets (user_id,balance,escrowed,staked,earned) VALUES ('buyer1',1000,0,0,0)").run()
db.prepare("INSERT INTO wallets (user_id,balance,escrowed,staked,earned) VALUES ('seller1',1000,0,0,0)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stake_amount) VALUES ('p1','seller1','T','d',50,10)").run()

const wsnap = () => ['buyer1', 'seller1', 'sys_protocol'].map(u => JSON.stringify(db.prepare('SELECT balance,escrowed,staked,earned FROM wallets WHERE user_id=?').get(u)))
const ostatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
let oc = 0, dc = 0
function mkDispute(rail: string): { orderId: string; dispId: string } {
  const orderId = `o_${++oc}`, dispId = `dsp_${++dc}`
  const esc = rail === 'direct_p2p' ? 0 : 50
  db.prepare(`INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail)
     VALUES (?, 'p1','buyer1','seller1',1,50,50,?, 'disputed', ?)`).run(orderId, esc, rail)
  if (rail !== 'direct_p2p') applyWalletDelta(db, 'buyer1', { escrowed: toUnits(50) })   // escrow order: principal actually escrowed
  db.prepare(`INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status) VALUES (?,?, 'buyer1','seller1','test','in_review')`).run(dispId, orderId)
  return { orderId, dispId }
}

const RULINGS: Array<['refund_buyer' | 'release_seller' | 'partial_refund' | 'liability_split', string]> = [
  ['refund_buyer', 'refunded_full'], ['release_seller', 'resolved_for_seller'],
  ['partial_refund', 'refunded_partial'], ['liability_split', 'refunded_partial'],
]

try {
  // ── 1. direct_p2p: every ruling → terminal state, ZERO fund movement, non_custodial flag, no arbitration fee ──
  for (const [ruling, terminal] of RULINGS) {
    const { orderId, dispId } = mkDispute('direct_p2p')
    const before = wsnap()
    const parties = ruling === 'liability_split' ? [{ user_id: 'seller1', role: 'seller', amount: 50 }] : undefined
    const r = arbitrateDispute(db, dispId, 'arb1', ruling, 'reason', ruling === 'partial_refund' ? 25 : undefined, parties as any)
    ok(`1.${ruling} → success + non_custodial`, r.success === true && r.non_custodial === true, JSON.stringify(r))
    ok(`1.${ruling} → order terminal ${terminal}`, ostatus(orderId) === terminal, ostatus(orderId))
    ok(`1.${ruling} → ZERO wallet movement (no mint)`, JSON.stringify(wsnap()) === JSON.stringify(before))
    ok(`1.${ruling} → no arbitration fee charged`, Object.keys((r.settlement as any)?.arbitration_fees || {}).length === 0)
    ok(`1.${ruling} → message is reputation-only + explicitly disclaims funds`, /信誉裁决/.test(String(r.message)) && /不发生/.test(String(r.message)) && /(胜诉|责任)/.test(String(r.message)))
  }

  // ── 2. escrow regression: refund_buyer still moves funds (buyer escrowed→balance) ──
  const { orderId: eo, dispId: ed } = mkDispute('escrow')
  const b0 = db.prepare("SELECT balance,escrowed FROM wallets WHERE user_id='buyer1'").get() as { balance: number; escrowed: number }
  const er = arbitrateDispute(db, ed, 'arb1', 'refund_buyer', 'reason')
  const b1 = db.prepare("SELECT balance,escrowed FROM wallets WHERE user_id='buyer1'").get() as { balance: number; escrowed: number }
  ok('2. escrow refund_buyer → non_custodial=false', er.success === true && er.non_custodial === false)
  ok('2. escrow refund_buyer → order refunded_full', ostatus(eo) === 'refunded_full')
  ok('2. escrow refund_buyer → buyer escrowed released + balance credited (funds moved)', b1.escrowed === b0.escrowed - 50 && b1.balance >= b0.balance + 50)

  if (fail > 0) { console.error(`\n❌ dispute non-custodial FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ dispute non-custodial: direct_p2p arbitration is reputation-only (zero fund/stake/commission/arb-fee moves, terminal transition, non_custodial flag) · escrow still settles\n  ✅ pass ${pass}`)
} catch (e) {
  console.error('❌ threw:', (e as Error).message, (e as Error).stack); process.exit(1)
}
