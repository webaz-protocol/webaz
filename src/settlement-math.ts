/**
 * Settlement split — settleOrder 正常成交的资金拆分【纯函数】(RFC-014,可测)。
 *
 * 把买家托管的 total 拆成:协议费(再 50/50 拆津贴/运营)+ 物流费 + 佣金池 + 基金 1% + 首单锁定 stake
 *   + 卖家净额。卖家净额 = total − 其余各项(residual 吸收)→ 整数单位下【精确守恒】(Σ ≡ total)。
 *
 * server.ts settleOrder 直接调用本函数拿数字,再落库(applyWalletDelta/creditColumns)。
 * 守恒由 tests/test-settlement-math.ts 守(此前 settleOrder 在 server.ts 巨石里、绑 db 闭包,无法隔离单测)。
 */
import { mulRate, allocate, type Units } from './money.js'

export interface SettlementInput {
  totalU: Units            // 买家托管总额(整数 base-units)
  feeRate: number          // 协议费率(shop 0.02 / secondhand 0.01)
  logisticsRate: number    // 物流费率(0.05;面交=不收,见 chargeLogistics)
  chargeLogistics: boolean // 是否真收物流费(有三方 logistics_id 且非面交)
  commissionRate: number   // 佣金池率(snapshot_commission_rate)
  fundRate: number         // 基金入池率(fund_base_rate 1%)
  stakeToLockU: Units      // 首单锁定的 stake(从卖家净额划出),无则 0
}

export interface SettlementSplit {
  protocolFeeU: Units
  protocolToReserveU: Units  // 协议费 50% → 协议储备池(protocol_reserve_pool)
  protocolToOpsU: Units    // 协议费 50% → sys_protocol 运营
  logisticsFeeU: Units     // 名义物流费(始终算出,供支付给 logistics)
  logisticsActualU: Units  // 实际从卖家净额扣的物流费(self-fulfill / 面交 = 0)
  commissionPoolU: Units
  fundBaseU: Units
  stakeToLockU: Units
  sellerAmountU: Units     // 卖家净额(residual,吸收一切取整余数)
}

export function computeSettlementSplit(i: SettlementInput): SettlementSplit {
  const protocolFeeU = mulRate(i.totalU, i.feeRate)
  const [protocolToReserveU, protocolToOpsU] = allocate(protocolFeeU, [1, 1])  // 精确 50/50
  const logisticsFeeU = mulRate(i.totalU, i.logisticsRate)
  const logisticsActualU = i.chargeLogistics ? logisticsFeeU : 0
  const commissionPoolU = mulRate(i.totalU, i.commissionRate)
  const fundBaseU = mulRate(i.totalU, i.fundRate)
  const stakeToLockU = i.stakeToLockU
  // 卖家净额 = 残值 → 保证 Σ ≡ total(整数减法精确,不增发/不丢)
  const sellerAmountU = i.totalU - protocolFeeU - logisticsActualU - commissionPoolU - fundBaseU - stakeToLockU
  return { protocolFeeU, protocolToReserveU, protocolToOpsU, logisticsFeeU, logisticsActualU, commissionPoolU, fundBaseU, stakeToLockU, sellerAmountU }
}

/** 守恒校验(供测试 + 运行期可选断言):各去向之和 ≡ total。 */
export function settlementConserves(totalU: Units, s: SettlementSplit): boolean {
  return s.protocolToReserveU + s.protocolToOpsU === s.protocolFeeU
    && s.protocolFeeU + s.logisticsActualU + s.commissionPoolU + s.fundBaseU + s.stakeToLockU + s.sellerAmountU === totalU
}
