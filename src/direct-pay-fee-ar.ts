/**
 * Direct Pay 平台费【链下应收(AR)】读 helper — 设计稿 DIRECT-PAY-FEE-RECEIVABLE-DESIGN.INTERNAL.md。
 *
 * PR-1 = 纯读 + 信用上限解析,【零行为接线】:本模块不被建单/完成/cron 调用,只提供单一真相源函数,
 *   供 PR-2(建单信用门)、PR-3(月结)、PR-4b(seller fee center)消费。
 *
 * 边界(铁律):
 *  - 平台费 = 卖家 ↔ WebAZ 私有;买家侧任何接口不得返回(DTO 脱敏)。
 *  - 不碰买家本金 / escrow / base-bond collateral / penalty 科目。
 *  - 上限值【绝不硬编码】:全局默认走 protocol_params(运行时可调);本 helper 读不到合法值即 fail-closed(返 0=拒),
 *    【绝不回落任何代码常量】。生效上限 = 商家 override(若有)?? 全局默认。
 *  - append-only:outstanding 由【原始 receivables + adjustments − payments】派生,不依赖任何可变 status 列。
 *  - 整数 base-units(RFC-014 money.ts);金额列存 REAL 小数,经 toUnits 进 units 域比较。
 */
import type Database from 'better-sqlite3'
import { toUnits, type Units } from './money.js'

export const FEE_AR_CEILING_PARAM = 'direct_pay.fee_ar_credit_ceiling_units'
export const FEE_AR_CURRENCY = 'usdc' // v1 单一计价币

/** 某 SUM 查询结果 → units(空表/NULL → 0)。SUM 的是整数 units 值存成的 REAL,toUnits 精确还原。 */
function sumUnits(db: Database.Database, sql: string, sellerId: string): Units {
  const row = db.prepare(sql).get(sellerId) as { s: number | null } | undefined
  const v = row?.s
  if (v === null || v === undefined || !Number.isFinite(v)) return 0
  return toUnits(v)
}

/**
 * 商家当前未付应收(units,可为负=结转抵减/预收形成的贷方)。
 *   outstanding = Σ receivables.amount + Σ adjustments.delta_amount − Σ payments.amount
 * append-only 派生:不读任何 status 列;冲销/核销/收款都是独立行。
 */
export function getSellerOutstandingFeeArUnits(db: Database.Database, sellerId: string): Units {
  // 表缺失(旧库)→ 视作无应收(0),休眠安全。
  let accrued = 0, adjusted = 0, paid = 0
  try { accrued = sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_receivables WHERE seller_id = ?', sellerId) } catch { return 0 }
  try { adjusted = sumUnits(db, 'SELECT SUM(delta_amount) AS s FROM direct_pay_fee_adjustments WHERE seller_id = ?', sellerId) } catch { adjusted = 0 }
  try { paid = sumUnits(db, 'SELECT SUM(amount) AS s FROM direct_pay_fee_payments WHERE seller_id = ?', sellerId) } catch { paid = 0 }
  return accrued + adjusted - paid
}

/**
 * 全局默认上限(units)。fail-closed:缺失/非数/<0 → 0(=拒所有新单)。绝不回落代码常量。
 * 注:0 是合法值(=封锁);仅【非法】输入归零。
 */
export function readGlobalFeeArCeilingUnits(getProtocolParam: <T>(k: string, fb: T) => T): Units {
  const raw = getProtocolParam<unknown>(FEE_AR_CEILING_PARAM, undefined as unknown)
  const n = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0
  return n
}

/**
 * 某商家生效上限(units)= override(若有该行)?? 全局默认。
 *   - override 行存在即采用其值(含 0=admin 主动封锁该商家);无行 → 全局默认。
 *   - override 行值非法(负/非整)→ fail-closed 归 0。
 */
export function readEffectiveFeeArCeilingUnits(
  db: Database.Database, sellerId: string, getProtocolParam: <T>(k: string, fb: T) => T,
): Units {
  let ov: { ceiling_units: number } | undefined
  try { ov = db.prepare('SELECT ceiling_units FROM direct_pay_fee_ar_seller_overrides WHERE seller_id = ?').get(sellerId) as { ceiling_units: number } | undefined } catch { ov = undefined }
  if (ov && ov.ceiling_units !== null && ov.ceiling_units !== undefined) {
    const n = Number(ov.ceiling_units)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0 // fail-closed
    return n
  }
  return readGlobalFeeArCeilingUnits(getProtocolParam)
}

/**
 * 纯函数:建单信用门判定(PR-2 装配,PR-1 不接线)。
 *   unpaid_AR + 在途单预估费 + 本单预估费 ≤ ceiling → ok。
 * 负的 outstanding(贷方)按实际值参与(更宽松,但守恒正确)。
 */
export function withinFeeArCreditCeiling(args: {
  outstandingUnits: Units; openOrdersEstFeeUnits: Units; newOrderFeeUnits: Units; ceilingUnits: Units
}): boolean {
  return args.outstandingUnits + args.openOrdersEstFeeUnits + args.newOrderFeeUnits <= args.ceilingUnits
}
