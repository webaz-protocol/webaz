/**
 * Direct Pay (Rail 1) — LAUNCH CONTROLS / 生产入口门 SSOT (PR-4a / Phase 4a)。
 *
 * 这是 Direct Pay 走向生产的【控制面单一真相源】。它只回答一个问题:在【当前控制配置 + 已核实事实】下,
 *   是否允许进入既有 direct_p2p 建单流程。默认【全部 fail-closed / disabled】—— 没有任何真实支付能力在此打开。
 *
 * 刻意边界(避免越界/误放行):
 *  - 纯判定 + 一个薄 config 装配器 + 一个 fail-closed 事实读取(sanctions)。【不】实现真实 base-bond deposit,
 *    【不】接 USDC/fiat/PSP/链上,【不】碰 buyer wallet / escrow / settlement / refund,【不】改订单状态机。
 *  - FAIL-CLOSED:全局开关默认关;运营熔断可一键停;地区白名单默认空;单笔上限默认 0(=WebAZ 记录订单总额天花板,
 *    【不】控制场外实付;具体数值由 launch-policy PR 配);卖家熔断;production base-bond + KYC/制裁默认必需(硬不变量)。
 *    任一事实缺失/坏值 → 拒。绝不因数据缺失意外放行。
 *  - 真实 KYC/KYB 与运行期 AML 断路器 = Phase 6(deferred);本模块只消费【已核实布尔事实】+ 治理可调参数。
 *  - 档位/折扣算 requiredBaseBondUnits = PR-5/4b;入门资格谓词(账龄等)= 4a evaluateDirectReceiveEligibility。
 *    本控制面与它们正交,调用方各自 AND。
 */
import type Database from 'better-sqlite3'
import type { Units } from './money.js'

/** 拒绝原因(机器码;UI 映射双语 t())。 */
export type DirectPayControlReason =
  | 'DIRECT_PAY_DISABLED'            // 全局开关 / 熔断关闭(未上线)
  | 'DIRECT_PAY_RAIL_BREAKER'        // 运营紧急熔断(ops emergency stop;与 enabled 上线开关分离)
  | 'DIRECT_PAY_REGION_UNSUPPORTED' // 本部署地区不在已开放白名单
  | 'DIRECT_PAY_CAP_EXCEEDED'       // WebAZ 记录的订单总额超过单笔上限(或上限未配置);不约束场外实付
  | 'DIRECT_PAY_SELLER_SUSPENDED'   // 该卖家被熔断/暂停(per-seller breaker)
  | 'DIRECT_PAY_NOT_AVAILABLE'      // 卖家未完成生产级 base-bond
  | 'DIRECT_PAY_KYC_REQUIRED'       // 卖家未通过 KYC/制裁筛查

/** 治理【可调】控制配置(protocol_params 装配;默认 fail-closed)。
 *  注意:production base-bond 与 KYC/制裁是【不可关闭的硬不变量】(launch blockers),【不】放进可调配置 ——
 *  evaluate 始终强制,治理无法通过任何 param 绕过(见下方 evaluate)。这里只放运营节流类(开关/地区/上限)。 */
export interface DirectPayControlsConfig {
  enabled: boolean              // 全局主开关(上线决定;默认 false)
  railBreakerTripped: boolean   // 运营紧急熔断(ops emergency stop;与 enabled 分离;默认 false=未熔断)
  region: string                // 本部署/运营所在地区(operator 声明;默认 '')
  regionAllowlist: string[]     // 已开放 Direct Pay 的地区(默认 [])
  perTxCapUnits: Units          // 单笔上限:对【WebAZ 记录的 direct_p2p 订单总额】在建单时的天花板(整数 policy base-units;默认 0=无放行)。
                                //   ⚠️ 仅约束协议侧建单金额;买卖双方【场外】实际付款金额 WebAZ 控制不了,也不在此声称能控。具体数值由 launch-policy PR 配。
}

export const DEFAULT_DIRECT_PAY_CONTROLS: DirectPayControlsConfig = {
  enabled: false, railBreakerTripped: false, region: '', regionAllowlist: [], perTxCapUnits: 0,
}

