#!/usr/bin/env tsx
/**
 * 协商取消(mutual cancel)域引擎测试 —— 无责·双方合意取消 disputed 订单。
 *  证明:握手(propose/accept/decline/withdraw)+ 当事方边界 + 竞态守卫 + 资金守恒(托管退款/直付零资金)
 *       + 争议同事务 resolved(自动裁决不二次结算)+ 零信誉影响。
 * Usage: npm run test:mutual-cancel
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'mc-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const D = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const MC = await import('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initOrderChainSchema(db); D.initDisputeSchema(db); D.initEvidenceRequestSchema(db); MC.initMutualCancelSchema(db)

const mkUser = (id: string, role = 'buyer'): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  db.prepare('INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES (?,0,0,0,0)').run(id)
}
mkUser('buyer', 'buyer'); mkUser('seller', 'seller'); mkUser('outsider', 'buyer')
try { db.exec('ALTER TABLE orders ADD COLUMN bid_stake_held REAL DEFAULT 0') } catch { /* server.ts ALTER,真实库已有 */ }
try { db.exec('ALTER TABLE orders ADD COLUMN stake_backing REAL DEFAULT 0') } catch { /* server.ts ALTER,真实库已有 */ }
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stake_amount) VALUES ('p1','seller','P','d',50,10)").run()  // 商品名义 stake_amount=10(当前 escrow 不据此锁 stake → 结算不得读它)

let oc = 0
// bidStakeHeld = 本订单【真实锁定】的卖家质押(中标单模型:award 时 balance→staked);同步把它记进 seller.staked。
function mkOrder(rail: 'direct_p2p' | 'escrow', bidStakeHeld = 0): { orderId: string; disputeId: string } {
  const orderId = `o_${++oc}`
  const escrow = rail === 'escrow' ? 50 : 0
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail,bid_stake_held) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(orderId, 'p1', 'buyer', 'seller', 1, 50, 50, escrow, 'disputed', rail, bidStakeHeld)
  if (rail === 'escrow') db.prepare("UPDATE wallets SET escrowed=50 WHERE user_id='buyer'").run()   // 建单只锁买家托管(orders-create 现实:stake_backing 恒 0,不锁卖家 stake)
  if (bidStakeHeld > 0) db.prepare("UPDATE wallets SET staked=staked+? WHERE user_id='seller'").run(bidStakeHeld)  // 中标质押真实进 seller.staked
  const r = D.createDispute(db, orderId, 'buyer', '双方想直接取消', [])
  if (!r.success) throw new Error('createDispute failed: ' + r.error)
  return { orderId, disputeId: r.disputeId as string }
}
const oStatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const dStatus = (id: string) => (db.prepare('SELECT status FROM disputes WHERE id=?').get(id) as { status: string }).status
const dVerdict = (id: string) => (db.prepare('SELECT verdict FROM disputes WHERE id=?').get(id) as { verdict: string | null }).verdict
const wallet = (uid: string) => db.prepare('SELECT balance,staked,escrowed,earned FROM wallets WHERE user_id=?').get(uid) as Record<string, number>
const lossCount = () => (db.prepare("SELECT dispute_loss_count c FROM products WHERE id='p1'").get() as { c: number }).c
const totalMoney = () => ['buyer', 'seller', 'sys_protocol', 'outsider'].reduce((s, u) => { const w = wallet(u) || { balance: 0, staked: 0, escrowed: 0, earned: 0 }; return s + (w.balance || 0) + (w.staked || 0) + (w.escrowed || 0) + (w.earned || 0) }, 0)

let pc = 0
const nid = () => `mcp_${++pc}`

// ① 当事方边界:外人 / 非当事方不能提议
{ const { orderId } = mkOrder('direct_p2p')
  ok('1. outsider cannot propose (NOT_A_PARTY)', MC.proposeMutualCancel(db, orderId, 'outsider', null, nid()).error_code === 'NOT_A_PARTY') }

// ② 非争议订单不能协商取消
{ const orderId = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?,?,?,?,1,50,50,0,'paid','direct_p2p')").run(orderId, 'p1', 'buyer', 'seller')
  ok('2. non-disputed order → ORDER_NOT_DISPUTED', MC.proposeMutualCancel(db, orderId, 'buyer', null, nid()).error_code === 'ORDER_NOT_DISPUTED') }

// ③ 提议 + 状态 + 不能确认自己的提议
{ const { orderId } = mkOrder('direct_p2p')
  const p = MC.proposeMutualCancel(db, orderId, 'buyer', '不想买了', nid())
  ok('3a. buyer proposes → pending', p.ok === true && p.status === 'pending')
  ok('3b. buyer re-propose → ALREADY_PROPOSED', MC.proposeMutualCancel(db, orderId, 'buyer', null, nid()).error_code === 'ALREADY_PROPOSED')
  ok('3c. proposer cannot accept own → CANNOT_ACCEPT_OWN', MC.acceptMutualCancel(db, orderId, 'buyer').error_code === 'CANNOT_ACCEPT_OWN')
  const stSeller = MC.getMutualCancelState(db, orderId, 'seller')
  ok('3d. counterparty state: can_accept', stSeller.can_accept === true && stSeller.can_propose === false)
  const stBuyer = MC.getMutualCancelState(db, orderId, 'buyer')
  ok('3e. proposer state: can_withdraw', stBuyer.can_withdraw === true && stBuyer.can_accept === false) }

