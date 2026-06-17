/**
 * Money — 协议资金的【唯一】算术面(RFC-014 option A:整数最小单位)。
 *
 * 背景:此前金额用 JS float(SQLite REAL + number + Math.round(x*100)/100),除不尽的金额
 *   (33.33 @ 7% 等)会在【个体钱包】留浮点尘(staked=3.3299999999983)。聚合守恒安全(残差0,
 *   靠 residual-absorption),但接真实 USDC(整数 base-unit)对账时会变成真裂缝。诊断见
 *   tests/test-money-precision-adversarial.ts。
 *
 * 表示:1 WAZ = 1,000,000 base-units(6 位小数,与 USDC base-units 对齐 → 链上对账 1:1)。
 *   全部算术在【整数 base-units】上做(精确),只在显示层转回 2 位小数。
 *   类型用 number 整数(安全到 ±2^53 ≈ 9.007e9 WAZ,模拟币足够);链上 USDC 边界 viem 已用 BigInt。
 *
 * 守恒利器:allocate() 用最大余数法把总额拆成整数桶且【精确求和 = 总额】——从源头消灭 dust,
 *   且天然守恒(不增发/不丢)。mulRate() 单次舍入到整数单位。
 *
 * 用法(RFC-014 港口策略):资金热路径(engine.settle* / orders / 佣金 / dispute / skill …)
 *   一律 toUnits 进 → 在 units 上 add/sub/mulRate/allocate → toUnits 出存库;显示层用 format。
 *   全部港口完成后 schema 改 INTEGER(PR6),届时 toUnits/toDecimal 退化为存取边界。
 */

export const MONEY_SCALE = 1_000_000           // 1 WAZ = 1e6 base-units(6 dp,USDC 对齐)
export type Units = number                     // 整数 base-units;安全到 ±Number.MAX_SAFE_INTEGER

const MAX_SAFE = Number.MAX_SAFE_INTEGER       // 2^53 - 1 ≈ 9.007e15 units ≈ 9.007e9 WAZ

function assertUnits(u: number, ctx: string): void {
  if (!Number.isFinite(u) || !Number.isInteger(u)) throw new Error(`money[${ctx}]: 非整数 units: ${u}`)
  if (Math.abs(u) > MAX_SAFE) throw new Error(`money[${ctx}]: units 超出安全整数范围: ${u}`)
}

/** 十进制 WAZ(number/string)→ 整数 base-units(四舍五入到最近 unit)。存量 REAL 价格的入口。 */
export function toUnits(decimal: number | string): Units {
  const n = typeof decimal === 'string' ? Number(decimal) : decimal
  if (!Number.isFinite(n)) throw new Error(`money.toUnits: 非有限数: ${decimal}`)
  const u = Math.round(n * MONEY_SCALE)
  assertUnits(u, 'toUnits')
  return u
}

/** 整数 base-units → 十进制 number(兼容/显示边界;返回 float,仅用于显示或与遗留 REAL 字段衔接)。 */
export function toDecimal(units: Units): number {
  assertUnits(units, 'toDecimal')
  return units / MONEY_SCALE
}

/** 整数 base-units → 定点字符串(默认 2 位,WAZ 展示)。整数运算舍入,不靠 float toFixed。 */
export function format(units: Units, dp = 2): string {
  assertUnits(units, 'format')
  const neg = units < 0
  let abs = Math.abs(units)
  const grain = Math.round(MONEY_SCALE / 10 ** dp)        // dp=2 → 1e4 units 为一格
  abs = Math.round(abs / grain) * grain                    // 舍入到 dp 粒度(整数运算)
  const whole = Math.floor(abs / MONEY_SCALE)
  const fracUnits = abs - whole * MONEY_SCALE
  const fracStr = dp > 0 ? '.' + String(Math.floor(fracUnits / grain)).padStart(dp, '0') : ''
  return (neg ? '-' : '') + String(whole) + fracStr
}

export function add(a: Units, b: Units): Units { const r = a + b; assertUnits(r, 'add'); return r }
export function sub(a: Units, b: Units): Units { const r = a - b; assertUnits(r, 'sub'); return r }
export function sum(xs: Units[]): Units { return xs.reduce<Units>((acc, x) => add(acc, x), 0) }

/** 单价 × 整数数量(精确)。 */
export function mulQty(unit: Units, qty: number): Units {
  if (!Number.isInteger(qty) || qty < 0) throw new Error(`money.mulQty: qty 非非负整数: ${qty}`)
  const r = unit * qty; assertUnits(r, 'mulQty'); return r
}

/** 金额 × 费率(rate 如 0.07);结果【单次】舍入到整数 base-units。守恒由 allocate 负责,勿用多次 mulRate 凑总额。 */
export function mulRate(amount: Units, rate: number): Units {
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`money.mulRate: rate 非法: ${rate}`)
  assertUnits(amount, 'mulRate')
  const r = Math.round(amount * rate); assertUnits(r, 'mulRate'); return r
}

/** clamp 到 [0, cap](cap 省略=只防负)。用于"不超过余额/不超过原佣金"等上限。 */
export function clamp(units: Units, lo: Units = 0, hi: Units = MAX_SAFE): Units {
  assertUnits(units, 'clamp'); return Math.max(lo, Math.min(hi, units))
}

/**
 * 把 total 按整数权重拆成 N 桶,【精确求和 = total】(最大余数法)。
 *   - 守恒:Σ 输出 === total,无 dust、不增发/不丢。
 *   - 余数(floor 后差额)按小数部分从大到小逐 1 派发(确定性、稳定)。
 *   - 全 0 权重 → 全 0 桶(调用方决定 total 的去向,通常落 reserve)。
 * 用于佣金/罚没/分润等"一笔总额分给多方"的场景,替代逐项 round 造成的不守恒。
 */
export function allocate(total: Units, weights: number[]): Units[] {
  assertUnits(total, 'allocate')
  if (weights.some(w => !Number.isFinite(w) || w < 0)) throw new Error(`money.allocate: 权重含负/非法`)
  const W = weights.reduce((a, b) => a + b, 0)
  if (W <= 0) return weights.map(() => 0)
  const raw = weights.map(w => (total * w) / W)
  const floor = raw.map(Math.floor)
  const used = floor.reduce((a, b) => a + b, 0)
  let remainder = total - used                                  // 整数,0..N-1(total≥0 时)
  const out = floor.slice()
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) out[order[k].i] += 1
  // total 为负数的极端情况(理论上不该发生)兜底:把残余补到最后一桶,守恒优先
  if (remainder !== 0) out[out.length - 1] += remainder
  out.forEach((u, i) => assertUnits(u, `allocate[${i}]`))
  return out
}
