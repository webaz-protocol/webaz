/**
 * Direct Pay (Rail 1) — PHASE 7A launch readiness surface(只读总闸 / 诊断面)。
 *
 * 把 Phase 4(入口控制 + production base-bond + #112 rail-clearance)与 Phase 6(KYB / sanctions / AML)的门禁状态
 *   汇总成【单一只读面】:`{ ready, blockers, facts }`。供后续 launch-policy PR 在翻开关前做机器检查。
 *
 * 这【不是】launch flip、【不是】授权写门、【不】启用任何真实收款。它【只读、只汇总】:
 *   - 不写 direct_receive_deposits / production_receipt_confirmed_at,不激活 direct_receive_privileges。
 *   - 不碰 wallet / escrow / settlement / order status / refund / commission / fund / tokenomics。
 *   - 不绕过 #112 双锁(assertProductionDepositRail + assertBondRailCleared)—— 仅【复用其只读判定】。
 *   blockers 是诊断信息,不是 production authorization。当前 main 恒 ready=false(Direct Pay non-launchable / fail-closed)。
 */
import type Database from 'better-sqlite3'
import {
  readDirectPayControlsConfig, sellerDirectPayBreakerTripped,
  sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear,
} from './direct-pay-controls.js'
import { sellerHasProductionBaseBondLocked } from './direct-receive-deposits.js'
import { bondRailClearanceBlockers } from './direct-pay-bond-rail-clearance.js'

/** 候选生产 base-bond 收款轨(与 #112 registry 一致;manual 是非生产确认轨,不算)。 */
const PRODUCTION_BOND_RAILS = ['usdc_onchain', 'fiat_psp'] as const

export type DirectPayLaunchBlocker =
  // ── global / policy(总是评估)──
  | 'DIRECT_PAY_NOT_ENABLED'
  | 'DIRECT_PAY_RAIL_BREAKER_TRIPPED'
  | 'DIRECT_PAY_REGION_NOT_ALLOWED'
  | 'DIRECT_PAY_PER_TX_CAP_UNSET'
  // ── production rail clearance(#112;总是评估)──
  | 'DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL'
  | 'DIRECT_PAY_RAIL_IMPLEMENTATION_GATED'
  | 'DIRECT_PAY_RAIL_POLICY_VERSION_UNSET'
  | 'DIRECT_PAY_RAIL_JURISDICTION_ALLOWLIST_EMPTY'
  // ── seller-specific(仅当传入 sellerId 时评估)──
  | 'DIRECT_PAY_SELLER_SUSPENDED'
  | 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND'
  | 'DIRECT_PAY_SELLER_KYB_NOT_APPROVED'
  | 'DIRECT_PAY_SELLER_SANCTIONS_NOT_CLEARED'
  | 'DIRECT_PAY_SELLER_AML_REVIEW_REQUIRED'

export interface DirectPayLaunchReadiness {
  ready: boolean
  blockers: DirectPayLaunchBlocker[]
  facts: {
    enabled: boolean
    railBreakerTripped: boolean
    region: string
    regionAllowlist: string[]
    perTxCapUnits: number
    perRailClearance: Record<string, string[]>   // 每条生产轨的 rail-level blockers(已剔除 per-deposit 的 NO_PRODUCTION_RECEIPT)
    anyRailLegalCleared: boolean
    sellerEvaluated: boolean
    sellerId: string | null
    sellerSuspended: boolean | null
    productionBaseBondLocked: boolean | null
    kybPassed: boolean | null
    sanctionsClear: boolean | null
    amlClear: boolean | null
  }
}

/**
 * 只读 readiness 汇总。args.getProtocolParam 读控制面配置;args.sellerId 提供时附加 seller-specific blockers。
 * ready ⟺ blockers 为空。绝不写库。
 */
