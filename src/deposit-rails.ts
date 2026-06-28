/**
 * Deposit-rail 抽象 (设计稿 §6 base bond = 履约担保物/外部资产) — 外部资产(USDC/法币)收款的接口边界。
 * 已实现:manual(非生产/测试)+ operator_attested(运营核实生产轨:过 Lock A;放行仍由 registry/Lock B 治理开关、默认关)。
 *   生产 USDC-onchain / fiat-PSP【自动】收款仍【GATED】(真钱 / 链上 / PSP 自动集成未接),刻意抛错防误接线上。anti-YAGNI: 无注册框架。
 */
import type { Units } from './money.js'

export type DepositRailId = 'manual' | 'operator_attested' | 'usdc_onchain' | 'fiat_psp'

export interface DepositConfirmation {
  confirmed: boolean
  externalRef?: string
  reason?: string
}

/** 外部担保物收款轨契约。真实资产移动【不经本代码】(线下/链上;由公司运营/托管方负责);本层只判定 + 记录。 */
export interface DepositRail {
  id: DepositRailId
  isProduction: boolean
  /** 实现就绪:confirmReceipt 是【真实可调】的实现(非 gated 占位)。manual/operator_attested=true;usdc/fiat=GATED→false。
   *  Lock A(assertProductionDepositRail)= isProduction && implemented(这是不是一条建好的生产轨)。 */
  implemented: boolean
  /** 法务/治理放行 —— 仅信息位;真正的放行闸是 #112 rail-clearance registry(Lock B,治理可调、默认关、由 ROOT 翻)。
   *  本字段不再参与 Lock A,避免代码里出现"我替你置 legalCleared=true"。 */
  legalCleared: boolean
  /** 确认外部到账。manual: test/非生产;operator_attested: 运营线下/链上人工核实后凭 ref 记录(不收款/不持钥/不划转);
   *  usdc_onchain/fiat_psp: GATED → 抛错(真钱/链上/PSP 自动集成未接)。 */
  confirmReceipt(args: { depositId: string; expectedAmount: Units; currency: string; externalRef?: string }): DepositConfirmation
}

/**
 * 非生产确认:由真人 admin/operator 在【受控/测试环境】确认(不接真实链 / PSP)。
 * ⚠️ TEST / ADMIN-ONLY —— **绝不可用于 production go-live**。它无条件返回 confirmed=true,不代表真实 base bond 到位。
 *   生产收款侧必须:(a) 用 `assertProductionDepositRail()` 显式拒绝本轨;且 (b) 仅在 deposit 行
 *   `production_receipt_confirmed_at` 非 NULL 时才视为担保物到位(manual 轨不写该列)。
 */
export const MANUAL_DEPOSIT_RAIL: DepositRail = {
  id: 'manual',
  isProduction: false,
  implemented: true,
  legalCleared: false,
  confirmReceipt: ({ externalRef }) => ({ confirmed: true, externalRef: externalRef ?? 'manual' }),
}

/**
 * operator-attested 生产轨:履约保证金走【公司企业账户(法币)/ 专项钱包地址(USDC 等)】线下/链上交存,
 *   由 ROOT + 真人 Passkey 的运营在【核实到账后】凭 ref 记录确认。**本代码不收款、不持私钥、不签名、不划转**——
 *   真实资金保管/退还是公司运营/托管方责任,代码只做"已核实"的记录 + 资格判定。
 * 这是一条【已实现】的生产轨(implemented=true),但是否放行仍由 #112 rail-clearance registry(Lock B,治理默认关)决定:
 *   在 ROOT 翻开放行开关之前,confirmProductionReceipt 仍因 Lock B 抛 → 全程 fail-closed。
 */
export const OPERATOR_ATTESTED_DEPOSIT_RAIL: DepositRail = {
  id: 'operator_attested',
  isProduction: true,
  implemented: true,
  legalCleared: false,   // 信息位;放行由 registry/Lock B 治理开关决定,不在此置 true
  confirmReceipt: ({ externalRef }) => ({ confirmed: true, externalRef: externalRef ?? 'operator_attested' }),
}

/**
 * 生产闸(Lock A):生产 go-live 路径在依赖 base bond 到位前必须调用。要求 **isProduction 且 implemented**
 *   (= 这是一条建好的生产轨)。legal/治理放行是【独立的 Lock B】(assertBondRailCleared / rail-clearance registry)。
 * 现状:manual=非生产;usdc_onchain/fiat_psp=GATED 未实现 → 均抛;operator_attested 过 Lock A,但仍被 Lock B(默认关)挡。
 */
export function assertProductionDepositRail(rail: DepositRail): void {
  if (!rail.isProduction || !rail.implemented) {
    throw new Error(`deposit-rail '${rail.id}' is NOT an implemented production rail (isProduction=${rail.isProduction}, implemented=${rail.implemented}) — cannot be used for production base-bond receipt; legal/governance clearance is enforced separately by the rail-clearance registry (Lock B)`)
  }
}

/** 生产收款轨【GATED】—— 真钱/链上/PSP 自动集成未接,调用即抛。implemented=false → 也过不了 Lock A。 */
function gated(id: DepositRailId): DepositRail {
  return {
    id, isProduction: true, implemented: false, legalCleared: false,
    confirmReceipt: () => { throw new Error(`deposit-rail '${id}' is GATED: real-money/on-chain/PSP receipt not built (legal review: security-deposit characterisation + USDC DTSP + real-money boundary required)`) },
  }
}

/** 取存款轨实现。manual=非生产;operator_attested=运营核实(已实现,放行仍由 Lock B 治理开关);usdc/fiat=GATED。显式 switch。 */
export function getDepositRail(railId: DepositRailId): DepositRail {
  if (railId === 'manual') return MANUAL_DEPOSIT_RAIL
  if (railId === 'operator_attested') return OPERATOR_ATTESTED_DEPOSIT_RAIL
  return gated(railId)
}
