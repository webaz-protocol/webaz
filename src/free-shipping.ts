/**
 * 满额免邮(营销域,S2 返工自模板)—— 商家促销规则:券后货款 ≥ 阈值 → 本单运费商家承担(买家侧 0)。
 *
 * 为什么在营销域而不是运费模板(用户裁定):
 *   - 模板=成本/可达结构;免邮=促销杠杆(与优惠券/限时促销同类),两种语义不混。
 *   - 物流供应商期(终态):运费由供应商报价,免邮必然是商家补贴 —— 规则住营销域则届时只换
 *     "补贴对象"(少收自己的钱 → 贴供应商的钱),不搬家不迁数据。
 *
 * 层级:products.free_shipping_threshold ?? users.store_free_shipping_threshold ?? 无规则。
 * 应用点:建单 gate(shipping-templates.gateShippingForCreate)在模板费为正时判免;
 *   人工询价路径天然豁免(报价=人工逐单定价,权威)。整数 units 比较(RFC-014)。
 * 快照:trade_terms shipping.free_threshold_applied(争议对账:0 运费是免出来的)。
 */
import type Database from 'better-sqlite3'
import { toUnits, type Units } from './money.js'

const MAX_THRESHOLD = 10_000_000

/** 写入校验:null/空=清除;返回规范化数值或 {error}。 */
export function validateFreeShippingThreshold(raw: unknown): { value: number | null } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null }
  const t = Number(raw)
  if (!Number.isFinite(t) || t <= 0 || t > MAX_THRESHOLD) return { error: `免邮阈值必须是 0~${MAX_THRESHOLD} 的正数` }
  return { value: Math.round(t * 100) / 100 }
}

/** 生效阈值:商品 ?? 店铺 ?? null(与接单/运费/可售同层级约定)。 */
export function effectiveFreeShippingThreshold(db: Database.Database, product: { free_shipping_threshold?: number | null }, sellerId: string): number | null {
  const own = product.free_shipping_threshold
  if (own !== null && own !== undefined && Number.isFinite(Number(own)) && Number(own) > 0) return Number(own)
  try {
    const row = db.prepare('SELECT store_free_shipping_threshold FROM users WHERE id = ?').get(sellerId) as { store_free_shipping_threshold: number | null } | undefined
    const st = row?.store_free_shipping_threshold
    return (st !== null && st !== undefined && Number.isFinite(Number(st)) && Number(st) > 0) ? Number(st) : null
  } catch { return null }
}

/** 判免:券后货款(整数 units)≥ 生效阈值。读失败 fail-open 到不免(促销缺席≠事故,与合规门相反方向)。 */
export function freeShippingWaives(db: Database.Database, product: { free_shipping_threshold?: number | null }, sellerId: string, goodsSubtotalU: Units): boolean {
  try {
    const t = effectiveFreeShippingThreshold(db, product, sellerId)
    return t !== null && goodsSubtotalU >= toUnits(t)
  } catch { return false }
}
