#!/usr/bin/env tsx
/**
 * PR-B3a:computeUndeliverableRefund 纯函数 —— 守恒 + 护栏 A clamp + 三模式(护栏 B2)回归。
 * 自检锚:D5(方案 b 成本扣除,禁全额没收)· 护栏 A(restocking 15% 硬帽 + 退程帽 + 去程不双扣)·
 *   护栏 B2(卖家确认→成本扣除;卖家超时→默认退全款;货丢=仅仲裁模式)· 守恒 refund+seller≡total 零印钱。
 * Usage: npm run test:undeliverable-refund
 */
import { computeUndeliverableRefund, undeliverableConserves, RESTOCKING_HARD_CAP_RATE, RETURN_SHIPPING_HARD_CAP_RATE } from '../src/undeliverable-refund.js'
import { toUnits, mulRate } from '../src/money.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const T = toUnits(100)   // total 100(含去程 8)
const OUT = toUnits(8)   // 去程运费快照
const base = { totalU: T, outboundShippingU: OUT, sellerDeclaredReturnU: toUnits(7), restockingFeeRate: 0.10, returnShippingMaxRate: 0.20 }

// ── ① goods_returned:成本扣除 + 守恒 ──
{
  const s = computeUndeliverableRefund({ ...base, mode: 'goods_returned' })
  const price = T - OUT
  ok('1. 守恒:refund + seller ≡ total', undeliverableConserves(T, s), JSON.stringify(s))
  ok('2. 去程只扣一次(=快照 8)', s.outboundU === OUT)
  ok('3. 退程=实际申报 7(未触帽)', s.returnU === toUnits(7))
  ok('4. restocking = price×10%(基于不含运费的 price)', s.restockU === mulRate(price, 0.10), `restock=${s.restockU} expect=${mulRate(price, 0.10)}`)
  ok('5. refund = 100−8−7−9.2 = 75.8(字面值,非自引用重算)', s.refundBuyerU === toUnits(75.8), `refund=${s.refundBuyerU}`)
  ok('6. seller = 24.2(字面值;不牟利:只回收成本)', s.toSellerU === toUnits(24.2), `seller=${s.toSellerU}`)
}
// ── ② 护栏 A:restocking 15% 硬帽 —— param 被改高也绝不超 ──
{
  const s = computeUndeliverableRefund({ ...base, mode: 'goods_returned', restockingFeeRate: 0.50 })   // 恶意/异常 50%
  const price = T - OUT
  ok('7. restocking clamp 到 15% 硬帽(param 50% 无效)', s.restockU === mulRate(price, RESTOCKING_HARD_CAP_RATE), `restock=${s.restockU}`)
  ok('8. 硬帽下仍守恒', undeliverableConserves(T, s))
  const sNaN = computeUndeliverableRefund({ ...base, mode: 'goods_returned', restockingFeeRate: NaN })
  ok('9. 费率 NaN → restocking=0(坏参 fail-safe 偏买家,不放大扣款)', sNaN.restockU === 0)
}
// ── ③ 护栏 A:退程申报灌水 → 双锚 clamp(去程锚 + param 帽 + 0.30 硬帽兜底)——堵不牟利漏洞(审计 F1)──
{
  const s = computeUndeliverableRefund({ ...base, mode: 'goods_returned', sellerDeclaredReturnU: toUnits(90) })   // 申报 90(灌水),去程 8
  ok('10. 有去程快照 → 退程 clamp 到去程实价 8(同路线对称锚,非 total×20%=20)', s.returnU === OUT, `return=${s.returnU}`)
  ok('10b. 反获利:seller ≤ 去程+去程锚退程+15%price(成本量级,无利润空间)', s.toSellerU <= OUT + OUT + mulRate(T - OUT, 0.15), `seller=${s.toSellerU}`)
  const s2 = computeUndeliverableRefund({ ...base, mode: 'goods_returned', outboundShippingU: 0, sellerDeclaredReturnU: toUnits(90), returnShippingMaxRate: 0.99 })
  ok('11. 无去程快照(旧单)+ param 0.99 超硬帽 → clamp 到 total×0.30 兜底', s2.returnU === mulRate(T, RETURN_SHIPPING_HARD_CAP_RATE), `return=${s2.returnU}`)
  ok('12. 灌水极值下 refund 仍 ≥ 0 且守恒', s2.refundBuyerU >= 0 && undeliverableConserves(T, s2))
}
// ── ④ 护栏 B2:seller_silent_default → 全款退买家(放弃扣除)──
{
  const s = computeUndeliverableRefund({ ...base, mode: 'seller_silent_default', sellerDeclaredReturnU: toUnits(90), restockingFeeRate: 0.50 })
  ok('13. 卖家超时不确认 → refund=total 全款、seller=0、零扣除', s.refundBuyerU === T && s.toSellerU === 0 && s.outboundU === 0 && s.returnU === 0 && s.restockU === 0)
  ok('14. 默认模式守恒', undeliverableConserves(T, s))
}
// ── ⑤ 护栏 B2:goods_lost_forfeit(仅仲裁)→ 全额归卖家 ──
{
  const s = computeUndeliverableRefund({ ...base, mode: 'goods_lost_forfeit' })
  ok('15. 货丢没收:refund=0、seller=total', s.refundBuyerU === 0 && s.toSellerU === T)
  ok('16. 没收模式守恒', undeliverableConserves(T, s))
  // 钱路 fail-loud:未知 mode 绝不静默走成本扣除(审计 F2)
  let threw = false
  try { computeUndeliverableRefund({ ...base, mode: 'partial_return' as never }) } catch { threw = true }
  ok('16b. 未知 mode → 抛错(不静默扣款)', threw)
}
// ── ⑥ 边界:去程>total、负数/NaN 入参、零 total、无运费旧单 ──
{
  const s = computeUndeliverableRefund({ ...base, mode: 'goods_returned', outboundShippingU: toUnits(999) })   // 坏快照:去程>total
  ok('17. 去程 clamp ≤ total → price=0 → restocking=0,refund≥0 守恒', s.outboundU === T && s.restockU === 0 && s.refundBuyerU >= 0 && undeliverableConserves(T, s), JSON.stringify(s))
  const sNeg = computeUndeliverableRefund({ ...base, mode: 'goods_returned', outboundShippingU: -5, sellerDeclaredReturnU: NaN })
  ok('18. 负数/NaN 金额入参 → 按 0(不透支买家)', sNeg.outboundU === 0 && sNeg.returnU === 0 && undeliverableConserves(T, sNeg))
  const sZero = computeUndeliverableRefund({ ...base, mode: 'goods_returned', totalU: 0 })
  ok('19. total=0 → 全零守恒', sZero.refundBuyerU === 0 && sZero.toSellerU === 0 && undeliverableConserves(0, sZero))
  const sNoShip = computeUndeliverableRefund({ ...base, mode: 'goods_returned', outboundShippingU: 0 })   // 无模板旧单 shipping_fee NULL→0
  ok('20. 无去程快照(旧单)→ restocking 基数=全 total,仍守恒', sNoShip.restockU === mulRate(T, 0.10) && undeliverableConserves(T, sNoShip))
}
// ── ⑦ fuzz:随机 500 组 —— 用【独立 oracle】(纯 Math 重算,不引用被测输出/clamp 链)对拍(审计 F3:
//    旧 fuzz 三断言全是同构重算=恒真,double-deduct 之类的 bug 抓不到)+ 模式不变量 + 单调性 ──
{
  let bad = 0
  let seed = 42
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }   // 确定性 LCG(勿用 Math.random,可复现)
  for (let k = 0; k < 500; k++) {
    const totalU = Math.floor(rnd() * 10_000_000_000)
    const input = {
      totalU,
      outboundShippingU: Math.floor(rnd() * totalU * 1.2),
      sellerDeclaredReturnU: Math.floor(rnd() * totalU * 1.5),
      restockingFeeRate: rnd() * 0.6,
      returnShippingMaxRate: rnd() * 0.6,
    }
    // 独立 oracle:从原始输入用纯 Math 重算期望值(与实现不共享代码路径)
    const eOut = Math.min(Math.max(0, Math.floor(input.outboundShippingU)), totalU)
    const ePrice = totalU - eOut
    const rr = input.returnShippingMaxRate > 0 ? Math.min(input.returnShippingMaxRate, 0.30) : 0
    const eParamCap = Math.round(totalU * rr)
    const eCap = eOut > 0 ? Math.min(eParamCap, eOut) : eParamCap
    const eRet = Math.min(Math.max(0, Math.floor(input.sellerDeclaredReturnU)), eCap)
    const sr = input.restockingFeeRate > 0 ? Math.min(input.restockingFeeRate, 0.15) : 0
    const eRest = Math.min(Math.round(ePrice * sr), Math.round(ePrice * 0.15))
    const eRefund = Math.min(Math.max(totalU - eOut - eRet - eRest, 0), totalU)
    const g = computeUndeliverableRefund({ ...input, mode: 'goods_returned' })
    if (g.refundBuyerU !== eRefund || g.toSellerU !== totalU - eRefund) { bad++; if (bad === 1) fails.push(`oracle 对拍失败: ${JSON.stringify({ input, g, eRefund })}`) }
    // 模式不变量:silent 恒全款退买家;forfeit 恒全归卖家(旧 fuzz 对这两模式零覆盖)
    const sl = computeUndeliverableRefund({ ...input, mode: 'seller_silent_default' })
    if (sl.refundBuyerU !== totalU || sl.toSellerU !== 0) bad++
    const ff = computeUndeliverableRefund({ ...input, mode: 'goods_lost_forfeit' })
    if (ff.refundBuyerU !== 0 || ff.toSellerU !== totalU) bad++
    // 单调性:退程申报越多,买家退款只减不增
    const gMore = computeUndeliverableRefund({ ...input, mode: 'goods_returned', sellerDeclaredReturnU: input.sellerDeclaredReturnU + 1_000_000 })
    if (gMore.refundBuyerU > g.refundBuyerU) bad++
  }
  ok('21. fuzz 500:独立 oracle 对拍 + silent/forfeit 模式不变量 + 退程单调性,零违例', bad === 0, `bad=${bad}`)
}

if (fail > 0) { console.error(`\n❌ undeliverable-refund FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ undeliverable-refund (PR-B3a): ${pass} pass — 三模式守恒 + 护栏 A(15% 硬帽/退程帽/去程不双扣)+ B2 默认退全款 + 边界/fuzz`)
