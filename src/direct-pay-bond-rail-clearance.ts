/**
 * Direct Pay (Rail 1) — merchant production base-bond RAIL-CLEARANCE registry (Phase 4 scaffold)。
 *
 * 这是 production base-bond rail 走向上线前的【合规放行建模层】,默认【全 fail-closed】。它【不】启用真实生产收款、
 *   【不】接 USDC/on-chain/PSP/bank、【不】实现 confirmReceipt 真实验证、【不】移动任何资金。
 *
 * 双锁模型(两把【独立】的锁,缺一即拒,confirmProductionReceipt 同时要求):
 *   Lock A — 已实现锁:DepositRail 必须 isProduction && implemented(是不是一条建好的生产轨)。
 *            manual=非生产;usdc/fiat=GATED(implemented=false);operator_attested=已实现 → 过 Lock A。由 assertProductionDepositRail 守。
 *   Lock B — registry 放行锁(本模块):某 rail 的 legal_cleared + production_ready + 非占位 policy_version +
 *            jurisdiction ∈ allowlist。当前【全部默认 fail-closed】→ 全拒。由 assertBondRailCleared 守。
 *
 * 现状(2026-07-05 更新):**operator_attested 轨已放行(SG)** —— Holden 决策 B(经营者知情自担风险,
 *   非律师意见):保证金是商家履约担保物、不涉买家资金/货款;法币收取=常规合同担保物;USDC 收取的 PS Act
 *   DPT 定性风险已知并接受(security-deposit 豁免待律师确认,确认前敞口=pre-launch 无真实商家)。前置已建:
 *   条款文本+缴纳前强制同意(src/bond-terms.ts,liquidated-damages 表述;policy_version=条款版本,审计对齐)。
 *   usdc_onchain / fiat_psp【自动收款轨】仍全 fail-closed(未实现+未清门,与本次放行无关)。
 */
import { getDepositRail, type DepositRailId } from './deposit-rails.js'

export type BondAssetCategory = 'usdc' | 'fiat'

export interface BondRailClearance {
  railId: DepositRailId
  assetCategory: BondAssetCategory | 'usdc_fiat'   // 商家担保物资产类别(merchant security deposit only;operator_attested 人工核实轨两类都收)
  legalCleared: boolean                  // 法务清门(担保物定性 / DTSP 等);默认 false
  jurisdictionAllowlist: string[]        // 已放行法域;默认空 = 任何 jurisdiction 都拒
  policyVersion: string                  // 生效 policy 版本;占位 = 未设
  productionReady: boolean               // 真实生产收款实现 + 运维就绪;默认 false
}

/** policy_version 占位值(= 未设)。等于此值即视为未放行。 */
export const BOND_POLICY_VERSION_PLACEHOLDER = 'pre-legal-unset'

export type BondRailBlocker =
  | 'RAIL_IMPLEMENTATION_GATED'   // Lock A 未过:无 legal-cleared 生产收款实现(deposit-rail gated / 非生产)
  | 'NO_LEGAL_CLEARED_RAIL'       // registry.legal_cleared / production_ready 未置真
  | 'EMPTY_JURISDICTION_ALLOWLIST'// registry.jurisdiction_allowlist 为空
  | 'POLICY_VERSION_UNSET'        // registry.policy_version 仍是占位
  | 'NO_PRODUCTION_RECEIPT'       // 该 deposit 尚无 production_receipt_confirmed_at(per-deposit)

/**
 * 生产 base-bond rail 放行 registry。【显式 switch / 常量,无注册框架】(anti-YAGNI,镜像 deposit-rails.ts)。
 * 只登记【生产收款轨】(usdc_onchain / fiat_psp);manual = 非生产确认轨,不在此(查询返回 null → fail-closed)。
 * 全部默认 fail-closed —— 真值由后续【法务清门 + 外审】PR 配置,不在本 scaffold。
 */