// ④ 直付(非托管)accept:零资金,order=cancelled,dispute=resolved(verdict=mutual_cancel),零信誉
{ const before = totalMoney(); const lc0 = lossCount()
  const { orderId, disputeId } = mkOrder('direct_p2p')
  MC.proposeMutualCancel(db, orderId, 'buyer', null, nid())
  const a = MC.acceptMutualCancel(db, orderId, 'seller')
  ok('4a. counterparty accept ok (non_custodial)', a.ok === true && (a.settlement as any)?.non_custodial === true && (a.settlement as any)?.buyer_refund === 0)
  ok('4b. order → cancelled', oStatus(orderId) === 'cancelled')
  ok('4c. dispute → resolved, verdict=mutual_cancel', dStatus(disputeId) === 'resolved' && dVerdict(disputeId) === 'mutual_cancel')
  ok('4d. zero money moved (non-custodial)', totalMoney() === before)
  ok('4e. zero reputation impact (dispute_loss_count unchanged)', lossCount() === lc0)
  ok('4f. second accept → ORDER_NOT_DISPUTED (idempotent/terminal)', MC.acceptMutualCancel(db, orderId, 'seller').error_code === 'ORDER_NOT_DISPUTED') }

// ⑤ 托管 accept —— 真实当前模型:product.stake_amount>0 但 order.stake_backing=0 且 seller.staked=0。
//    买家全额退款,卖家【钱包不变】(不得据商品名义 stake_amount 释放不存在的质押 → 防负 staked / 凭空印钱)。
{ db.prepare("UPDATE wallets SET balance=0,staked=0,escrowed=0,earned=0 WHERE user_id IN ('buyer','seller')").run()
  const { orderId, disputeId } = mkOrder('escrow')   // bid_stake_held=0 → seller.staked 保持 0
  const before = totalMoney()
  MC.proposeMutualCancel(db, orderId, 'seller', '协商取消', nid())
  const a = MC.acceptMutualCancel(db, orderId, 'buyer')
  ok('5a. escrow accept ok, buyer_refund=50, stake_returned=0 (无锁定 stake)', a.ok === true && (a.settlement as any)?.buyer_refund === 50 && (a.settlement as any)?.seller_stake_returned === 0)
  const wb = wallet('buyer'); const ws = wallet('seller')
  ok('5b. buyer escrow→balance (balance=50, escrowed=0)', wb.balance === 50 && wb.escrowed === 0)
  ok('5c. seller wallet UNCHANGED (staked=0, balance=0 —— 未印钱/未打负)', ws.staked === 0 && ws.balance === 0)
  ok('5d. money conserved', totalMoney() === before)
  ok('5e. order cancelled + dispute resolved', oStatus(orderId) === 'cancelled' && dStatus(disputeId) === 'resolved') }

// ⑤bis 托管 + 【真实锁定】的中标质押(order.bid_stake_held=10, seller.staked=10)→ 无责返还恰好 10,守恒
{ db.prepare("UPDATE wallets SET balance=0,staked=0,escrowed=0,earned=0 WHERE user_id IN ('buyer','seller')").run()
  const { orderId } = mkOrder('escrow', 10)   // 中标质押 10 真实进 seller.staked
  const before = totalMoney()
  MC.proposeMutualCancel(db, orderId, 'buyer', null, nid())
  const a = MC.acceptMutualCancel(db, orderId, 'seller')
  const ws = wallet('seller')
  ok('5bis-a. locked bid stake returned exactly 10', (a.settlement as any)?.seller_stake_returned === 10 && ws.staked === 0 && ws.balance === 10)
  ok('5bis-b. buyer refunded 50 + money conserved', wallet('buyer').balance === 50 && totalMoney() === before) }

// ⑤ter 防负护栏:订单声称 bid_stake_held=10,但 seller.staked 实际只有 0(错配/边界)→ cap 到实际 staked=0,不返还、不打负
{ db.prepare("UPDATE wallets SET balance=0,staked=0,escrowed=0,earned=0 WHERE user_id IN ('buyer','seller')").run()
  const orderId = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail,bid_stake_held) VALUES (?,?,'buyer','seller',1,50,50,50,'disputed','escrow',10)").run(orderId, 'p1')
  db.prepare("UPDATE wallets SET escrowed=50 WHERE user_id='buyer'").run()   // 只锁买家托管;seller.staked 故意保持 0(声称有 10 但实际没锁)
  const r = D.createDispute(db, orderId, 'buyer', 'x', []); if (!r.success) throw new Error(r.error)
  MC.proposeMutualCancel(db, orderId, 'seller', null, nid())
  const a = MC.acceptMutualCancel(db, orderId, 'buyer')
  const ws = wallet('seller')
  ok('5ter. cap to real staked: stake_returned=0, seller.staked NOT negative (=0), no phantom balance', a.ok === true && (a.settlement as any)?.seller_stake_returned === 0 && ws.staked === 0 && ws.balance === 0)
  ok('5ter-b. buyer still refunded 50', wallet('buyer').balance === 50 && oStatus(orderId) === 'cancelled') }

