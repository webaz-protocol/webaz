#!/usr/bin/env tsx
/**
 * money.ts — focused unit tests for the RFC-014 integer base-unit arithmetic (dogfood R2 Case-2 work
 * product: test-only; the functions under test are unchanged; deterministic; no DB / no network).
 *   用法:npm run test:money-units
 *
 * Why: src/money.ts is the protocol's ONLY money arithmetic surface (every settle/commission/dispute path
 * funnels through it) yet had no direct unit test. The crown jewel is allocate() — the largest-remainder
 * splitter whose conservation invariant (Σ parts === total, no dust, no mint/burn) underwrites RFC-014.
 */
import { MONEY_SCALE, toUnits, toDecimal, format, add, sub, sum, mulQty, mulRate, clamp, allocate } from '../src/money.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

function main(): void {
  // ── toUnits / toDecimal ──────────────────────────────────────────────────────────────────────────────
  ok('toUnits(1) = 1e6', toUnits(1) === MONEY_SCALE)
  ok('toUnits("33.33") exact', toUnits('33.33') === 33_330_000)
  ok('toUnits rounds to nearest unit (half up)', toUnits(0.0000005) === 1 && toUnits(0.0000004) === 0)
  ok('toUnits negative ok', toUnits(-2.5) === -2_500_000)
  ok('toUnits non-finite throws', throws(() => toUnits(NaN)) && throws(() => toUnits('abc')) && throws(() => toUnits(Infinity)))
  ok('toUnits beyond MAX_SAFE throws', throws(() => toUnits(1e16)))
  ok('toDecimal roundtrip', toDecimal(toUnits('123.456789')) === 123.456789)
  ok('toDecimal non-integer units throws', throws(() => toDecimal(1.5)))

  // ── format (integer-arithmetic display; never float toFixed) ────────────────────────────────────────
  ok("format(1_234_999, 2) = '1.23' (rounds at the dp grain)", format(1_234_999) === '1.23')
  ok("format(1_235_000, 2) = '1.24' (half up at grain)", format(1_235_000) === '1.24')
  ok("format(-1_500_000) = '-1.50'", format(-1_500_000) === '-1.50')
  ok("format(2_000_000, 0) = '2'", format(2_000_000, 0) === '2')
  ok("format pads fraction ('0.05')", format(50_000) === '0.05')

  // ── add / sub / sum guards ──────────────────────────────────────────────────────────────────────────
  ok('add/sub/sum basic', add(1, 2) === 3 && sub(5, 7) === -2 && sum([1, 2, 3, 4]) === 10)
  ok('add overflow beyond MAX_SAFE throws', throws(() => add(Number.MAX_SAFE_INTEGER, 1)))
  ok('add non-integer throws', throws(() => add(1.5 as never, 1)))
  ok('sum([]) = 0', sum([]) === 0)

  // ── mulQty / mulRate / clamp ────────────────────────────────────────────────────────────────────────
  ok('mulQty exact', mulQty(toUnits('9.99'), 3) === 29_970_000)
  ok('mulQty rejects fractional / negative qty', throws(() => mulQty(100, 1.5)) && throws(() => mulQty(100, -1)))
  ok('mulRate single rounding (33.33 @ 7% = 2.3331 exactly)', mulRate(toUnits('33.33'), 0.07) === 2_333_100)
  ok('mulRate rounds once to nearest unit', mulRate(3, 0.5) === 2)   // 1.5 → round half up → 2, single rounding
  ok('mulRate rejects negative / non-finite rate', throws(() => mulRate(100, -0.1)) && throws(() => mulRate(100, NaN)))
  ok('clamp [0, cap]', clamp(-5) === 0 && clamp(7, 0, 5) === 5 && clamp(3, 0, 5) === 3)

  // ── allocate — conservation + determinism (the RFC-014 zero-dust invariant) ─────────────────────────
  // largest-remainder: total=100, weights [1,1,1] → raw 33.33… each, equal fracs → tie by index → [34,33,33]
  ok('allocate equal weights, tie → lowest index first', JSON.stringify(allocate(100, [1, 1, 1])) === '[34,33,33]')
  // frac ordering: [1,2] of 100 → raw 33.33/66.67 → larger frac (.67) gets the remainder → [33,67]
  ok('allocate remainder goes to the largest fraction', JSON.stringify(allocate(100, [1, 2])) === '[33,67]')
  ok('allocate single weight → [total]', JSON.stringify(allocate(12_345, [5])) === '[12345]')
  ok('allocate zero total → zeros', JSON.stringify(allocate(0, [3, 1])) === '[0,0]')
  ok('allocate all-zero weights → all-zero buckets (caller routes total)', JSON.stringify(allocate(999, [0, 0, 0])) === '[0,0,0]')
  ok('allocate zero-weight bucket gets nothing', JSON.stringify(allocate(10, [1, 0, 1])) === '[5,0,5]')
  ok('allocate negative weight throws', throws(() => allocate(100, [1, -1])))
  ok('allocate non-integer total throws', throws(() => allocate(100.5, [1, 1])))

  // conservation sweep — deterministic grid of awkward totals × weight sets: Σ === total, every bucket ≥ 0,
  // and no bucket exceeds total. These are the shapes that used to leave float dust pre-RFC-014.
  const totals = [1, 7, 99, 100, 101, 33_330_000, 1_000_001, 9_999_999, 123_456_789]
  const weightSets = [[1], [1, 1], [1, 2], [7, 2, 1], [70, 20, 10], [1, 1, 1], [3, 3, 3, 1], [0.07, 0.02, 0.01], [5, 0, 5], [1, 999]]
  let sweep = 0, sweepBad = ''
  for (const t of totals) for (const w of weightSets) {
    const parts = allocate(t, w)
    const s = parts.reduce((a, b) => a + b, 0)
    if (s !== t || parts.some(p => p < 0 || p > t) || parts.length !== w.length) { sweepBad = `total=${t} w=[${w}] → [${parts}] (Σ=${s})`; break }
    sweep++
  }
  ok(`allocate conservation sweep: ${totals.length}×${weightSets.length} cases all Σ === total`, sweep === totals.length * weightSets.length, sweepBad)
  // determinism: same inputs → identical output across calls
  ok('allocate deterministic across calls', JSON.stringify(allocate(1_000_001, [7, 2, 1])) === JSON.stringify(allocate(1_000_001, [7, 2, 1])))
  // the canonical RFC-014 motivating case: 33.33 WAZ split 7:2:1 conserves exactly
  const split = allocate(toUnits('33.33'), [7, 2, 1])
  ok('33.33 WAZ @ 7:2:1 conserves exactly', split.reduce((a, b) => a + b, 0) === 33_330_000, JSON.stringify(split))

  if (fail === 0) {
    console.log(`\n✅ money units: toUnits/toDecimal roundtrip + guards · integer-arithmetic format · add/sub/sum overflow guards · mulQty/mulRate single-rounding · clamp · allocate largest-remainder (tie→index, frac ordering, zero/zero-weight edges, ${totals.length * weightSets.length}-case conservation sweep Σ===total, determinism)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ money units FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
