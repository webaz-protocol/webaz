/**
 * Merchant Base-Bond — collateral-backed open-exposure cap (§6.5, PR2).
 *
 * 设计:docs/modules/MERCHANT-BASE-BOND-DESIGN.INTERNAL.md §6.5。
 * 这是【后端 create-gate】,不是智能合约规则;是【风险控制,非买家赔付】(禁称 buyer protection fund / compensation pool)。
 *
 * 规则:open_exposure + new_order_total ≤ active_collateral_units × exposure_factor_bps / 10000。
 *
 * 休眠安全(gates-before-reachability):**仅当 active_collateral_units > 0(卖家走真实抵押路径)才生效**。
 *   当前 merchant_bond 关闭、无 active 存款 → 所有卖家 collateral=0 → 本门返回 ok(N/A)→ 现有直付(缓交卖家)零影响。
 * fail-closed:exposure_factor_bps 缺失/非数/≤0/>10000 → 拒单(EXPOSURE_CAP_CONFIG);
 *   但【只在 collateral>0 分支读取该参数】,故现状(collateral=0)永不触发。
 */
import type Database from 'better-sqlite3'
import { toUnits, type Units } from './money.js'

export const EXPOSURE_FACTOR_BPS_PARAM = 'direct_pay.exposure_factor_bps'
export const EXPOSURE_FACTOR_BPS_DEFAULT = 8000

export class ExposureCapConfigError extends Error {}

/** fail-closed 读取 factor:整数 ∈ [1,10000];缺失/非数/越界 → 抛 ExposureCapConfigError。 */
export function readExposureFactorBps(getProtocolParam: <T>(k: string, fb: T) => T): number {
  const raw = getProtocolParam<unknown>(EXPOSURE_FACTOR_BPS_PARAM, undefined as unknown)
  const n = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 10000) {
    throw new ExposureCapConfigError(`${EXPOSURE_FACTOR_BPS_PARAM} invalid (got ${JSON.stringify(raw)}); must be integer in [1,10000]`)
  }
  return n
}

/** 卖家当前有效抵押(USDC integer units,big-int 安全):merchant_bond_deposits status='active' 之和。无 → 0n。 */
export function getActiveCollateralUnits(db: Database.Database, sellerId: string): bigint {
  let rows: Array<{ collateral_units: string }> = []
  // 表缺失(旧/最小库)→ 视作无抵押(0n),休眠安全:不让缺表破坏现有直付建单。
  try { rows = db.prepare("SELECT collateral_units FROM merchant_bond_deposits WHERE seller_id = ? AND status = 'active'").all(sellerId) as Array<{ collateral_units: string }> } catch { return 0n }
  let sum = 0n
  for (const r of rows) { try { sum += BigInt(r.collateral_units || '0') } catch { /* 坏行跳过,不计入(fail-closed:少算抵押更保守) */ } }
  return sum
}

/**
 * 开放敞口状态(未完全关闭的 direct_p2p 单)。终态【不】计入(释放敞口):
 *   completed / cancelled / fault_* / resolved_for_seller / refunded_partial / refunded_full / dispute_dismissed / expired。
 * ⚠️ direct_expired_unconfirmed 是【非终态】(超时不静默关单,仍可转 disputed / cancelled,见 transitions.ts)→ 必须计入,
 *    漏算会低估敞口(对风险闸是危险方向)。created 为建单原子前态(direct_p2p 一般即转 window),防御性纳入(过度计入只会更严、无害)。
 */
export const OPEN_EXPOSURE_STATUSES = [
  'created', 'direct_pay_window', 'direct_expired_unconfirmed',
  'accepted', 'shipped', 'picked_up', 'in_transit', 'delivered', 'confirmed', 'disputed',
] as const

/** 卖家当前 Direct Pay 开放敞口(units):未完全关闭的 direct_p2p 单 total_amount 之和。 */
export function computeDirectPayOpenExposureUnits(db: Database.Database, sellerId: string): bigint {
  const placeholders = OPEN_EXPOSURE_STATUSES.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT total_amount FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND status IN (${placeholders})`,
  ).all(sellerId, ...OPEN_EXPOSURE_STATUSES) as Array<{ total_amount: number }>
  let sum = 0n
  for (const r of rows) sum += BigInt(toUnits(Number(r.total_amount) || 0))
  return sum
}

/** 纯函数:本单是否在敞口上限内。allowed = collateral × bps / 10000;open + new ≤ allowed。 */
export function withinExposureCap(args: { activeCollateralUnits: bigint; openExposureUnits: bigint; newOrderUnits: bigint; factorBps: number }): boolean {
  const allowed = args.activeCollateralUnits * BigInt(args.factorBps) / 10000n
  return args.openExposureUnits + args.newOrderUnits <= allowed
}

export interface ExposureCapResult { ok: boolean; error_code?: string; reason?: string }

/**
 * create-gate 主入口。休眠安全:collateral==0 → ok(N/A,缓交路径由 deferral quota 管,不读 factor)。
 * collateral>0 → 读 factor(fail-closed)+ 比较;超出 → 拒(EXPOSURE_CAP_EXCEEDED)。
 */
export function enforceCollateralExposureGate(
  db: Database.Database, sellerId: string, newOrderUnits: Units,
  getProtocolParam: <T>(k: string, fb: T) => T,
): ExposureCapResult {
  const collateral = getActiveCollateralUnits(db, sellerId)
  if (collateral <= 0n) return { ok: true }                       // 无真实抵押 → 敞口上限不适用(休眠)
  let factorBps: number
  try { factorBps = readExposureFactorBps(getProtocolParam) }
  catch (e) { return { ok: false, error_code: 'EXPOSURE_CAP_CONFIG', reason: (e as Error).message } }  // fail-closed
  const openExposureUnits = computeDirectPayOpenExposureUnits(db, sellerId)
  if (!withinExposureCap({ activeCollateralUnits: collateral, openExposureUnits, newOrderUnits: BigInt(newOrderUnits), factorBps })) {
    return { ok: false, error_code: 'EXPOSURE_CAP_EXCEEDED', reason: 'direct-pay open exposure exceeds collateral-backed cap' }
  }
  return { ok: true }
}
