/**
 * Direct-pay product availability — the SINGLE pure predicate mirroring the order-creation gate.
 *
 * Extracted from routes/direct-pay-availability.ts so the buyer-facing availability route AND the
 * RFC-029 payment-options enumerator share ONE eligibility computation (no divergence — a rail shown
 * as available must be exactly the rail create would accept). Buyer-facing codes are coarsened
 * (never leaks which seller compliance gate failed). Pure read: no wallet/escrow/state-machine.
 *
 * NOTE: this is the DIRECT-PAY entry gate (launch controls + product verification + deferral quota).
 * It is NOT the full create-time stack (per-order caps / exposure / fee-prepay live in
 * direct-pay-create.ts and re-run authoritatively at creation). Availability here is best-effort.
 */
import type Database from 'better-sqlite3'
import {
  evaluateDirectPayLaunchControls, readDirectPayControlsConfig,
  sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear,
  sellerDirectPayBreakerTripped, coarsenBuyerFacingDirectPayCode, DIRECT_PAY_SELLER_NOT_ELIGIBLE,
} from './direct-pay-controls.js'
import { sellerBaseBondEntrySatisfied } from './direct-pay-base-bond-entry.js'
import { checkDeferralQuota, readDeferralQuotaConfig } from './direct-pay-deferral-quota.js'
import { productStoreVerified } from './product-verification.js'
import { sellerExemptFromPerProduct } from './store-verification.js'

export interface DirectPayAvailability {
  available: boolean
  code: string | null      // buyer-facing (coarsened) reason code when unavailable
  reason: string | null
  per_tx_cap_units: number
}

export interface DirectPayAvailabilityArgs {
  productId: string
  sellerId: string
  amountUnits: number      // this order's amount in base units (qty×price) — feeds the per-tx cap + quota
  getProtocolParam: <T>(key: string, fallback: T) => T
}

/** Mirrors routes/direct-pay-availability.ts §GET /availability — launch controls → product verification → deferral quota. */
export function directPayProductAvailability(db: Database.Database, args: DirectPayAvailabilityArgs): DirectPayAvailability {
  const cfg = readDirectPayControlsConfig(args.getProtocolParam)
  const nowIso = new Date().toISOString()
  const decision = evaluateDirectPayLaunchControls(cfg, {
    amountUnits: args.amountUnits,
    sellerBreakerTripped: sellerDirectPayBreakerTripped(db, args.sellerId),
    baseBondSatisfied: sellerBaseBondEntrySatisfied(db, args.sellerId, nowIso),
    kycSanctionsPassed: sellerDirectPayKybPassed(db, args.sellerId) && sellerDirectPaySanctionsClear(db, args.sellerId),
    amlClear: sellerDirectPayAmlClear(db, args.sellerId),
  })
  if (!decision.ok) {
    const code = coarsenBuyerFacingDirectPayCode(decision.error_code as string)
    return { available: false, code, reason: code === DIRECT_PAY_SELLER_NOT_ELIGIBLE ? '该卖家暂不支持直付' : (decision.reason ?? null), per_tx_cap_units: cfg.perTxCapUnits }
  }
  // 硬门(镜像 create):产品逐品验证 OR 卖家豁免(店铺 verified + per_product_exempt)。
  if (!(productStoreVerified(db, args.productId) || sellerExemptFromPerProduct(db, args.sellerId))) {
    return { available: false, code: 'DIRECT_PAY_PRODUCT_NOT_VERIFIED', reason: '该商品暂不支持直付(待平台验证)', per_tx_cap_units: cfg.perTxCapUnits }
  }
  // 缓交额度门(镜像 create;超额是卖家私密状态 → 收敛为通用不可用)。
  const quota = checkDeferralQuota(db, args.sellerId, args.amountUnits, nowIso, readDeferralQuotaConfig(args.getProtocolParam))
  if (!quota.ok) return { available: false, code: coarsenBuyerFacingDirectPayCode(quota.code), reason: '该卖家暂不支持直付', per_tx_cap_units: cfg.perTxCapUnits }
  return { available: true, code: null, reason: null, per_tx_cap_units: cfg.perTxCapUnits }
}
