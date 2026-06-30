/**
 * Direct Pay (Rail 1) — LAUNCH CONTROLS / 生产入口门 SSOT (PR-4a / Phase 4a)。
 *
 * 这是 Direct Pay 走向生产的【控制面单一真相源】。它只回答一个问题:在【当前控制配置 + 已核实事实】下,
 *   是否允许进入既有 direct_p2p 建单流程。默认【全部 fail-closed / disabled】—— 没有任何真实支付能力在此打开。
 *
 * 刻意边界(避免越界/误放行):
 *  - 纯判定 + 一个薄 config 装配器 + fail-closed 事实读取(KYB + sanctions)。【不】实现真实 base-bond deposit,
 *    【不】接 USDC/fiat/PSP/链上,【不】碰 buyer wallet / escrow / settlement / refund,【不】改订单状态机。
 *  - FAIL-CLOSED:全局开关默认关;运营熔断可一键停;地区白名单默认空;单笔上限默认 0(=WebAZ 记录订单总额天花板,
 *    【不】控制场外实付;具体数值由 launch-policy PR 配);卖家熔断;production base-bond + KYC/制裁默认必需(硬不变量)。
 *    任一事实缺失/坏值 → 拒。绝不因数据缺失意外放行。
 *  - KYB/制裁 = Phase 6A fail-closed scaffold(本模块消费;复核结论由 direct_receive_kyb_reviews/sanctions_screening
 *    台账提供,无第三方 vendor/真实 API;运行期 AML 断路器扩展仍后续 Phase);本模块只消费【已核实布尔事实】+ 治理可调参数。
 *  - 档位/折扣算 requiredBaseBondUnits = PR-5/4b;入门资格谓词(账龄等)= 4a evaluateDirectReceiveEligibility。
 *    本控制面与它们正交,调用方各自 AND。
 */
import type Database from 'better-sqlite3'
import type { Units } from './money.js'
// PR-6D: 把 #108 的 AML 监控 param 描述(默认 inert)经控制面统一再导出,使 server.ts DEFAULT_PARAMS
//   可在【既有 import 行】上一并取用(server.ts 已到 LOC 上限,避免新增行)。SSOT 仍在 direct-pay-aml-monitor.ts。
export { DIRECT_PAY_AML_PARAMS } from './direct-pay-aml-monitor.js'

/** 拒绝原因(机器码;UI 映射双语 t())。 */
export type DirectPayControlReason =
  | 'DIRECT_PAY_DISABLED'            // 全局开关 / 熔断关闭(未上线)
  | 'DIRECT_PAY_RAIL_BREAKER'        // 运营紧急熔断(ops emergency stop;与 enabled 上线开关分离)
  | 'DIRECT_PAY_REGION_UNSUPPORTED' // 本部署地区不在已开放白名单
  | 'DIRECT_PAY_CAP_EXCEEDED'       // WebAZ 记录的订单总额超过单笔上限(或上限未配置);不约束场外实付
  | 'DIRECT_PAY_SELLER_SUSPENDED'   // 该卖家被熔断/暂停(per-seller breaker)
  | 'DIRECT_PAY_NOT_AVAILABLE'      // 卖家未交履约保证金且无有效缓交(base-bond OR active deferral 都不满足)
  | 'DIRECT_PAY_KYC_REQUIRED'       // 卖家未通过 KYC/制裁筛查
  | 'DIRECT_PAY_AML_REVIEW_REQUIRED'// 卖家存在未清除的中/高风险 AML flag(运行期断路器;PR-6B)

