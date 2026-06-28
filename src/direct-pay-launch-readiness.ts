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
import { sellerBaseBondEntrySatisfied } from './direct-pay-base-bond-entry.js'
import { getActiveDeferral } from './direct-receive-deferral.js'
import { bondRailClearanceBlockers, isBondRailClearedForProduction } from './direct-pay-bond-rail-clearance.js'
import { getActivePaymentInstruction } from './direct-receive-payment-instruction.js'

/** 候选生产 base-bond 收款轨(与 #112 registry 一致;manual 是非生产确认轨,不算)。 */
// 候选生产 base-bond 收款轨。operator_attested(#116,已实现的运营核实轨)是 v1 实际要用的那条,必须纳入诊断,
//   否则它被 registry 放行后 readiness 仍误报"无 legal-cleared rail"。manual=非生产确认轨,不算。
const PRODUCTION_BOND_RAILS = ['operator_attested', 'usdc_onchain', 'fiat_psp'] as const

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
  | 'DIRECT_PAY_SELLER_PAYMENT_INSTRUCTION_MISSING'

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
    productionBaseBondLocked: boolean | null   // raw:已交生产级 base-bond(production receipt 非 NULL)
    activeDeferral: boolean | null             // raw:有有效缓交(getActiveDeferral)
    baseBondSatisfied: boolean | null          // 入场门:bond OR active deferral(= create gate 用的同一组合器)
    kybPassed: boolean | null
    sanctionsClear: boolean | null
    amlClear: boolean | null
    paymentInstructionPresent: boolean | null
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
  // ⚠️ 用 #112 的【jurisdiction-aware】判定决定 cleared/anyRailLegalCleared —— 必须把【当前部署 region】传进去:
  //   isBondRailClearedForProduction(rid, cfg.region) 会校验 region ∈ rail 的 legal jurisdictionAllowlist。
  //   仅看 coarse bondRailClearanceBlockers(allowlist 是否为空)会漏判"rail 只 cleared for US 而 region=SG"→ 误报 cleared。
  //   coarse perRailClearance 仅保留作【诊断 facts】。
  const anyRailLegalCleared = PRODUCTION_BOND_RAILS.some(rid => isBondRailClearedForProduction(rid, cfg.region))
  if (!anyRailLegalCleared) blockers.push('DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL')
  // 跨所有候选轨【都】命中才算 launch-level blocker(交集语义:某缺陷对每条轨都成立 → 它阻断上线)。
  const everyRail = (code: string): boolean => PRODUCTION_BOND_RAILS.every(rid => perRailClearance[rid].includes(code))
  if (everyRail('RAIL_IMPLEMENTATION_GATED')) blockers.push('DIRECT_PAY_RAIL_IMPLEMENTATION_GATED')
  if (everyRail('POLICY_VERSION_UNSET')) blockers.push('DIRECT_PAY_RAIL_POLICY_VERSION_UNSET')
  if (everyRail('EMPTY_JURISDICTION_ALLOWLIST')) blockers.push('DIRECT_PAY_RAIL_JURISDICTION_ALLOWLIST_EMPTY')

  // ── seller-specific(仅当传入 sellerId)──
  let sellerSuspended: boolean | null = null, productionBaseBondLocked: boolean | null = null
  let activeDeferral: boolean | null = null, baseBondSatisfied: boolean | null = null
  let kybPassed: boolean | null = null, sanctionsClear: boolean | null = null, amlClear: boolean | null = null
  let paymentInstructionPresent: boolean | null = null
  if (sellerId) {
    const nowIso = new Date().toISOString()
    sellerSuspended = sellerDirectPayBreakerTripped(db, sellerId)
    productionBaseBondLocked = sellerHasProductionBaseBondLocked(db, sellerId)
    activeDeferral = getActiveDeferral(db, sellerId, nowIso) != null
    // 镜像 create gate(direct-pay-base-bond-entry):保证金门 = 生产 bond OR 有效缓交。
    baseBondSatisfied = sellerBaseBondEntrySatisfied(db, sellerId, nowIso)
    kybPassed = sellerDirectPayKybPassed(db, sellerId)
    sanctionsClear = sellerDirectPaySanctionsClear(db, sellerId)
    amlClear = sellerDirectPayAmlClear(db, sellerId)
    // 镜像真实建单硬门(direct-pay-create.ts):无 active 收款说明 → create 返回 NO_PAYMENT_INSTRUCTION,绝不建单。
    paymentInstructionPresent = getActivePaymentInstruction(db, sellerId) != null
    if (sellerSuspended) blockers.push('DIRECT_PAY_SELLER_SUSPENDED')
    // 与 create gate 一致:有生产 bond 或有效缓交即满足;两者都无才 blocker。
    if (!baseBondSatisfied) blockers.push('DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND')
    if (!kybPassed) blockers.push('DIRECT_PAY_SELLER_KYB_NOT_APPROVED')
    if (!sanctionsClear) blockers.push('DIRECT_PAY_SELLER_SANCTIONS_NOT_CLEARED')
    if (!amlClear) blockers.push('DIRECT_PAY_SELLER_AML_REVIEW_REQUIRED')
    if (!paymentInstructionPresent) blockers.push('DIRECT_PAY_SELLER_PAYMENT_INSTRUCTION_MISSING')
  }

  return {
    ready: blockers.length === 0,
    blockers,
    facts: {
      enabled: cfg.enabled, railBreakerTripped: cfg.railBreakerTripped, region: cfg.region,
      regionAllowlist: cfg.regionAllowlist, perTxCapUnits: cfg.perTxCapUnits,
      perRailClearance, anyRailLegalCleared,
      sellerEvaluated: !!sellerId, sellerId: sellerId ?? null,
      sellerSuspended, productionBaseBondLocked, activeDeferral, baseBondSatisfied, kybPassed, sanctionsClear, amlClear, paymentInstructionPresent,
    },
  }
}