/** 已核实事实快照(调用方装配;缺失即 fail-closed)。 */
export interface DirectPayControlsFacts {
  amountUnits: Units            // 本单金额(整数 base-units)
  sellerBreakerTripped: boolean // 该卖家被熔断/暂停(per-seller breaker;true=拒)。来源由 5b 装配(如 privileges.suspended)。
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
 * 入口控制判定(纯、fail-closed、total)。顺序(便宜/广 → 卖家专属 → 硬不变量):
 *   全局开关 → 运营熔断 → 地区 → 单笔上限 → 卖家熔断 → production base-bond → KYC/制裁。
 *   任一不过即返回该项拒绝码(短路;先全局/政策、后卖家专属,避免提前泄露卖家专属原因);全过返回 { ok:true }。绝不抛错。
 *   production base-bond 与 KYC/制裁是【不可配置硬不变量】(无 cfg 开关、治理不可绕过),恒在最后强制。
 */
export function evaluateDirectPayLaunchControls(
  cfg: Partial<DirectPayControlsConfig> | null | undefined,
  facts: Partial<DirectPayControlsFacts> | null | undefined,
): DirectPayControlsDecision {
  const c = { ...DEFAULT_DIRECT_PAY_CONTROLS, ...(cfg ?? {}) }
  const f = facts ?? {}
  const deny = (error_code: DirectPayControlReason, reason: string): DirectPayControlsDecision => ({ ok: false, status: 409, error_code, reason })

  if (c.enabled !== true) return deny('DIRECT_PAY_DISABLED', '直付当前未开放(全局开关关闭)')
  if (c.railBreakerTripped === true) return deny('DIRECT_PAY_RAIL_BREAKER', '直付已被运营紧急熔断,暂停受理')
  const allow = Array.isArray(c.regionAllowlist) ? c.regionAllowlist : []
  if (!allow.length || !c.region || !allow.includes(c.region)) return deny('DIRECT_PAY_REGION_UNSUPPORTED', '直付在本地区暂未开放')
  if (!isNonNegUnits(c.perTxCapUnits) || c.perTxCapUnits <= 0) return deny('DIRECT_PAY_CAP_EXCEEDED', '直付单笔上限未配置')
  if (!isNonNegUnits(f.amountUnits) || f.amountUnits <= 0 || f.amountUnits > c.perTxCapUnits) return deny('DIRECT_PAY_CAP_EXCEEDED', '直付订单总额超出单笔上限(WebAZ 记录的订单金额上限;不约束场外实付)')
  if (f.sellerBreakerTripped === true) return deny('DIRECT_PAY_SELLER_SUSPENDED', '该卖家直付已被暂停')
  // 硬不变量(launch blockers):production base-bond 与 KYC/制裁【始终强制】,无 cfg 开关、治理不可绕过。
  if (f.productionBaseBondLocked !== true) return deny('DIRECT_PAY_NOT_AVAILABLE', '直付暂不可用:卖家未完成生产级履约担保(production base-bond)')
  if (f.kycSanctionsPassed !== true) return deny('DIRECT_PAY_KYC_REQUIRED', '直付暂不可用:卖家未通过 KYC/制裁筛查')
  return { ok: true, status: 200 }
}

/** protocol_params 薄装配器(治理可调;缺行回落 fail-closed 默认)。不读资金/状态,只读控制参数。 */
export function readDirectPayControlsConfig(getProtocolParam: <T>(key: string, fallback: T) => T): DirectPayControlsConfig {
  const csv = String(getProtocolParam('direct_pay.region_allowlist', '') || '')
  const cap = Number(getProtocolParam('direct_pay.per_tx_cap_units', 0))
  return {
    enabled: getProtocolParam<boolean>('direct_pay.enabled', false) === true,
    railBreakerTripped: getProtocolParam<boolean>('direct_pay.rail_breaker_tripped', false) === true,
    region: String(getProtocolParam('direct_pay.region', '') || ''),
    regionAllowlist: csv.split(',').map(s => s.trim()).filter(Boolean),
    perTxCapUnits: Number.isSafeInteger(cap) && cap >= 0 ? cap : 0,
  }
}

/**
 * protocol_params 默认 seed(供 server.ts DEFAULT_PARAMS 展开)。默认全 fail-closed —— Direct Pay non-launchable;
 *   治理经 PATCH /api/admin/protocol-params/<key> 开通(无 seed 则 PATCH 404、boot 不建行 → 控制面打不开)。
 *   只含【运营节流】可调项(开关/地区/上限)。production base-bond 与 KYC/制裁是【不可关闭的硬不变量】,
 *   刻意【不】做成 param —— 治理无法关掉它们绕过 launch blockers(evaluate 始终强制)。
 *   key/默认值必须与 readDirectPayControlsConfig / DEFAULT_DIRECT_PAY_CONTROLS 对齐。
 */
export const DIRECT_PAY_CONTROL_PARAMS: Array<{ key: string; value: string; type: string; description: string; category: string; min?: number; max?: number }> = [
  { key: 'direct_pay.enabled', value: 'false', type: 'boolean', description: 'Direct Pay 全局主开关(上线决定);默认 false=关(non-launchable)。', category: 'system' },
  { key: 'direct_pay.rail_breaker_tripped', value: 'false', type: 'boolean', description: 'Direct Pay 运营紧急熔断(ops emergency stop,与 enabled 分离);true=暂停受理。默认 false。', category: 'system' },
  { key: 'direct_pay.region', value: '', type: 'string', description: 'Direct Pay 本部署/运营所在地区码(与白名单比对);默认空=fail-closed。', category: 'system' },
  { key: 'direct_pay.region_allowlist', value: '', type: 'string', description: 'Direct Pay 已开放地区白名单(逗号分隔);默认空=无地区开放。', category: 'system' },
  // 单笔上限:对【WebAZ 记录的 direct_p2p 订单总额】在建单时的天花板(整数 policy base-units)。默认 0 = 无放行(fail-closed),
  //   治理设正值方生效。【不是】对买卖双方场外真实付款金额的担保或控制——WebAZ 控不了场外金额,此处也不声称能控。
  //   具体数值(如 SG v1 的 policy units)由独立的 launch-policy PR 配置,本 PR 只提供 cap 能力、默认仍 fail-closed。
  { key: 'direct_pay.per_tx_cap_units', value: '0', type: 'number', description: 'Direct Pay 单笔上限:WebAZ 记录的订单总额天花板(整数 policy base-units);默认 0=无放行,治理设正值方可。仅约束协议侧建单金额,不控制/不担保场外真实付款。', category: 'system', min: 0 },
]

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

/**
 * 卖家熔断事实(per-seller breaker)。【唯一来源】= direct_receive_privileges.status = 'suspended'(复用既有暂停语义,
 *   如 slashBond 罚没后置 suspended);【不】新增第二套 suspension 概念。无行 / 'none' / 'active' → false;'suspended' → true。
 */
export function sellerDirectPayBreakerTripped(db: Database.Database, sellerId: string): boolean {
  return !!db.prepare("SELECT 1 FROM direct_receive_privileges WHERE user_id = ? AND status = 'suspended' LIMIT 1").get(sellerId)
}
