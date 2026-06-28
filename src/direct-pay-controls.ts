/**
 * Direct Pay (Rail 1) — LAUNCH CONTROLS / 生产入口门 SSOT (PR-4a / Phase 4a)。
 *
 * 这是 Direct Pay 走向生产的【控制面单一真相源】。它只回答一个问题:在【当前控制配置 + 已核实事实】下,
 *   是否允许进入既有 direct_p2p 建单流程。默认【全部 fail-closed / disabled】—— 没有任何真实支付能力在此打开。
 *
 * 刻意边界(避免越界/误放行):
 *  - 纯判定 + 一个薄 config 装配器 + 一个 fail-closed 事实读取(sanctions)。【不】实现真实 base-bond deposit,
 *    【不】接 USDC/fiat/PSP/链上,【不】碰 buyer wallet / escrow / settlement / refund,【不】改订单状态机。
 *  - FAIL-CLOSED:全局开关默认关;地区白名单默认空;单笔上限默认 0;production base-bond 默认必需;
 *    KYC/制裁默认必需。任一事实缺失/坏值 → 拒。绝不因数据缺失意外放行。
 *  - 真实 KYC/KYB 与运行期 AML 断路器 = Phase 6(deferred);本模块只消费【已核实布尔事实】+ 治理可调参数。
 *  - 档位/折扣算 requiredBaseBondUnits = PR-5/4b;入门资格谓词(账龄等)= 4a evaluateDirectReceiveEligibility。
 *    本控制面与它们正交,调用方各自 AND。
 */
import type Database from 'better-sqlite3'
import type { Units } from './money.js'

/** 拒绝原因(机器码;UI 映射双语 t())。 */
export type DirectPayControlReason =
  | 'DIRECT_PAY_DISABLED'            // 全局开关 / 熔断关闭(未上线)
  | 'DIRECT_PAY_REGION_UNSUPPORTED' // 本部署地区不在已开放白名单
  | 'DIRECT_PAY_CAP_EXCEEDED'       // 单笔金额超过上限(或上限未配置)
  | 'DIRECT_PAY_NOT_AVAILABLE'      // 卖家未完成生产级 base-bond
  | 'DIRECT_PAY_KYC_REQUIRED'       // 卖家未通过 KYC/制裁筛查

/** 治理可调控制配置(protocol_params 装配;默认 fail-closed)。 */
export interface DirectPayControlsConfig {
  enabled: boolean              // 全局主开关 / 断路器(默认 false)
  region: string                // 本部署/运营所在地区(operator 声明;默认 '')
  regionAllowlist: string[]     // 已开放 Direct Pay 的地区(默认 [])
  perTxCapUnits: Units          // 单笔金额上限(整数 base-units;默认 0 = 无放行)
  requireProductionBaseBond: boolean  // 默认 true
  requireKycSanctions: boolean        // 默认 true
}

export const DEFAULT_DIRECT_PAY_CONTROLS: DirectPayControlsConfig = {
  enabled: false, region: '', regionAllowlist: [], perTxCapUnits: 0,
  requireProductionBaseBond: true, requireKycSanctions: true,
}

/** 已核实事实快照(调用方装配;缺失即 fail-closed)。 */
export interface DirectPayControlsFacts {
  amountUnits: Units            // 本单金额(整数 base-units)
  productionBaseBondLocked: boolean
  kycSanctionsPassed: boolean
}

export interface DirectPayControlsDecision {
  ok: boolean
  status: number                // 用于 HTTP 响应(拒绝统一 409,沿用既有 create 路径语义)
  error_code?: DirectPayControlReason
  reason?: string               // zh;UI 映射双语
}

const isNonNegUnits = (x: unknown): x is Units => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

/**
 * 入口控制判定(纯、fail-closed、total)。顺序:全局 → 地区 → 单笔上限 → production base-bond → KYC/制裁。
 *   任一不过即返回该项拒绝码(短路);全过返回 { ok:true }。绝不抛错。
 */
export function evaluateDirectPayLaunchControls(
  cfg: Partial<DirectPayControlsConfig> | null | undefined,
  facts: Partial<DirectPayControlsFacts> | null | undefined,
): DirectPayControlsDecision {
  const c = { ...DEFAULT_DIRECT_PAY_CONTROLS, ...(cfg ?? {}) }
  const f = facts ?? {}
  const deny = (error_code: DirectPayControlReason, reason: string): DirectPayControlsDecision => ({ ok: false, status: 409, error_code, reason })

  if (c.enabled !== true) return deny('DIRECT_PAY_DISABLED', '直付当前未开放(全局开关/熔断关闭)')
  const allow = Array.isArray(c.regionAllowlist) ? c.regionAllowlist : []
  if (!allow.length || !c.region || !allow.includes(c.region)) return deny('DIRECT_PAY_REGION_UNSUPPORTED', '直付在本地区暂未开放')
  if (!isNonNegUnits(c.perTxCapUnits) || c.perTxCapUnits <= 0) return deny('DIRECT_PAY_CAP_EXCEEDED', '直付单笔上限未配置')
  if (!isNonNegUnits(f.amountUnits) || f.amountUnits <= 0 || f.amountUnits > c.perTxCapUnits) return deny('DIRECT_PAY_CAP_EXCEEDED', '直付单笔金额超出上限')
  if (c.requireProductionBaseBond !== false && f.productionBaseBondLocked !== true) return deny('DIRECT_PAY_NOT_AVAILABLE', '直付暂不可用:卖家未完成生产级履约担保(production base-bond)')
  if (c.requireKycSanctions !== false && f.kycSanctionsPassed !== true) return deny('DIRECT_PAY_KYC_REQUIRED', '直付暂不可用:卖家未通过 KYC/制裁筛查')
  return { ok: true, status: 200 }
}

/** protocol_params 薄装配器(治理可调;缺行回落 fail-closed 默认)。不读资金/状态,只读控制参数。 */
export function readDirectPayControlsConfig(getProtocolParam: <T>(key: string, fallback: T) => T): DirectPayControlsConfig {
  const csv = String(getProtocolParam('direct_pay.region_allowlist', '') || '')
  const cap = Number(getProtocolParam('direct_pay.per_tx_cap_units', 0))
  return {
    enabled: getProtocolParam<boolean>('direct_pay.enabled', false) === true,
    region: String(getProtocolParam('direct_pay.region', '') || ''),
    regionAllowlist: csv.split(',').map(s => s.trim()).filter(Boolean),
    perTxCapUnits: Number.isSafeInteger(cap) && cap >= 0 ? cap : 0,
    requireProductionBaseBond: getProtocolParam<boolean>('direct_pay.require_production_base_bond', true) !== false,
    requireKycSanctions: getProtocolParam<boolean>('direct_pay.require_kyc_sanctions', true) !== false,
  }
}

/**
 * 卖家制裁/KYC 事实(fail-closed)。当前唯一可用信号 = sanctions_screening:必须存在 status='clear' 行,
 *   且【无】flagged/blocked 行。真实 KYC/KYB 与运行期 AML 复筛 = Phase 6(deferred)—— 在它们建好前,
 *   真实卖家天然 fail-closed(该表无生产写入方)。
 */
export function sellerKycSanctionsPassed(db: Database.Database, sellerId: string): boolean {
  const clear = db.prepare("SELECT 1 FROM sanctions_screening WHERE user_id = ? AND status = 'clear' LIMIT 1").get(sellerId)
  const bad = db.prepare("SELECT 1 FROM sanctions_screening WHERE user_id = ? AND status IN ('flagged','blocked') LIMIT 1").get(sellerId)
  return !!clear && !bad
}