// ── buyer-facing de-identification(SSOT)─────────────────────────────────────────────────────────
// 买家边界脱敏:卖家【私密类】拒因(暂停 / 保证金未交 / KYC·制裁 / AML / 缓交额度)一律收敛为单一
//   DIRECT_PAY_SELLER_NOT_ELIGIBLE,绝不向买家暴露卖家具体合规/额度状态。全局/运营类(DISABLED / RAIL_BREAKER /
//   REGION / CAP)非敏感,原样透出。create 与 availability 两个买家面端点【共用】本判定,避免 de-id 集合漂移。
//   精确 code 仍保留在 helper 返回值 + 单测(controls / deferral-quota)层,供运营/调试与 gate 逻辑验证。
//   缓交额度码须与 direct-pay-deferral-quota.ts 的 DEFERRAL_QUOTA_CODES 对齐(test-direct-pay-deferral-quota 漂移断言守护)。
export const DIRECT_PAY_SELLER_NOT_ELIGIBLE = 'DIRECT_PAY_SELLER_NOT_ELIGIBLE'
export const BUYER_FACING_SELLER_PRIVATE_CODES: ReadonlySet<string> = new Set([
  'DIRECT_PAY_SELLER_SUSPENDED', 'DIRECT_PAY_NOT_AVAILABLE', 'DIRECT_PAY_KYC_REQUIRED', 'DIRECT_PAY_AML_REVIEW_REQUIRED',
  'DIRECT_PAY_DEFERRAL_QUOTA_EXCEEDED', 'DIRECT_PAY_DEFERRAL_AMOUNT_EXCEEDED',
  'EXPOSURE_CAP_EXCEEDED', 'EXPOSURE_CAP_CONFIG',   // §6.5 抵押背书敞口上限:卖家私密风险态,不向买家泄露
  'FEE_PREPAY_INSUFFICIENT',   // 平台服务费预充值余额不足(非首单):卖家私密风险态,不向买家泄露
])
/** 买家面脱敏:私密拒因 → 通用 SELLER_NOT_ELIGIBLE;全局/运营类原样;undefined → 通用(fail-safe,绝不泄露)。 */
export function coarsenBuyerFacingDirectPayCode(code: string | undefined): string {
  return !code || BUYER_FACING_SELLER_PRIVATE_CODES.has(code) ? DIRECT_PAY_SELLER_NOT_ELIGIBLE : code
}

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
  baseBondSatisfied: boolean    // 保证金门:已交生产级 base-bond 【或】有有效缓交(sellerBaseBondEntrySatisfied);缺一即拒
  kycSanctionsPassed: boolean       // KYB AND sanctions(PR-6A;两者皆过)
  amlClear: boolean                 // 运行期 AML 断路器:无未清除的中/高风险 flag(PR-6B);与 kycSanctionsPassed 分离,语义独立
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
 *   全局开关 → 运营熔断 → 地区 → 单笔上限 → 卖家熔断 → production base-bond → KYC/制裁 → AML 断路器。
 *   任一不过即返回该项拒绝码(短路;先全局/政策、后卖家专属,避免提前泄露卖家专属原因);全过返回 { ok:true }。绝不抛错。
 *   production base-bond、KYC/制裁、AML 断路器都是【不可配置硬不变量】(无 cfg 开关、治理不可绕过),恒在最后强制。
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
  if (f.baseBondSatisfied !== true) return deny('DIRECT_PAY_NOT_AVAILABLE', '直付暂不可用:卖家未交履约保证金且无有效缓交')
  if (f.kycSanctionsPassed !== true) return deny('DIRECT_PAY_KYC_REQUIRED', '直付暂不可用:卖家未通过 KYC/制裁筛查')
  if (f.amlClear !== true) return deny('DIRECT_PAY_AML_REVIEW_REQUIRED', '直付暂不可用:卖家存在未清除的 AML 风险复核')
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
  { key: 'direct_pay.exposure_factor_bps', value: '8000', type: 'number', description: '§6.5 抵押背书的开放敞口上限系数(bps):open_exposure + new_order ≤ active_collateral × bps/10000。仅对有真实链上抵押(collateral>0)的卖家生效;缓交卖家不受此门。默认 8000(=80%)。风险控制,非买家赔付。', category: 'system', min: 1, max: 10000 },
  // 注:平台服务费门 = 首单宽限 + 预充值续用(数据驱动:available_prepay = Σ预充值 − Σ已计提费),【无 protocol_param 旋钮】
  //   (额度即商家实际预付余额,宽限自动判定);故此处不再有 fee_ar_credit_ceiling_units 参数。
]

/**
 * PR-6A AML/CFT runtime — KYB(商户尽调)事实(fail-closed)。来源 direct_receive_kyb_reviews(真人/合规复核结论;
 *   无第三方 vendor、无真实 API 调用)。通过 ⟺ 存在 status='approved' 且未过期的复核 且【无】rejected/revoked 行。
 *   missing / pending / rejected / revoked / expired 一律不通过。该表无生产写入方 → 真实卖家天然 fail-closed。
 */
export function sellerDirectPayKybPassed(db: Database.Database, sellerId: string): boolean {
  const approved = db.prepare("SELECT 1 FROM direct_receive_kyb_reviews WHERE user_id = ? AND status = 'approved' AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1").get(sellerId)
  const blocked = db.prepare("SELECT 1 FROM direct_receive_kyb_reviews WHERE user_id = ? AND status IN ('rejected','revoked') LIMIT 1").get(sellerId)
  return !!approved && !blocked
}

/**
 * PR-6A AML/CFT runtime — 制裁筛查事实(fail-closed)。来源 sanctions_screening:存在 status='clear' 且未过期的结论,
 *   且【无】flagged/blocked 行。expired(expires_at 已过)视作未通过;NULL expires_at = 无期限。无第三方集成。
 *   该表无生产写入方 → 真实卖家天然 fail-closed。
 */
export function sellerDirectPaySanctionsClear(db: Database.Database, sellerId: string): boolean {
  const clear = db.prepare("SELECT 1 FROM sanctions_screening WHERE user_id = ? AND status = 'clear' AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1").get(sellerId)
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

/**
 * PR-6B AML 运行期断路器事实(fail-closed)。来源 aml_flags(本仓内部监控 flag;无第三方 vendor、无真实 API)。
 *   key = subject_user_id。返回 true(清白/不阻断)⟺ 卖家【没有任何阻断性 flag】。
 *
 * 单条 flag 的【阻断】判定(任一命中即阻断;precedence 由 SQL OR 短路保证 suspend 优先于 cleared):
 *   ① malformed enum —— severity/status/disposition 越界(本表 TEXT 无 CHECK,脏值可入)→ fail-closed 阻断;
 *   ② disposition='suspend' —— 无论 severity/status【一律阻断】(含 status='cleared' 的矛盾数据:suspend 取胜,从严);
 *   ③ status∈(open|reviewing|escalated|str_filed) 且 severity∈(medium|high) —— 未清除的中/高风险 → 阻断。
 * 非阻断(放行):无 flag / status='cleared'(且非 suspend) / severity='low'(且非 suspend)。
 *   纯读;不写;不碰资金/状态机。aml_flags 当前无生产写入方 → 真实卖家天然无阻断(待 AML 检测引擎接入再产生 flag)。
 */
export function sellerDirectPayAmlClear(db: Database.Database, sellerId: string): boolean {
  const blocking = db.prepare(`SELECT 1 FROM aml_flags WHERE subject_user_id = ? AND (
         severity NOT IN ('low','medium','high')
      OR status   NOT IN ('open','reviewing','cleared','escalated','str_filed')
      OR (disposition IS NOT NULL AND disposition NOT IN ('review_queue','downgrade','suspend'))
      OR disposition = 'suspend'
      OR (status IN ('open','reviewing','escalated','str_filed') AND severity IN ('medium','high'))
    ) LIMIT 1`).get(sellerId)
  return !blocking
}