const BOND_RAIL_CLEARANCE: Record<string, BondRailClearance> = {
  // ✅ 2026-07-05 放行(Holden 决策 B,经营者知情自担;详见文件头)。policy_version = 条款版本(bond-terms.ts,
  //   缴纳前强制同意)。运营就绪:B1 申报/核实队列 + confirm-production(ROOT+Passkey)+ B2 退还 + B3 罚没全链已建。
  operator_attested: { railId: 'operator_attested', assetCategory: 'usdc_fiat', legalCleared: true, jurisdictionAllowlist: ['SG'], policyVersion: 'bond-terms.v1.2026-07-05', productionReady: true },
  // 自动收款轨:未实现(Lock A 也拒),维持全 fail-closed —— 与 operator_attested 放行无关。
  usdc_onchain: { railId: 'usdc_onchain', assetCategory: 'usdc', legalCleared: false, jurisdictionAllowlist: [], policyVersion: BOND_POLICY_VERSION_PLACEHOLDER, productionReady: false },
  fiat_psp: { railId: 'fiat_psp', assetCategory: 'fiat', legalCleared: false, jurisdictionAllowlist: [], policyVersion: BOND_POLICY_VERSION_PLACEHOLDER, productionReady: false },
}

/** 取某 rail 的放行记录;未登记(如 manual / 未知)→ null(fail-closed)。 */
export function getBondRailClearance(railId: string): BondRailClearance | null {
  return BOND_RAIL_CLEARANCE[railId] ?? null
}

/**
 * 该 rail 在该 jurisdiction 下是否【可用于生产 base-bond】= Lock A(真实实现)且 Lock B(registry 放行)全过。
 * jurisdiction 语义=【平台收款主体法域】(非卖家法域)。2026-07-05 起 operator_attested/SG 为 true(#240)。纯读,无副作用。
 */
export function isBondRailClearedForProduction(railId: string, jurisdiction: string): boolean {
  const c = getBondRailClearance(railId)
  if (!c) return false
  // Lock A:已实现的生产收款轨(deposit-rails)。与 assertProductionDepositRail 一致用 implemented(非 legalCleared)——
  //   legal/治理放行全归 Lock B(本函数下半段 registry)。manual=非生产;usdc/fiat=GATED(implemented=false)。
  let rail
  try { rail = getDepositRail(railId as DepositRailId) } catch { return false }
  if (!rail.isProduction || !rail.implemented) return false
  // Lock B:registry 放行(全字段)。
  return c.legalCleared && c.productionReady
    && c.policyVersion !== BOND_POLICY_VERSION_PLACEHOLDER && c.policyVersion.length > 0
    && typeof jurisdiction === 'string' && jurisdiction.length > 0
    && c.jurisdictionAllowlist.includes(jurisdiction)
}

/**
 * 生产 base-bond 放行【硬闸】(Lock B 入口):未完全放行即抛。confirmProductionReceipt 在 assertProductionDepositRail
 *   (Lock A)之后【额外】调用本闸 —— 两把独立锁都过才可能写 production receipt。当前恒抛。
 */
export function assertBondRailCleared(railId: string, jurisdiction: string): void {
  if (!isBondRailClearedForProduction(railId, jurisdiction)) {
    throw new Error(`bond rail '${railId}' is NOT legal-cleared for production (jurisdiction='${jurisdiction}'; blockers=${bondRailClearanceBlockers(railId).join(',') || 'none'}) — production base-bond receipt cannot be confirmed`)
  }
}

/**
 * 只读 readiness/blockers —— 列出某 rail 距离生产放行还差什么(供后续 Phase 7 readiness 面 / 运维诊断,不带 UI/endpoint)。
 * opts.hasProductionReceipt:某具体 deposit 是否已有 production_receipt_confirmed_at(per-deposit,调用方提供事实)。
 * 当前任何 rail 都至少含 RAIL_IMPLEMENTATION_GATED / NO_LEGAL_CLEARED_RAIL / EMPTY_JURISDICTION_ALLOWLIST / POLICY_VERSION_UNSET。
 */
export function bondRailClearanceBlockers(railId: string, opts?: { hasProductionReceipt?: boolean }): BondRailBlocker[] {
  const out: BondRailBlocker[] = []
  let rail = null
  try { rail = getDepositRail(railId as DepositRailId) } catch { rail = null }
  if (!rail || !rail.isProduction || !rail.implemented) out.push('RAIL_IMPLEMENTATION_GATED')
  const c = getBondRailClearance(railId)
  if (!c || !c.legalCleared || !c.productionReady) out.push('NO_LEGAL_CLEARED_RAIL')
  if (!c || c.jurisdictionAllowlist.length === 0) out.push('EMPTY_JURISDICTION_ALLOWLIST')
  if (!c || c.policyVersion === BOND_POLICY_VERSION_PLACEHOLDER || c.policyVersion.length === 0) out.push('POLICY_VERSION_UNSET')
  if (opts?.hasProductionReceipt !== true) out.push('NO_PRODUCTION_RECEIPT')
  return out
}