// ⑥ 竞态:争议被自动裁决(resolved)后 accept 失败,且 checkDisputeTimeouts 不再动已协商取消的订单
{ const { orderId, disputeId } = mkOrder('direct_p2p')
  MC.proposeMutualCancel(db, orderId, 'buyer', null, nid())
  MC.acceptMutualCancel(db, orderId, 'seller')   // → cancelled + dispute resolved
  db.prepare("UPDATE disputes SET arbitrate_deadline='2000-01-01 00:00:00', status=status WHERE id=?").run(disputeId)  // 即便塞了过期 deadline
  D.checkDisputeTimeouts(db)                       // 只扫 open|in_review → resolved 争议被跳过
  ok('6. cron leaves mutually-cancelled order alone (still cancelled)', oStatus(orderId) === 'cancelled' && dStatus(disputeId) === 'resolved') }

// ⑦ withdraw / decline
{ const { orderId } = mkOrder('direct_p2p')
  MC.proposeMutualCancel(db, orderId, 'buyer', null, nid())
  ok('7a. non-proposer cannot withdraw', MC.withdrawMutualCancel(db, orderId, 'seller').error_code === 'NOT_PROPOSER')
  ok('7b. proposer withdraws', MC.withdrawMutualCancel(db, orderId, 'buyer').ok === true)
  ok('7c. after withdraw, seller can propose fresh', MC.proposeMutualCancel(db, orderId, 'seller', null, nid()).ok === true)
  ok('7d. proposer cannot decline own', MC.declineMutualCancel(db, orderId, 'seller').error_code === 'CANNOT_DECLINE_OWN')
  ok('7e. counterparty declines', MC.declineMutualCancel(db, orderId, 'buyer').ok === true)
  ok('7f. after decline no pending → buyer can propose again', MC.getMutualCancelState(db, orderId, 'buyer').can_propose === true) }

// ⑧ 读也 party-gated:非当事人 getMutualCancelState → NOT_A_PARTY,绝不泄露提议/理由/发起方
{ const { orderId } = mkOrder('direct_p2p')
  MC.proposeMutualCancel(db, orderId, 'buyer', '敏感理由', nid())
  const outs = MC.getMutualCancelState(db, orderId, 'outsider')
  ok('8a. outsider read → NOT_A_PARTY, no proposal leaked', outs.ok === false && outs.error_code === 'NOT_A_PARTY' && outs.proposal === undefined)
  ok('8b. party read still works (sees proposal)', (MC.getMutualCancelState(db, orderId, 'seller').proposal as any)?.reason === '敏感理由') }

// ⑨ 托管买家 escrowed 不足全额 → FAIL-CLOSED:ESCROW_INSUFFICIENT,不退/不关单/不结案,钱包不动
{ db.prepare("UPDATE wallets SET balance=0,staked=0,escrowed=0,earned=0 WHERE user_id IN ('buyer','seller')").run()
  const orderId = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?,?,'buyer','seller',1,50,50,50,'disputed','escrow')").run(orderId, 'p1')
  db.prepare("UPDATE wallets SET escrowed=30 WHERE user_id='buyer'").run()   // 只有 30,少于订单 50(账目不一致)
  const r = D.createDispute(db, orderId, 'buyer', 'x', []); if (!r.success) throw new Error(r.error)
  const before = totalMoney()
  MC.proposeMutualCancel(db, orderId, 'seller', null, nid())
  const a = MC.acceptMutualCancel(db, orderId, 'buyer')
  ok('9a. accept → ESCROW_INSUFFICIENT (fail-closed)', a.ok === false && a.error_code === 'ESCROW_INSUFFICIENT')
  ok('9b. order NOT closed (still disputed), dispute still active', oStatus(orderId) === 'disputed' && dStatus((db.prepare("SELECT id FROM disputes WHERE order_id=?").get(orderId) as any).id) !== 'resolved')
  ok('9c. no wallet moved (buyer escrowed 仍 30, no partial refund)', wallet('buyer').escrowed === 30 && wallet('buyer').balance === 0 && totalMoney() === before) }

if (fail > 0) { console.error(`\n❌ mutual-cancel FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mutual-cancel: handshake + party-boundary + race-safe + escrow-refund conservation + direct_p2p zero-funds + dispute resolved + zero reputation\n  ✅ pass ${pass}`)
