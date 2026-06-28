/**
 * Direct Pay (Rail 1) — 上线前【就绪聚合】(pre-flip go/no-go)。纯读,operator 视角(非买家/卖家面)。
 *
 * 把分散的就绪信号汇总成一份 go/no-go:
 *   - global:控制面(enabled / rail-breaker / region / region_allowlist / per_tx_cap)是否就绪。
 *   - 每个【候选卖家】(有收款说明 / 缓交 / 保证金 / 逐品验证 / 店铺认证 任一记录者):readDirectPayLaunchReadiness
 *     的 ready + blockers,以及【可直付商品数】(逐品 verified 的在售品;若店铺豁免则其全部在售品)。
 *   - go = 全局就绪 AND 至少一个卖家 ready 且有 ≥1 可直付商品。
 *
 * 只 SELECT,不写库、不 flip、不碰资金。供 operator CLI / ROOT 诊断在翻 enabled 之前核对。
 */
import type Database from 'better-sqlite3'
import { readDirectPayLaunchReadiness, type DirectPayLaunchReadiness } from './direct-pay-launch-readiness.js'
import { readDirectPayControlsConfig } from './direct-pay-controls.js'
import { productStoreVerified } from './product-verification.js'
import { sellerExemptFromPerProduct } from './store-verification.js'

export interface SellerLaunchSummary {
  sellerId: string
  ready: boolean
  blockers: string[]
  storeExempt: boolean
  activeProductCount: number
  eligibleProductCount: number   // 逐品 verified 的在售品数;店铺豁免则 = activeProductCount
  launchable: boolean            // ready && eligibleProductCount > 0
}

export interface DirectPayLaunchSummary {
  go: boolean
  global: {
    ready: boolean
    blockers: string[]           // 全局控制面 blockers(NOT_ENABLED / RAIL_BREAKER / REGION / CAP)
    facts: DirectPayLaunchReadiness['facts']
  }
  sellers: SellerLaunchSummary[]
  launchableSellerCount: number
}

/** 候选卖家:在任一 direct-pay 相关表里出现过的卖家(有意接入直付者)。 */
function candidateSellers(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT seller_id FROM (
      SELECT seller_id FROM direct_receive_payment_instructions WHERE status = 'active'
      UNION SELECT user_id   FROM direct_receive_deferrals
      UNION SELECT user_id   FROM direct_receive_deposits
      UNION SELECT seller_id FROM product_verifications
      UNION SELECT user_id   FROM store_verifications
    ) WHERE seller_id IS NOT NULL
  `).all() as Array<{ seller_id: string }>
  return rows.map(r => r.seller_id)
}

/** 聚合 go/no-go。纯读。getProtocolParam 由调用方按部署注入(CLI 从 protocol_params 构造)。 */
export function summarizeDirectPayLaunchReadiness(
  db: Database.Database, getProtocolParam: <T>(key: string, fallback: T) => T,
): DirectPayLaunchSummary {
  const globalRd = readDirectPayLaunchReadiness(db, { getProtocolParam })   // 无 sellerId → 仅全局 blockers
  const global = { ready: globalRd.blockers.length === 0, blockers: globalRd.blockers, facts: globalRd.facts }

  const sellers: SellerLaunchSummary[] = candidateSellers(db).map(sellerId => {
    const rd = readDirectPayLaunchReadiness(db, { getProtocolParam, sellerId })
    // 仅 seller-specific blockers(去掉全局 blockers,避免每个卖家都重复挂全局问题)。
    const globalSet = new Set(global.blockers)
    const sellerBlockers = rd.blockers.filter(b => !globalSet.has(b))
    const ready = sellerBlockers.length === 0
    const storeExempt = sellerExemptFromPerProduct(db, sellerId)
    const products = db.prepare("SELECT id FROM products WHERE seller_id = ? AND status = 'active'").all(sellerId) as Array<{ id: string }>
    const eligibleProductCount = storeExempt ? products.length : products.filter(p => productStoreVerified(db, p.id)).length
    return { sellerId, ready, blockers: sellerBlockers, storeExempt, activeProductCount: products.length, eligibleProductCount, launchable: ready && eligibleProductCount > 0 }
  })

  const launchableSellerCount = sellers.filter(s => s.launchable).length
  return { go: global.ready && launchableSellerCount > 0, global, sellers, launchableSellerCount }
}

/** 便捷:从控制面配置取关键运营数值(供 CLI 打印)。 */
export function directPayControlsSnapshot(getProtocolParam: <T>(key: string, fallback: T) => T) {
  return readDirectPayControlsConfig(getProtocolParam)
}
