// RFC-014 PR1 — src/money.ts 基础模块单测。重点:allocate 精确守恒(消灭 dust)+ mulRate + 往返。
import { MONEY_SCALE, toUnits, toDecimal, format, add, sub, sum, mulQty, mulRate, clamp, allocate } from '../src/money.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// 往返
expect('toUnits 12.5 → 12500000', toUnits(12.5) === 12_500_000)
expect('toUnits 字符串 "0.01" → 10000', toUnits('0.01') === 10_000)
expect('toDecimal 往返', toDecimal(toUnits(33.33)) === 33.33)
expect('toUnits 四舍五入到最近 unit', toUnits(0.0000004) === 0 && toUnits(0.0000006) === 1)

// format(整数运算,不靠 float toFixed)
expect('format 默认 2 位', format(toUnits(1407.4)) === '1407.40')
expect('format 0', format(0) === '0.00')
expect('format 负数', format(toUnits(-3.33)) === '-3.33')
expect('format dp=0', format(toUnits(99.99), 0) === '100')
expect('format 6 位无损', format(toUnits(1.234567), 6) === '1.234567')

// add/sub/sum 精确
expect('add 精确', add(toUnits(0.1), toUnits(0.2)) === toUnits(0.3))   // float 经典坑:0.1+0.2≠0.3,整数则精确
expect('sum 多项精确', sum([toUnits(0.1), toUnits(0.2), toUnits(0.3)]) === toUnits(0.6))
expect('sub 精确', sub(toUnits(1), toUnits(0.9)) === toUnits(0.1))

// mulQty / mulRate
expect('mulQty', mulQty(toUnits(12.5), 3) === toUnits(37.5))
expect('mulRate 7% 单次舍入到整数 unit', mulRate(toUnits(33.33), 0.07) === Math.round(33.33 * 0.07 * MONEY_SCALE))
expect('mulRate 结果是整数 unit', Number.isInteger(mulRate(toUnits(1234.56), 0.0725)))

// clamp
expect('clamp 防负', clamp(toUnits(-5)) === 0)
expect('clamp 上限', clamp(toUnits(100), 0, toUnits(50)) === toUnits(50))

// ★ allocate —— 精确守恒(dust 杀手)。对抗:除不尽的总额 + 奇数权重。
const advCases: Array<{ total: number; weights: number[] }> = [
  { total: 33.33, weights: [2, 50, 100] },
  { total: 99.99, weights: [1, 1, 1] },          // 三等分除不尽
  { total: 100.01, weights: [7, 0, 10] },         // 含 0 权重
  { total: 7.77, weights: [1, 1, 1, 1, 1, 1, 1] },
  { total: 1234.56, weights: [0.0725, 0.5, 0.4275] }, // 小数权重
  { total: 0.01, weights: [1, 1, 1] },            // 1 cent 分三份
]
let allocOk = true, dustOk = true
for (const c of advCases) {
  const total = toUnits(c.total)
  const buckets = allocate(total, c.weights)
  const s = buckets.reduce((a, b) => a + b, 0)
  if (s !== total) { allocOk = false; console.log('  ✗ allocate 不守恒', JSON.stringify({ c, total, buckets, s })) }
  if (buckets.some(b => !Number.isInteger(b))) { dustOk = false }
}
expect('★ allocate 精确守恒 Σ===total(全对抗场景,残差0)', allocOk)
expect('★ allocate 输出全整数 base-units(零 dust)', dustOk)
expect('allocate 全 0 权重 → 全 0 桶', allocate(toUnits(10), [0, 0]).every(x => x === 0))
expect('allocate 单桶 = 全额', allocate(toUnits(42.42), [1])[0] === toUnits(42.42))

// 守恒大样本:随机额 × 随机权重,Σ 必等 total
let randOk = true
for (let k = 0; k < 5000; k++) {
  const total = Math.floor(Math.random() * 5_000_000_000)   // 0..5000 WAZ 的 units
  const w = [Math.random(), Math.random(), Math.random(), Math.random()]
  const b = allocate(total, w)
  if (b.reduce((a, x) => a + x, 0) !== total) { randOk = false; break }
}
expect('★ allocate 5000 随机样本全部精确守恒', randOk)

// 安全边界
let threw = false
try { toUnits(1e12) } catch { threw = true }   // 1e12 WAZ = 1e18 units > 2^53 → 应抛
expect('超安全整数范围抛错', threw)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