// ── seller-facing DE-IDENTIFIED readiness view ────────────────────────────────────────────────
// 卖家自助视角:只暴露【卖家可行动 / 脱敏状态】项,绝不下发 raw blocker codes,也绝不暴露 KYB / sanctions / AML
//   的【具体】判定 —— 三者一律折叠成单一 COMPLIANCE_REVIEW(仅"是否全部通过"一个布尔);全局/法务/rail 细节折叠成
//   单一 PLATFORM_OPEN。供 seller workbench 渲染脱敏文案(内部 code→卖家可读文案的映射在前端)。
export type SellerReadinessItemCode =
  | 'PLATFORM_OPEN'        // 平台侧直付是否开放(全局 + rail-clearance 折叠;不暴露具体哪项)
  | 'PAYMENT_INSTRUCTION'  // 是否已设有效收款说明(卖家可行动)
  | 'PASSKEY'              // 卖家是否已注册 Passkey(卖家可行动)
  | 'BASE_BOND'            // 履约保证金是否完成(状态;当前 gated)
  | 'COMPLIANCE_REVIEW'    // 商户审核是否全部通过(KYB+制裁+AML 折叠,绝不分项暴露)
  | 'NOT_SUSPENDED'        // 直付资格是否未被暂停(状态)

export interface SellerReadinessItem { code: SellerReadinessItemCode; ok: boolean; actionable: boolean }
export interface SellerDirectPayReadinessView { directPayReady: boolean; items: SellerReadinessItem[] }

const GLOBAL_LAUNCH_BLOCKERS = new Set<string>([
  'DIRECT_PAY_NOT_ENABLED', 'DIRECT_PAY_RAIL_BREAKER_TRIPPED', 'DIRECT_PAY_REGION_NOT_ALLOWED', 'DIRECT_PAY_PER_TX_CAP_UNSET',
  'DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL', 'DIRECT_PAY_RAIL_IMPLEMENTATION_GATED',
  'DIRECT_PAY_RAIL_POLICY_VERSION_UNSET', 'DIRECT_PAY_RAIL_JURISDICTION_ALLOWLIST_EMPTY',
])

/**
 * 卖家脱敏 readiness 视图。复用 readDirectPayLaunchReadiness(只读),把内部 blockers/facts 折叠成卖家安全的项目集。
 * 输出【不含】任何 raw blocker code、KYB/sanctions/AML 分项或法务/rail 细节。纯读。
 */
export function sellerDirectPayReadinessView(
  db: Database.Database,
  args: { getProtocolParam: <T>(key: string, fallback: T) => T; sellerId: string },
): SellerDirectPayReadinessView {
  const { getProtocolParam, sellerId } = args
  const r = readDirectPayLaunchReadiness(db, { getProtocolParam, sellerId })
  const f = r.facts
  const platformOpen = !r.blockers.some(b => GLOBAL_LAUNCH_BLOCKERS.has(b))
  const hasPasskey = !!db.prepare('SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1').get(sellerId)
  const complianceCleared = f.kybPassed === true && f.sanctionsClear === true && f.amlClear === true   // 折叠;不分项
  const items: SellerReadinessItem[] = [
    { code: 'PLATFORM_OPEN', ok: platformOpen, actionable: false },
    { code: 'PAYMENT_INSTRUCTION', ok: f.paymentInstructionPresent === true, actionable: true },
    { code: 'PASSKEY', ok: hasPasskey, actionable: true },
    { code: 'BASE_BOND', ok: f.baseBondSatisfied === true, actionable: false },   // 生产 bond 或有效缓交即算满足(与 create gate 一致)
    { code: 'COMPLIANCE_REVIEW', ok: complianceCleared, actionable: false },
    { code: 'NOT_SUSPENDED', ok: f.sellerSuspended === false, actionable: false },
  ]
  return { directPayReady: items.every(i => i.ok), items }
}
