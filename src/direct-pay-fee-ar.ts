/**
 * Direct Pay 平台服务费 —— 首单宽限 + 预充值续用 helper。设计稿 DIRECT-PAY-FEE-RECEIVABLE-DESIGN.INTERNAL.md。
 *
 * 模型:建单不收费;首单宽限(从无 direct_p2p 成交且无在途单 → 放行第一笔);首单后须有足够【预充值余额】
 *   覆盖在途+本单平台费;完成时记一笔平台费应收(receivable)。供建单门(direct-pay-create.ts)、
 *   完成结算(server.ts settleOrder)、后续 admin/ops 视图消费。
 *
 * 边界(铁律):
 *  - 平台服务费/预充值 = 卖家 ↔ WebAZ 私有;买家侧任何接口不得返回(DTO 脱敏)。【商家平台服务费预付款】,非买家 escrow / 非保证金 / 非 penalty。
 *  - 不碰买家本金 / escrow / base-bond collateral / penalty 科目。
 *  - 额度【非硬编码、非固定参数】= 商家实际预充值余额(数据驱动);首单宽限自动判定;读不到即 fail-closed(返 0 / 不给宽限)。
 *  - available_prepay 由【Σ payments(invoice_id NULL) + Σ adjustments − Σ receivables】派生,不依赖任何可变 status 列(append-only)。
 *  - 整数 base-units(RFC-014 money.ts);金额列存 REAL 小数,经 toUnits 进 units 域比较。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { toUnits, toDecimal, mulRate, type Units } from './money.js'
import { releaseFeeStake } from './direct-pay-ledger.js'

export const FEE_AR_CURRENCY = 'usdc' // v1 单一计价币

/** 平台费率单一真相源:二手 1% / 其它 2%(与 settleOrder escrow 分支同口径)。create / 完成 accrue / 在途预估 全走这里防漂移。 */
export function feeUnitsForOrder(totalAmountU: Units, source: string | null | undefined): Units {
  return mulRate(totalAmountU, source === 'secondhand' ? 0.01 : 0.02)
}

/** 开放(未完全关闭、仍会 accrue 费)的 direct_p2p 单状态。完成单已在 receivables(借记预充值),故【不含】completed/终态。 */
export const OPEN_FEE_ACCRUING_STATUSES = [
  'created', 'pending_accept', 'direct_pay_window', 'direct_expired_unconfirmed',
  'accepted', 'shipped', 'picked_up', 'in_transit', 'delivered', 'confirmed', 'disputed',
] as const   // pending_accept(手动接单待确认)保守计入在途:未接单也占预估费口径,防开一堆待接单绕过预充值门

/** 某 SUM 查询结果 → units(空表/NULL → 0)。SUM 的是整数 units 值存成的 REAL,toUnits 精确还原。 */
function sumUnits(db: Database.Database, sql: string, sellerId: string): Units {
  const row = db.prepare(sql).get(sellerId) as { s: number | null } | undefined
  const v = row?.s
  if (v === null || v === undefined || !Number.isFinite(v)) return 0
  return toUnits(v)
}

