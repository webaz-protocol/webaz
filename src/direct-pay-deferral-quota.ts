/**
 * Direct Pay (Rail 1) — 缓交(deferred base-bond)期【额度强制】(PR-③ / launch blocker)。
 *
 * 决策(Holden 锁定):缓交卖家在缓交期内以【压低额度】成交,而非满额。双重上限,任一超即拒:
 *   ① 主 = 滚动窗口内该卖家 direct_p2p 订单【笔数】≤ floor(baseOrderCount × reducedQuotaFactor),下限 ≥ 1
 *      (不零威慑:即便压到最低也至少允许 1 单,系数下限由 clampReducedQuotaFactor 保证 >0)。
 *   ② 加 = 滚动窗口内该卖家 direct_p2p 【累计金额】≤ maxWindowAmountUnits(【绝对封顶】,不随 factor 缩放;
 *      未交真实保证金的卖家的总敞口天花板)。
 *
 * 适用范围:仅对【靠 active deferral 入场、且【无】生产 base-bond】的卖家强制。
 *   - 有生产保证金(production receipt)→ 不在缓交期 → 不压(满额;以真实担保物背书)。
 *   - 无 active deferral → 本检查 no-op(其入场资格由控制面别处判;非缓交卖家不归本模块管)。
 *
 * 纯读:只 SELECT orders(笔数 + 金额),不写任何表、不碰 wallet/escrow/settlement/refund/状态机。
 *   建单时在【控制面全过之后、任何 DB write 之前】调用(fail-closed):超额 → 拒,绝不建单。
 * 取消单(status='cancelled')不计入(避免买家恶意下单后取消刷爆缓交卖家额度;且取消=无真实敞口)。
 */
import type Database from 'better-sqlite3'
import { getActiveDeferral } from './direct-receive-deferral.js'
import { sellerHasProductionBaseBondLocked } from './direct-receive-deposits.js'
import { toUnits, type Units } from './money.js'

export interface DeferralQuotaConfig {
  windowDays: number          // 滚动窗口(天)
  baseOrderCount: number      // 满额笔数基准;缓交额度 = floor(base × factor),下限 ≥ 1
  maxWindowAmountUnits: Units // 缓交期滚动窗口累计金额【绝对封顶】(integer units)
}

export const DEFERRAL_QUOTA_CODES = {
  COUNT: 'DIRECT_PAY_DEFERRAL_QUOTA_EXCEEDED',
  AMOUNT: 'DIRECT_PAY_DEFERRAL_AMOUNT_EXCEEDED',
} as const

export type DeferralQuotaResult = { ok: true } | { ok: false; code: string; reason: string }

/** 从治理参数读取额度配置(全部带保守默认;真值由治理调)。 */
export function readDeferralQuotaConfig(getProtocolParam: <T>(k: string, fb: T) => T): DeferralQuotaConfig {
  const windowDays = Math.max(1, Math.floor(getProtocolParam<number>('direct_pay.deferral_window_days', 30)))
  const baseOrderCount = Math.max(1, Math.floor(getProtocolParam<number>('direct_pay.deferral_base_order_count', 20)))
  const maxWindowAmountUnits = Math.max(0, Math.floor(getProtocolParam<number>('direct_pay.deferral_max_window_amount_units', toUnits(500)))) as Units
  return { windowDays, baseOrderCount, maxWindowAmountUnits }
}

/** SQLite datetime('now') 格式的窗口起点('YYYY-MM-DD HH:MM:SS'),用于和 orders.created_at 同格式比较。 */
function windowStartSql(nowIso: string, windowDays: number): string {
  return new Date(Date.parse(nowIso) - windowDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 缓交期额度检查。返回 ok 或结构化拒因(COUNT / AMOUNT)。newOrderAmountUnits = 本次拟建单金额(units)。
 * 非缓交卖家(有生产 bond 或无 active deferral)→ 直接 ok(本检查不适用)。
 */
export function checkDeferralQuota(
  db: Database.Database, sellerId: string, newOrderAmountUnits: Units, nowIso: string, cfg: DeferralQuotaConfig,
): DeferralQuotaResult {
  // 有生产保证金 → 不在缓交期 → 不压(即便同时存在 deferral,以真实担保物为准)。
  if (sellerHasProductionBaseBondLocked(db, sellerId)) return { ok: true }
  const active = getActiveDeferral(db, sellerId, nowIso)
  if (!active) return { ok: true }   // 非缓交卖家 → no-op
  const since = windowStartSql(nowIso, cfg.windowDays)
  const rows = db.prepare(
    `SELECT total_amount FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND status != 'cancelled' AND created_at >= ?`,
  ).all(sellerId, since) as Array<{ total_amount: number }>
  // ① 笔数上限(factor 缩放,下限 ≥ 1)。
  const countLimit = Math.max(1, Math.floor(cfg.baseOrderCount * active.reducedQuotaFactor))
  if (rows.length + 1 > countLimit) {
    return { ok: false, code: DEFERRAL_QUOTA_CODES.COUNT, reason: `缓交期内直付订单数已达上限(${countLimit} 单/${cfg.windowDays} 天);交纳履约保证金后可恢复满额` }
  }
  // ② 累计金额绝对封顶(units;不随 factor 缩放)。
  const windowAmountU = (rows.reduce((s, r) => s + toUnits(Number(r.total_amount) || 0), 0) + newOrderAmountUnits) as Units
  if (windowAmountU > cfg.maxWindowAmountUnits) {
    return { ok: false, code: DEFERRAL_QUOTA_CODES.AMOUNT, reason: `缓交期内直付累计金额已达上限;交纳履约保证金后可恢复满额` }
  }
  return { ok: true }
}
