// RFC-014 PR4 — settleOrder 资金拆分纯函数守恒护栏(server.ts settleOrder 真调用 computeSettlementSplit)。
import { toUnits } from '../src/money.js'
import { computeSettlementSplit, settlementConserves, type SettlementInput } from '../src/settlement-math.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// 对抗:除不尽 total + 奇费率 + 各种 logistics/stake 组合
const cases: Array<Partial<SettlementInput> & { total: number }> = [
  { total: 33.33,  feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: true,  commissionRate: 0.10, fundRate: 0.01, stakeToLockU: 0 },
  { total: 99.99,  feeRate: 0.01, logisticsRate: 0.05, chargeLogistics: false, commissionRate: 0.07, fundRate: 0.01, stakeToLockU: 0 },
  { total: 100.01, feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: true,  commissionRate: 0.13, fundRate: 0.01, stakeToLockU: toUnits(7.77) },
  { total: 7.77,   feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: true,  commissionRate: 0.10, fundRate: 0.01, stakeToLockU: 0 },
  { total: 1234.56, feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: true, commissionRate: 0.0725, fundRate: 0.01, stakeToLockU: toUnits(50) },
  { total: 0.03,   feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: true,  commissionRate: 0.10, fundRate: 0.01, stakeToLockU: 0 },
]

let allConserve = true, allInt = true
for (const c of cases) {
  const totalU = toUnits(c.total)
  const split = computeSettlementSplit({
    totalU, feeRate: c.feeRate!, logisticsRate: c.logisticsRate!, chargeLogistics: c.chargeLogistics!,
    commissionRate: c.commissionRate!, fundRate: c.fundRate!, stakeToLockU: c.stakeToLockU!,
  })
  if (!settlementConserves(totalU, split)) { allConserve = false; console.log('  ✗ 不守恒', JSON.stringify({ c, split })) }
  if (Object.values(split).some(v => !Number.isInteger(v))) allInt = false
  // 协议费 50/50 两半之差 ≤ 1 base-unit(allocate 性质)
  if (Math.abs(split.protocolToReserveU - split.protocolToOpsU) > 1) { allConserve = false; console.log('  ✗ 协议费拆分偏差 >1', JSON.stringify(split)) }
}
expect('★ 拆分精确守恒 Σ(协议费+物流+佣金+基金+stake+卖家净额) ≡ total(全对抗场景)', allConserve)
expect('★ 所有拆分项都是整数 base-units(零 dust)', allInt)

// 退化:total=0 → 全 0
const z = computeSettlementSplit({ totalU: 0, feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: true, commissionRate: 0.1, fundRate: 0.01, stakeToLockU: 0 })
expect('total=0 → 卖家净额 0 且守恒', z.sellerAmountU === 0 && settlementConserves(0, z))

// self-fulfill(不收物流费)→ 物流实扣 0,卖家净额含原物流份额
const sf = computeSettlementSplit({ totalU: toUnits(100), feeRate: 0.02, logisticsRate: 0.05, chargeLogistics: false, commissionRate: 0.1, fundRate: 0.01, stakeToLockU: 0 })
expect('self-fulfill:logisticsActual=0 + 守恒', sf.logisticsActualU === 0 && settlementConserves(toUnits(100), sf))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