export function readDirectPayLaunchReadiness(
  db: Database.Database,
  args: { getProtocolParam: <T>(key: string, fallback: T) => T; sellerId?: string },
): DirectPayLaunchReadiness {
  const { getProtocolParam, sellerId } = args
  const cfg = readDirectPayControlsConfig(getProtocolParam)
  const blockers: DirectPayLaunchBlocker[] = []

  // ── global / policy(镜像 evaluateDirectPayLaunchControls 的非订单条件;不短路,收集全部)──
  if (cfg.enabled !== true) blockers.push('DIRECT_PAY_NOT_ENABLED')
  if (cfg.railBreakerTripped === true) blockers.push('DIRECT_PAY_RAIL_BREAKER_TRIPPED')
  const allow = Array.isArray(cfg.regionAllowlist) ? cfg.regionAllowlist : []
  if (!allow.length || !cfg.region || !allow.includes(cfg.region)) blockers.push('DIRECT_PAY_REGION_NOT_ALLOWED')
  if (!(Number.isSafeInteger(cfg.perTxCapUnits) && cfg.perTxCapUnits > 0)) blockers.push('DIRECT_PAY_PER_TX_CAP_UNSET')

  // ── production rail clearance(#112;rail-level,jurisdiction-independent)──
  //   hasProductionReceipt:true 只为剔除 per-deposit 的 NO_PRODUCTION_RECEIPT,得到纯 rail-level blockers。
  const perRailClearance: Record<string, string[]> = {}
  for (const rid of PRODUCTION_BOND_RAILS) perRailClearance[rid] = bondRailClearanceBlockers(rid, { hasProductionReceipt: true })
  const anyRailLegalCleared = PRODUCTION_BOND_RAILS.some(rid => perRailClearance[rid].length === 0)
  if (!anyRailLegalCleared) blockers.push('DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL')
  // 跨所有候选轨【都】命中才算 launch-level blocker(交集语义:某缺陷对每条轨都成立 → 它阻断上线)。
  const everyRail = (code: string): boolean => PRODUCTION_BOND_RAILS.every(rid => perRailClearance[rid].includes(code))
  if (everyRail('RAIL_IMPLEMENTATION_GATED')) blockers.push('DIRECT_PAY_RAIL_IMPLEMENTATION_GATED')
  if (everyRail('POLICY_VERSION_UNSET')) blockers.push('DIRECT_PAY_RAIL_POLICY_VERSION_UNSET')
  if (everyRail('EMPTY_JURISDICTION_ALLOWLIST')) blockers.push('DIRECT_PAY_RAIL_JURISDICTION_ALLOWLIST_EMPTY')

  // ── seller-specific(仅当传入 sellerId)──
  let sellerSuspended: boolean | null = null, productionBaseBondLocked: boolean | null = null
  let kybPassed: boolean | null = null, sanctionsClear: boolean | null = null, amlClear: boolean | null = null
  if (sellerId) {
    sellerSuspended = sellerDirectPayBreakerTripped(db, sellerId)
    productionBaseBondLocked = sellerHasProductionBaseBondLocked(db, sellerId)
    kybPassed = sellerDirectPayKybPassed(db, sellerId)
    sanctionsClear = sellerDirectPaySanctionsClear(db, sellerId)
    amlClear = sellerDirectPayAmlClear(db, sellerId)
    if (sellerSuspended) blockers.push('DIRECT_PAY_SELLER_SUSPENDED')
    if (!productionBaseBondLocked) blockers.push('DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND')
    if (!kybPassed) blockers.push('DIRECT_PAY_SELLER_KYB_NOT_APPROVED')
    if (!sanctionsClear) blockers.push('DIRECT_PAY_SELLER_SANCTIONS_NOT_CLEARED')
    if (!amlClear) blockers.push('DIRECT_PAY_SELLER_AML_REVIEW_REQUIRED')
  }

  return {
    ready: blockers.length === 0,
    blockers,
    facts: {
      enabled: cfg.enabled, railBreakerTripped: cfg.railBreakerTripped, region: cfg.region,
      regionAllowlist: cfg.regionAllowlist, perTxCapUnits: cfg.perTxCapUnits,
      perRailClearance, anyRailLegalCleared,
      sellerEvaluated: !!sellerId, sellerId: sellerId ?? null,
      sellerSuspended, productionBaseBondLocked, kybPassed, sanctionsClear, amlClear,
    },
  }
}