/** 商家已计提平台费合计(units)= Σ receivables.amount。表缺失→0(休眠安全)。 */
export function getSellerAccruedFeeUnits(db: Database.Database, sellerId: string): Units {
  try { return sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_receivables WHERE seller_id = ?', sellerId) } catch { return 0 }
}

/**
 * 商家平台服务费【可用预充值余额】(units)。模型 = 预付款续用(非赊账):
 *   available = Σ top-ups(direct_pay_fee_payments, invoice_id IS NULL = 未分配预充值)
 *             + Σ adjustments.delta_amount(签名;正=预充值贷记,负=借记;本轮无写入)
 *             − Σ receivables.amount(已计提平台费 = 对预充值的借记)
 * 余额可为负 = 首单宽限完成后未充值形成的欠款(见 §grace)。表缺失→0(休眠安全,配合 gate fail-closed)。
 * ⚠️ 这是【商家平台服务费预付款】事实派生,非买家 escrow / 非保证金 / 非 penalty。
 */
export function readAvailableFeePrepayUnits(db: Database.Database, sellerId: string): Units {
  let topups = 0, adjusted = 0, accrued = 0, refunded = 0
  try { topups = sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_payments WHERE seller_id = ? AND invoice_id IS NULL', sellerId) } catch { return 0 }
  try { adjusted = sumUnits(db, 'SELECT SUM(delta_amount) AS s FROM direct_pay_fee_adjustments WHERE seller_id = ?', sellerId) } catch { adjusted = 0 }
  try { accrued = sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_receivables WHERE seller_id = ?', sellerId) } catch { accrued = 0 }
  try { refunded = sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_prepay_refunds WHERE seller_id = ?', sellerId) } catch { refunded = 0 }
  return topups + adjusted - accrued - refunded
}

export interface DirectPayFeeAccount {
  sellerId: string
  availableUnits: Units      // = topups + adjustments − accrued − refunds(可负=首单宽限欠款)
  topupUnits: Units          // Σ 预充值(invoice_id NULL)
  accruedUnits: Units        // Σ 已计提平台费(receivables)
  adjustmentUnits: Units     // Σ 账务更正(signed)
  refundUnits: Units         // Σ 余额退款
  openEstFeeUnits: Units     // 在途单预估费(下一单门会再要求)
  graceEligible: boolean     // 是否仍享首单宽限
}

/** 单一真相源:某商家平台服务费账户汇总(admin 视图 / seller fee center 都读它,口径一致)。 */
export function getDirectPayFeeAccount(db: Database.Database, sellerId: string): DirectPayFeeAccount {
  const topupUnits = (() => { try { return sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_payments WHERE seller_id = ? AND invoice_id IS NULL', sellerId) } catch { return 0 } })()
  const accruedUnits = getSellerAccruedFeeUnits(db, sellerId)
  const adjustmentUnits = (() => { try { return sumUnits(db, 'SELECT SUM(delta_amount) AS s FROM direct_pay_fee_adjustments WHERE seller_id = ?', sellerId) } catch { return 0 } })()
  const refundUnits = (() => { try { return sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_prepay_refunds WHERE seller_id = ?', sellerId) } catch { return 0 } })()
  return {
    sellerId,
    availableUnits: topupUnits + adjustmentUnits - accruedUnits - refundUnits,
    topupUnits, accruedUnits, adjustmentUnits, refundUnits,
    openEstFeeUnits: estimateOpenDirectPayFeeUnits(db, sellerId),
    graceEligible: sellerDirectPayGraceEligible(db, sellerId),
  }
}

/**
 * 首单宽限资格:商家此前【从无】direct_p2p 成交且【无】在途单 —— 即这是其第一笔 direct_p2p。
 *   grace = (completed direct_p2p 数 == 0) AND (open/in-flight direct_p2p 数 == 0)。
 * 杜绝"多笔并发首单都拿宽限":有任何在途单即不再宽限。已完成单不计入(cancelled/expired 等终态不阻 grace,
 *   因其从未计提费、无欠款)。fail-closed:查询异常 → 返回 false(= 不给宽限,要求预充值,安全侧)。
 */
export function sellerDirectPayGraceEligible(db: Database.Database, sellerId: string): boolean {
  const ph = OPEN_FEE_ACCRUING_STATUSES.map(() => '?').join(',')
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND status IN (${ph}, 'completed')`,
    ).get(sellerId, ...OPEN_FEE_ACCRUING_STATUSES) as { n: number } | undefined
    return (row?.n ?? 1) === 0
  } catch { return false }
}

/**
 * 纯函数:建单【预充值门】判定。
 *   - 首单宽限(graceEligible)→ 直接放行(降低首次使用摩擦;其余资格门照旧另判)。
 *   - 非首单 → 要求 available_prepay ≥ 在途单预估费 + 本单预估费(预付款须覆盖在途+本单平台费)。
 * 余额不足/为负 → 拒(fail-closed:available 读不到=0=拒非首单)。
 */
export function feePrepayGateOk(args: {
  graceEligible: boolean; availablePrepayUnits: Units; openOrdersEstFeeUnits: Units; newOrderFeeUnits: Units
}): boolean {
  if (args.graceEligible) return true
  return args.availablePrepayUnits >= args.openOrdersEstFeeUnits + args.newOrderFeeUnits
}

export interface RecordFeePrepayResult { ok: boolean; error?: string; id?: string }

/**
 * 记录一笔【商家平台服务费预付款】(append-only 事实行,invoice_id NULL = 未分配预充值 → 计入 available)。
 * 唯一 prepay top-up 写入口;由 ROOT + 真人 Passkey 的 admin 端点调用(身份/Passkey 由调用方 route 强制,本 helper 不验证)。
 * ⚠️ 商家平台服务费预付款,非买家 escrow / 非保证金 / 非 penalty。不碰 buyer wallet/escrow/order/settlement。
 * 校验:seller 非空、amount > 0(整数 base-units)、method ∈ {usdc,fiat}。本轮【不做】余额退款(无负额/无 refund kind)。
 */
export function recordFeePrepayTopup(
  db: Database.Database,
  args: { sellerId: string; amountUnits: Units; method: string; recordedBy: string; evidenceRef?: string; note?: string },
): RecordFeePrepayResult {
  if (!args.sellerId) return { ok: false, error: 'MISSING_SELLER' }
  if (!Number.isFinite(args.amountUnits) || !Number.isInteger(args.amountUnits) || args.amountUnits <= 0) return { ok: false, error: 'AMOUNT_MUST_BE_POSITIVE' }
  if (args.method !== 'usdc' && args.method !== 'fiat') return { ok: false, error: 'BAD_METHOD' }
  const id = 'dpfp_' + randomUUID()
  // 台账行 + 统一 admin_audit_log 同事务写(与 KYB/sanctions/AML ingress 一致;money-adjacent admin 动作必留痕)。
  // 审计 detail PII-free:不存 raw evidence_ref / note,仅记 presence。
  db.transaction(() => {
    db.prepare(
      `INSERT INTO direct_pay_fee_payments (id, seller_id, invoice_id, amount, currency, method, received_at, recorded_by, evidence_ref, note)
       VALUES (?,?,NULL,?, '${FEE_AR_CURRENCY}', ?, datetime('now'), ?, ?, ?)`,
    ).run(id, args.sellerId, toDecimal(args.amountUnits), args.method, args.recordedBy, args.evidenceRef ?? null, args.note ?? null)
    db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
      .run('dpfpaud_' + randomUUID(), args.recordedBy, 'direct_pay.fee_prepay_record', 'user', args.sellerId,
        JSON.stringify({ payment_id: id, amount_units: args.amountUnits, method: args.method, evidence_ref_present: !!args.evidenceRef }))
  })()
  return { ok: true, id }
}

/**
 * 账务【更正】(adjustments.kind='correction',带符号 delta)。≠ 退款:更正只调记账(不一定动真钱),
 * 退款(recordFeePrepayRefund)是真实退钱。delta 正=增 available / 负=减。append-only + admin_audit_log 同事务。
 */
export function recordFeePrepayAdjustment(
  db: Database.Database,
  args: { sellerId: string; deltaUnits: Units; reason: string; recordedBy: string },
): RecordFeePrepayResult {
  if (!args.sellerId) return { ok: false, error: 'MISSING_SELLER' }
  if (!Number.isFinite(args.deltaUnits) || !Number.isInteger(args.deltaUnits) || args.deltaUnits === 0) return { ok: false, error: 'DELTA_MUST_BE_NONZERO_INT' }
  if (!args.reason) return { ok: false, error: 'MISSING_REASON' }
  const id = 'dpadj_' + randomUUID()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO direct_pay_fee_adjustments (id, receivable_id, seller_id, delta_amount, currency, kind, reason, created_at, created_by)
       VALUES (?,NULL,?,?, '${FEE_AR_CURRENCY}', 'correction', ?, datetime('now'), ?)`,
    ).run(id, args.sellerId, toDecimal(args.deltaUnits), args.reason, args.recordedBy)
    db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
      .run('dpadjaud_' + randomUUID(), args.recordedBy, 'direct_pay.fee_adjust', 'user', args.sellerId,
        JSON.stringify({ adjustment_id: id, delta_units: args.deltaUnits, reason_present: !!args.reason }))
  })()
  return { ok: true, id }
}

/**
 * 余额【退款】(真实退还已预付未消耗的平台服务费;链下退款,记 evidence_ref)。append-only + admin_audit_log 同事务。
 * 校验:seller 非空、amount>0 整数 base-units、method ∈ {usdc,fiat}、**amount ≤ 可退自由余额 = available − 在途预估费**。
 *   ⚠️ 退款必须【预留在途单将计提的平台费】(openEst):否则把"已被在途单占用"的预充值退掉,在途单完成计提后卖家会倒欠。
 * 可退额校验 + openEst + 写入【同一 db.transaction】读取(better-sqlite3 同步事务串行 → 无 TOCTOU / 无并发双退)。
 * 退的是商家平台服务费预付款,非买家货款/escrow/保证金。
 */
export function recordFeePrepayRefund(
  db: Database.Database,
  args: { sellerId: string; amountUnits: Units; method: string; recordedBy: string; evidenceRef?: string; reason?: string },
): RecordFeePrepayResult {
  if (!args.sellerId) return { ok: false, error: 'MISSING_SELLER' }
  if (!Number.isFinite(args.amountUnits) || !Number.isInteger(args.amountUnits) || args.amountUnits <= 0) return { ok: false, error: 'AMOUNT_MUST_BE_POSITIVE' }
  if (args.method !== 'usdc' && args.method !== 'fiat') return { ok: false, error: 'BAD_METHOD' }
  const id = 'dpref_' + randomUUID()
  let outcome: RecordFeePrepayResult = { ok: true, id }
  db.transaction(() => {
    const refundable = readAvailableFeePrepayUnits(db, args.sellerId) - estimateOpenDirectPayFeeUnits(db, args.sellerId)
    if (args.amountUnits > refundable) { outcome = { ok: false, error: 'REFUND_EXCEEDS_AVAILABLE' }; return }
    db.prepare(
      `INSERT INTO direct_pay_fee_prepay_refunds (id, seller_id, amount, currency, method, evidence_ref, reason, recorded_by, created_at)
       VALUES (?,?,?, '${FEE_AR_CURRENCY}', ?, ?, ?, ?, datetime('now'))`,
    ).run(id, args.sellerId, toDecimal(args.amountUnits), args.method, args.evidenceRef ?? null, args.reason ?? null, args.recordedBy)
    db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
      .run('dprefaud_' + randomUUID(), args.recordedBy, 'direct_pay.fee_refund', 'user', args.sellerId,
        JSON.stringify({ refund_id: id, amount_units: args.amountUnits, method: args.method, evidence_ref_present: !!args.evidenceRef }))
  })()
  return outcome
}

/**
 * 卖家【在途】direct_p2p 单的预估费合计(units)。建单信用门用:防止短时开大量在途单完成后一次性超限。
 * 与已计提 receivables 不重叠:在途单尚未 accrue(不在 receivables);完成即转入 receivables、离开本集合。
 * 表/列缺失(旧库)→ 0(休眠安全)。
 */
export function estimateOpenDirectPayFeeUnits(db: Database.Database, sellerId: string): Units {
  const ph = OPEN_FEE_ACCRUING_STATUSES.map(() => '?').join(',')
  let rows: Array<{ total_amount: number; source: string | null }> = []
  try {
    rows = db.prepare(
      `SELECT total_amount, source FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND status IN (${ph})`,
    ).all(sellerId, ...OPEN_FEE_ACCRUING_STATUSES) as Array<{ total_amount: number; source: string | null }>
  } catch { return 0 }
  let sum = 0
  for (const r of rows) sum += feeUnitsForOrder(toUnits(Number(r.total_amount) || 0), r.source)
  return sum
}

/**
 * 完成时记一笔平台费应收(原始 immutable accrual 行)。fail-closed + 幂等:
 *  - feeUnits ≤ 0 → 抛(拒绝完成而费用为零;调用方在 settle 同一 db.transaction 内 → 回滚 completed)。
 *  - 该单已有 receivable(UNIQUE order_id)→ 返回 'already'(支持重结算,不重复计费)。
 *  必须在调用方的 db.transaction 内调用(与 completed 转移同原子边界)。
 */
export function accrueFeeReceivable(
  db: Database.Database, opts: { orderId: string; sellerId: string; feeUnits: Units; receivableId: string },
): { outcome: 'accrued' | 'already' } {
  if (opts.feeUnits <= 0) throw new Error(`accrueFeeReceivable: fee must be > 0 for order ${opts.orderId} (fail-closed)`)
  const existing = db.prepare('SELECT id FROM direct_pay_fee_receivables WHERE order_id = ?').get(opts.orderId)
  if (existing) return { outcome: 'already' } // 幂等:重结算不重复计费
  db.prepare(
    `INSERT INTO direct_pay_fee_receivables (id, order_id, seller_id, amount, currency, accrued_at) VALUES (?,?,?,?, '${FEE_AR_CURRENCY}', datetime('now'))`,
  ).run(opts.receivableId, opts.orderId, opts.sellerId, toDecimal(opts.feeUnits))
  return { outcome: 'accrued' }
}

/**
 * 完成结算时的 direct_p2p 平台费收口(供 settleOrder 单行调用,保持 server.ts 净零)。
 * ① 释放任何遗留模拟 WAZ fee-stake(cutover 前建单;模拟无价值,不取,退回卖家;无则 no-op);
 * ② accrue 一笔链下应收(fail-closed + 幂等)。必须在调用方 settleOrder 的 db.transaction 内调用。
 */
export function settleDirectPayFeeAtCompletion(
  db: Database.Database,
  order: { id: string; seller_id: string; total_amount: number; source: string | null },
  receivableId: string,
): void {
  releaseFeeStake(db, { orderId: order.id })
  accrueFeeReceivable(db, {
    orderId: order.id, sellerId: order.seller_id,
    feeUnits: feeUnitsForOrder(toUnits(Number(order.total_amount) || 0), order.source), receivableId,
  })
}
