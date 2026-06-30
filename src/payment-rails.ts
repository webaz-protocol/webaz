/**
 * Payment-rail 抽象 (设计稿 §8) — 让订单状态机/费用/争议逻辑【与轨道无关】。
 * anti-YAGNI: 只实现 Rail 1 (direct_p2p)。Rail 2 (on-chain full-stake) / Rail 3 (PSP) 是【契约占位】,未实现。
 *   "Reserved" = 干净接口 + 文档化契约,不是预建空脚手架 / 插件注册框架。
 */
import type Database from 'better-sqlite3'
import { takeFeeAtCompletion, releaseFeeStake, slashFeeStakeToPenalty } from './direct-pay-ledger.js'

export type PaymentRailId = 'escrow' | 'direct_p2p' | 'onchain_full_stake' | 'psp'

/** 轨道契约元数据(供披露/UI/争议逻辑读取;不含任何跨方机密)。 */
export interface RailContract {
  id: PaymentRailId
  buyerProtection: 'deterministic' | 'fund_backed' | 'reputation_only'
  refund: 'protocol' | 'on_chain' | 'psp' | 'none'
  disputeRemedyBasis: 'escrow_redistribute' | 'slash_stake_to_buyer' | 'evidence_reputation' | 'psp_chargeback'
  custodialOfTradeFunds: boolean
}

/** 订单生命周期对轨道的调用面(状态机只调这些,不碰具体实现)。 */
export interface PaymentRail {
  contract: RailContract
  /** 完成点:收取平台费(Rail1: 从 fee-stake 取 → 协议)。 */
  collectFeeAtCompletion(db: Database.Database, orderId: string): void
  /** 未付 / 取消 / 超时:释放质押(Rail1: fee-stake 退卖家)。 */
  releaseOnExpiryOrCancel(db: Database.Database, orderId: string): void
  /** 违约:罚没(Rail1: fee-stake → penalty 科目)。 */
  slashOnFault(db: Database.Database, orderId: string, txnId: string, reason?: string): void
}

/**
 * Rail 1 = 非托管场外直付 + 信誉(buyer protection = reputation-only, refund = none)。
 * ⚠️ 本 seam 当前【未接线】(getPaymentRail 无调用方)。Rail1 平台费【实时路径】= 首单宽限 + 预充值续用:
 *   建单走【首单宽限 + 预充值门】(direct-pay-create.ts),完成时 accrue 应收(server.ts settleOrder direct_p2p 分支)。
 *   下方 collectFeeAtCompletion/release/slash 仍指向旧 WAZ fee-stake helper = 遗留/forward-compat 占位;
 *   若将来真接线本 seam,须改为应收/预充值语义(accrue / prepay)。
 */
export const RAIL_DIRECT_P2P: PaymentRail = {
  contract: {
    id: 'direct_p2p',
    buyerProtection: 'reputation_only',
    refund: 'none',
    disputeRemedyBasis: 'evidence_reputation',
    custodialOfTradeFunds: false,
  },
  collectFeeAtCompletion: (db, orderId) => takeFeeAtCompletion(db, { orderId }),
  releaseOnExpiryOrCancel: (db, orderId) => releaseFeeStake(db, { orderId }),
  slashOnFault: (db, orderId, txnId, reason) => slashFeeStakeToPenalty(db, { orderId, txnId, reason }),
}

/**
 * 取轨道实现。只 Rail 1 已实现;'escrow' 走既有系统(不经此抽象);'onchain_full_stake' / 'psp' = GATED(未实现)。
 * 故意用显式 switch,不建插件注册框架(anti-YAGNI)。
 */
export function getPaymentRail(railId: PaymentRailId): PaymentRail | null {
  if (railId === 'direct_p2p') return RAIL_DIRECT_P2P
  return null // escrow=既有系统; onchain_full_stake/psp=未实现(forward-compat 契约见上)
}
