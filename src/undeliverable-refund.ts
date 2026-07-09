/**
 * Undeliverable refund split — PR-B3a:escrow 买家责任(未派送成功)收口的资金拆分【纯函数】(可隔离单测)。
 *
 * 决策 5(方案 b,禁全额没收):买家承担【实际往返成本 + restocking】,余款退买家;卖家绝不因买家违约获利
 *   超过其真实成本(不牟利)。三种收口模式(护栏 B2):
 *   - goods_returned        卖家确认收货(带 return-tracking)→ refund = total − 去程 − 退程(capped)− restocking(capped)
 *   - seller_silent_default 卖家超时不确认 → 【默认退买家全款】(不确认=放弃成本扣除;fail-safe 偏买家)
 *   - goods_lost_forfeit    仲裁裁定货丢/弃货 → 全额没收给卖家(refund=0;仅仲裁可达,绝非自动)
 *
 * 护栏 A(反绕回方案 a):
 *   - restocking 基于【price(不含运费)】,费率 clamp 到硬帽 RESTOCKING_HARD_CAP_RATE=0.15 —— 即使
 *     protocol_params 值被改高(或 DB 值异常),结算层也绝不超 15%。
 *   - 退程运费=卖家申报【实际值】,clamp 到 mulRate(total, return_shipping_max_rate)(默认帽 0.20/硬帽 0.30),防灌水。
 *   - 去程运费(order.shipping_fee)已并入 total,只扣这一次 —— 不双扣。
 *
 * 守恒(RFC-014):refundBuyerU + toSellerU ≡ totalU(escrow 的纯再分配,按构造零印钱);
 *   undeliverableConserves 供测试 + 调用方运行期断言。
 * 调用方(PR-B3b settle 层)拿数字落库:applyWalletDelta(buyer,{escrowed:-total,balance:+refund}) +
 *   applyWalletDelta(seller,{balance:+toSeller});另退卖家 stake(无责,镜像 settleDeclinedNoFault)—— 不在本函数。
 */
import { mulRate, clamp, type Units } from './money.js'

/** restocking 硬帽(协议红线,独立于 protocol_params 的 max_value —— 结算层 defense-in-depth)。 */
export const RESTOCKING_HARD_CAP_RATE = 0.15
/** 退程运费占 total 比例的硬帽(param return_shipping_max_rate 的兜底上限,与其 max_value 一致)。 */
export const RETURN_SHIPPING_HARD_CAP_RATE = 0.30

export type UndeliverableMode = 'goods_returned' | 'seller_silent_default' | 'goods_lost_forfeit'

export interface UndeliverableRefundInput {
  mode: UndeliverableMode
  totalU: Units                  // 买家托管总额(整数 base-units,含去程运费)
  outboundShippingU: Units       // 去程运费快照(orders.shipping_fee;NULL/无模板旧单传 0)。已在 total 内,只扣一次。
  sellerDeclaredReturnU: Units   // 卖家申报的【实际退程运费】(goods_returned 模式;其它模式忽略)
  restockingFeeRate: number      // protocol_params restocking_fee_rate(默认 0.10;结算层仍 clamp 到 0.15 硬帽)
  returnShippingMaxRate: number  // protocol_params return_shipping_max_rate(默认 0.20;clamp 到 0.30 硬帽)
}

export interface UndeliverableRefundSplit {
  mode: UndeliverableMode
  refundBuyerU: Units      // 退买家(escrowed → balance)
  toSellerU: Units         // 归卖家(= totalU − refundBuyerU,residual 吸收取整 → 精确守恒)
  outboundU: Units         // 实扣去程(goods_returned 才扣;capped ≤ total)
  returnU: Units           // 实扣退程(capped)
  restockU: Units          // 实扣 restocking(capped ≤ price×0.15)
}

export function computeUndeliverableRefund(i: UndeliverableRefundInput): UndeliverableRefundSplit {
  // 入参防御:金额非负整数化;费率非有限值按 0(不因坏参放大扣款 —— 坏参只会让买家多退,fail-safe 偏买家)
  const totalU = Math.max(0, Math.floor(i.totalU))
  const nonNeg = (u: Units): Units => Math.max(0, Math.floor(Number.isFinite(u) ? u : 0))
  const safeRate = (r: number, hardCap: number): number => Number.isFinite(r) && r > 0 ? Math.min(r, hardCap) : 0

  if (i.mode === 'seller_silent_default') {
    // 卖家超时不确认收货 → 放弃一切成本扣除,全款退买家(护栏 B2 默认路径)
    return { mode: i.mode, refundBuyerU: totalU, toSellerU: 0, outboundU: 0, returnU: 0, restockU: 0 }
  }
  if (i.mode === 'goods_lost_forfeit') {
    // 仅仲裁裁定货丢/弃货可达:全额归卖家(货没了,买家违约方承担全损)
    return { mode: i.mode, refundBuyerU: 0, toSellerU: totalU, outboundU: 0, returnU: 0, restockU: 0 }
  }

  // ── goods_returned:成本扣除(护栏 A 全 clamp)──────────────────────────────────────
  const outboundU = clamp(nonNeg(i.outboundShippingU), 0, totalU)                              // 去程:已在 total 内,只扣一次
  const priceU = totalU - outboundU                                                            // 货价(不含运费)= restocking 基数
  const returnU = clamp(nonNeg(i.sellerDeclaredReturnU), 0,                                    // 退程:实际申报,帽 total×rate(双帽)
    mulRate(totalU, safeRate(i.returnShippingMaxRate, RETURN_SHIPPING_HARD_CAP_RATE)))
  const restockU = clamp(mulRate(priceU, safeRate(i.restockingFeeRate, RESTOCKING_HARD_CAP_RATE)), 0,
    mulRate(priceU, RESTOCKING_HARD_CAP_RATE))                                                 // restocking:基于 price,15% 硬帽
  const refundBuyerU = clamp(totalU - outboundU - returnU - restockU, 0, totalU)
  const toSellerU = totalU - refundBuyerU                                                      // residual → Σ ≡ total 精确守恒
  return { mode: i.mode, refundBuyerU, toSellerU, outboundU, returnU, restockU }
}

/** 守恒校验(供测试 + 调用方运行期断言):退买家 + 归卖家 ≡ total,且两侧非负。 */
export function undeliverableConserves(totalU: Units, s: UndeliverableRefundSplit): boolean {
  return s.refundBuyerU >= 0 && s.toSellerU >= 0 && s.refundBuyerU + s.toSellerU === Math.max(0, Math.floor(totalU))
}
