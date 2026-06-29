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
import { checkDeferralQuota, readDeferralQuotaConfig } from './direct-pay-deferral-quota.js'
import { productStoreVerified } from './product-verification.js'
import { sellerExemptFromPerProduct } from './store-verification.js'
import { toUnits } from './money.js'

export interface SellerLaunchSummary {
  sellerId: string
  ready: boolean
  blockers: string[]
  storeExempt: boolean
  activeProductCount: number
  eligibleProductCount: number   // 能真正走 direct_p2p 建单的在售品数:简单商品(非规格)+ 逐品 verified 或店铺豁免 + 通过缓交额度
  launchable: boolean            // ready && eligibleProductCount > 0
}

export interface DirectPayLaunchSummary {
  go: boolean                    // LIVE go:全局就绪(【含】enabled=true)+ ≥1 launchable seller。enabled 已开时用。
  preflipGo: boolean             // PRE-FLIP go:除"未开启总开关"外全部就绪 —— 即"只差翻 enabled"。翻闸前的真正自检值。
  pendingEnable: boolean         // enabled 尚未开启(facts.enabled !== true)。preflipGo=true && pendingEnable=true ⇒ 可翻闸。
  global: {
    ready: boolean               // 含 enabled 的严格就绪
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
  const globalSet = new Set(global.blockers)
  const nowIso = new Date().toISOString()
  const quotaCfg = readDeferralQuotaConfig(getProtocolParam)
  const controlsCfg = readDirectPayControlsConfig(getProtocolParam)

  const sellers: SellerLaunchSummary[] = candidateSellers(db).map(sellerId => {
    const rd = readDirectPayLaunchReadiness(db, { getProtocolParam, sellerId })
    // 仅 seller-specific blockers(去掉全局 blockers,避免每个卖家都重复挂全局问题)。
    const sellerBlockers = rd.blockers.filter(b => !globalSet.has(b))
    const ready = sellerBlockers.length === 0
    const storeExempt = sellerExemptFromPerProduct(db, sellerId)
    const products = db.prepare("SELECT id, price, stock, has_variants FROM products WHERE seller_id = ? AND status = 'active'").all(sellerId) as Array<{ id: string; price: number; stock: number; has_variants: number }>
    // 可直付商品 = 必须能真正走 direct_p2p 建单(镜像 create gate / evaluateDirectPayLaunchControls + 建单库存门),全部满足:
    //   ① 简单商品(direct_p2p v1 拒规格商品 has_variants=1);② 逐品 verified 或卖家店铺豁免;
    //   ③ 单笔上限:amount>0 且 ≤ perTxCapUnits(且 cap 已配 >0)—— 镜像 DIRECT_PAY_CAP_EXCEEDED;
    //   ④ 有货(stock≥1)—— 镜像 createDirectPayOrder 的 `stock >= qty`(否则 'stock depleted');
    //   ⑤ 通过缓交额度(checkDeferralQuota qty=1 该单价;非缓交卖家=no-op)。否则报告会误判 go=true 而真实下单被拒。
    const eligibleProductCount = products.filter(p => {
      const priceU = toUnits(Number(p.price) || 0)
      return Number(p.has_variants) !== 1
        && (storeExempt || productStoreVerified(db, p.id))
        && controlsCfg.perTxCapUnits > 0 && priceU > 0 && priceU <= controlsCfg.perTxCapUnits
        && Number(p.stock) >= 1
        && checkDeferralQuota(db, sellerId, priceU, nowIso, quotaCfg).ok
    }).length
    return { sellerId, ready, blockers: sellerBlockers, storeExempt, activeProductCount: products.length, eligibleProductCount, launchable: ready && eligibleProductCount > 0 }
  })

  const launchableSellerCount = sellers.filter(s => s.launchable).length
  // PRE-FLIP 自检:忽略【且仅忽略】"总开关未开"这一项,回答"除了翻 enabled,还差什么"。其余(region/cap/卖家/商品)照常要求。
  const preflipReady = global.blockers.filter(b => b !== 'DIRECT_PAY_NOT_ENABLED').length === 0
  const pendingEnable = global.facts.enabled !== true
  return {
    go: global.ready && launchableSellerCount > 0,                 // LIVE(含 enabled)
    preflipGo: preflipReady && launchableSellerCount > 0,          // 只差翻 enabled 即就绪
    pendingEnable,
    global, sellers, launchableSellerCount,
  }
}

/** 便捷:从控制面配置取关键运营数值(供 CLI 打印)。 */
export function directPayControlsSnapshot(getProtocolParam: <T>(key: string, fallback: T) => T) {
  return readDirectPayControlsConfig(getProtocolParam)
}
