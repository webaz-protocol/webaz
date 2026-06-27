/**
 * Deposit-rail 抽象 (设计稿 §6 base bond = 履约担保物/外部资产) — 外部资产(USDC/法币)收款的接口边界。
 * 本 PR 只实现【非生产确认】(manual / admin / testnet);生产 USDC-onchain / fiat-PSP 收款【GATED】
 *   (真钱 / 链上边界 + 法务:担保物定性 + USDC DTSP),刻意抛错防误接线上。anti-YAGNI: 无注册框架。
 */
import type { Units } from './money.js'

export type DepositRailId = 'manual' | 'usdc_onchain' | 'fiat_psp'

export interface DepositConfirmation {
  confirmed: boolean
  externalRef?: string
  reason?: string
}

/** 外部担保物收款轨契约。真实资产移动由实现负责;生产实现 GATED(本 PR 不接)。 */
export interface DepositRail {
  id: DepositRailId
  isProduction: boolean
  /** 法务清门 + 真实生产实现就绪。【所有现有轨均 false】(manual=非生产;usdc/fiat=GATED 未实现)。
   *  只有真实 legal-cleared 生产收款实现落地后,该轨才置 true —— 在此之前 assertProductionDepositRail 一律拒。 */
  legalCleared: boolean
  /** 确认外部到账。manual: 真人 admin/operator 在受控环境确认;生产实现 GATED → 抛错。 */
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
  legalCleared: false,
  confirmReceipt: ({ externalRef }) => ({ confirmed: true, externalRef: externalRef ?? 'manual' }),
}

/**
 * 生产闸:任何【生产 go-live】路径在依赖 base bond 到位前必须调用本函数。
 * 要求 isProduction **且** legalCleared —— 二者缺一即抛。当前【所有】轨都过不了:
 *   manual = 非生产;usdc_onchain / fiat_psp = GATED 未实现(legalCleared=false)。
 * 故在真实 legal-cleared 生产收款实现落地前,生产路径无法把任何轨当成 base bond 到位。
 */
export function assertProductionDepositRail(rail: DepositRail): void {
  if (!rail.isProduction || !rail.legalCleared) {
    throw new Error(`deposit-rail '${rail.id}' is NOT a legal-cleared production rail (isProduction=${rail.isProduction}, legalCleared=${rail.legalCleared}) — cannot be used for production base-bond receipt; requires a legal-cleared production implementation + production_receipt_confirmed_at`)
  }
}

/** 生产收款轨【GATED】—— 未实现,调用即抛(防真钱 / 链上 / PSP 误接线上)。legalCleared=false → 也过不了生产闸。 */
function gated(id: DepositRailId): DepositRail {
  return {
    id, isProduction: true, legalCleared: false,
    confirmReceipt: () => { throw new Error(`deposit-rail '${id}' is GATED: real-money/on-chain/PSP receipt not built (legal review: security-deposit characterisation + USDC DTSP + real-money boundary required)`) },
  }
}

/** 取存款轨实现。只 'manual' 非生产可用;'usdc_onchain' / 'fiat_psp' = GATED。显式 switch,无注册框架(anti-YAGNI)。 */
export function getDepositRail(railId: DepositRailId): DepositRail {
  if (railId === 'manual') return MANUAL_DEPOSIT_RAIL
  return gated(railId)
}
