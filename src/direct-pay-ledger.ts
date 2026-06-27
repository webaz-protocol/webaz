/**
 * Direct Pay (Rail 1) 资金/科目助手 — RFC direct-payment Rail 1。
 * 设计稿: docs/modules/DIRECT-PAYMENT-MODULE-DESIGN.INTERNAL.md (Rev 2026-06-27e)
 *
 * 边界(铁律):
 *  - 本金(货款)不经协议;本文件只动【费用质押 fee-stake(WAZ 账本)】与【penalty 科目】。
 *  - base bond 是【外部担保物(USDC/法币)】经 gated deposit-rail;本文件【绝不移动真实外部资产】,
 *    base-bond 罚没只记 provenance(total_base_bond_slash + txn),真实外部处置 GATED(Phase 4 + 法务)。
 *  - penalty 科目【只进不出】:本文件【刻意不提供任何减少 penalty_fund.balance 的函数】
 *    = 出账无代码路径 = append-only 硬保证(设计稿 §10.1)。新增出账函数 = 违反不变量。
 *  - 所有函数必须在调用方 db.transaction 内调用(资金/状态路径)。整数 base-units,绝对值落库(RFC-014)。
 */
import type Database from 'better-sqlite3'
import { toUnits, toDecimal, allocate, type Units } from './money.js'
import { applyWalletDelta, walletUnits, creditColumns } from './ledger.js'

export interface FeeStakeRow { id: string; order_id: string; seller_id: string; amount: number; status: string }

/**
 * penalty 科目【唯一】写入口(只进,无对应出账函数)。
 *   - source='fee_stake' → 真入 WAZ balance(fee-stake 本就是 WAZ)。
 *   - source='base_bond' → 仅记 provenance 计数(外部资产,真实处置 gated;不进 balance)。
 */
function creditPenalty(db: Database.Database, opts: {
  kind: 'fee_stake_slash' | 'base_bond_slash'
  source: 'fee_stake' | 'base_bond'
  fromUserId?: string | null
  amountU: Units
  relatedOrderId?: string | null
  reason?: string | null
  txnId: string
}): void {
  const { kind, source, fromUserId = null, amountU, relatedOrderId = null, reason = null, txnId } = opts
  const deltas: Record<string, Units> = source === 'fee_stake'
    ? { balance: amountU, total_fee_stake_slash: amountU }   // WAZ 真入池
    : { total_base_bond_slash: amountU }                      // 外部资产:仅计数,不进 balance
  creditColumns(db, 'penalty_fund', "id = 'main'", [], deltas)
  db.prepare("UPDATE penalty_fund SET updated_at = datetime('now') WHERE id = 'main'").run()
  db.prepare(`INSERT INTO penalty_fund_txns (id, kind, source, from_user_id, amount, related_order_id, reason, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
    .run(txnId, kind, source, fromUserId, toDecimal(amountU), relatedOrderId, reason)
}

function getStake(db: Database.Database, orderId: string): FeeStakeRow | undefined {
  return db.prepare('SELECT id, order_id, seller_id, amount, status FROM direct_pay_fee_stakes WHERE order_id = ?')
    .get(orderId) as FeeStakeRow | undefined
}

/** 锁定逐单费用质押(= 平台费):卖家可用余额 → fee_staked。余额不足返回 {ok:false}(调用方不开单)。 */
export function lockFeeStake(db: Database.Database, opts: { orderId: string; sellerId: string; feeUnits: Units; stakeId: string }): { ok: boolean; reason?: string } {
  const { orderId, sellerId, feeUnits, stakeId } = opts
  if (feeUnits <= 0) return { ok: false, reason: 'fee must be > 0' }
  if (getStake(db, orderId)) return { ok: false, reason: 'fee-stake already exists for order' }
  const w = walletUnits(db, sellerId)
  if (w.balance < feeUnits) return { ok: false, reason: 'insufficient balance for fee-stake' }
  applyWalletDelta(db, sellerId, { balance: -feeUnits, fee_staked: feeUnits })
  db.prepare(`INSERT INTO direct_pay_fee_stakes (id, order_id, seller_id, amount, status, created_at) VALUES (?,?,?,?, 'locked', datetime('now'))`)
    .run(stakeId, orderId, sellerId, toDecimal(feeUnits))
  return { ok: true }
}

/**
 * 完成时取费:整笔 fee-stake → 协议(reserve 50% + sys_protocol 50%,与 settleOrder 协议费去向一致)。
 * 幂等:非 locked 不重复。fee-stake == 平台费,故无 remainder(若将来 stake>fee 可在此退差额给卖家)。
 */
export function takeFeeAtCompletion(db: Database.Database, opts: { orderId: string }): void {
  const s = getStake(db, opts.orderId)
  if (!s || s.status !== 'locked') return
  const feeU = toUnits(s.amount)
  applyWalletDelta(db, s.seller_id, { fee_staked: -feeU })
  const [toReserveU, toOpsU] = allocate(feeU, [1, 1])
  if (toReserveU > 0) creditColumns(db, 'protocol_reserve_pool', 'id = 1', [], { balance: toReserveU })
  if (toOpsU > 0) applyWalletDelta(db, 'sys_protocol', { balance: toOpsU })
  db.prepare("UPDATE direct_pay_fee_stakes SET status='fee_taken', settled_at=datetime('now') WHERE order_id=? AND status='locked'").run(opts.orderId)
}

/** 释放(未付/取消/超时):整笔退回卖家可用余额。幂等。 */
export function releaseFeeStake(db: Database.Database, opts: { orderId: string }): void {
  const s = getStake(db, opts.orderId)
  if (!s || s.status !== 'locked') return
  const feeU = toUnits(s.amount)
  applyWalletDelta(db, s.seller_id, { fee_staked: -feeU, balance: feeU })
  db.prepare("UPDATE direct_pay_fee_stakes SET status='released', settled_at=datetime('now') WHERE order_id=? AND status='locked'").run(opts.orderId)
}

/** 违约罚没:整笔 fee-stake → penalty 科目(feeRetainedOnFault=false → WebAZ 不收费,整笔入池)。幂等。 */
export function slashFeeStakeToPenalty(db: Database.Database, opts: { orderId: string; txnId: string; reason?: string }): void {
  const s = getStake(db, opts.orderId)
  if (!s || s.status !== 'locked') return
  const feeU = toUnits(s.amount)
  applyWalletDelta(db, s.seller_id, { fee_staked: -feeU })
  creditPenalty(db, { kind: 'fee_stake_slash', source: 'fee_stake', fromUserId: s.seller_id, amountU: feeU, relatedOrderId: opts.orderId, reason: opts.reason ?? null, txnId: opts.txnId })
  db.prepare("UPDATE direct_pay_fee_stakes SET status='slashed', settled_at=datetime('now') WHERE order_id=? AND status='locked'").run(opts.orderId)
}

/**
 * base bond(外部担保物)罚没:仅记 provenance(total_base_bond_slash + txn),不进 WAZ balance。
 * 真实外部资产(USDC/法币)处置 GATED(deposit-rail 非生产 / 法务)。由 Phase 4 deposit 生命周期调用。
 */
export function recordBaseBondSlash(db: Database.Database, opts: { userId: string; amountUnits: Units; txnId: string; reason?: string }): void {
  if (opts.amountUnits <= 0) return
  creditPenalty(db, { kind: 'base_bond_slash', source: 'base_bond', fromUserId: opts.userId, amountU: opts.amountUnits, relatedOrderId: null, reason: opts.reason ?? null, txnId: opts.txnId })
}
