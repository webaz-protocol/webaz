#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) direct-receive ELIGIBILITY 纯谓词测试 (PR-4a)。
 * 验:四项入门门 AND、逐项失败 reason、**fail-closed**(缺失/坏值绝不放行)、账龄边界、bond 边界 + never-0、
 *    base-units 整数不变量、制裁是 hard requirement、config 可调、account-age 助手。
 * (DB config loader 已移至 PR-4c — 本模块保持纯,无 DB。)
 * Usage: npm run test:direct-pay-eligibility
 */
import {
  evaluateDirectReceiveEligibility, accountAgeDays,
  DEFAULT_DIRECT_RECEIVE_ELIGIBILITY,
} from '../src/direct-pay-eligibility.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const arrEq = (a: string[], b: string[]) => a.length === b.length && a.slice().sort().join(',') === b.slice().sort().join(',')

// 满足全部入门门的基准事实(T0:bond locked == required == 500 units)
const PASS = { kycVerified: true, sanctionsCleared: true, accountAgeDays: 30, baseBondLockedUnits: 500, requiredBaseBondUnits: 500 }

// ── 1. 全过 ──
const v0 = evaluateDirectReceiveEligibility(PASS)
ok('all gates met → eligible', v0.eligible === true, JSON.stringify(v0))
ok('all gates met → no reasons', v0.reasons.length === 0)
ok('all gates met → all checks true', v0.checks.kyc && v0.checks.sanctions && v0.checks.accountAge && v0.checks.baseBond)

// ── 2. 逐项失败 ──
let v = evaluateDirectReceiveEligibility({ ...PASS, kycVerified: false })
ok('kyc false → not eligible + KYC_NOT_VERIFIED', !v.eligible && arrEq(v.reasons, ['KYC_NOT_VERIFIED']) && v.checks.kyc === false, JSON.stringify(v))
v = evaluateDirectReceiveEligibility({ ...PASS, sanctionsCleared: false })
ok('sanctions false → SANCTIONS_NOT_CLEARED (hard requirement)', !v.eligible && arrEq(v.reasons, ['SANCTIONS_NOT_CLEARED']), JSON.stringify(v))
v = evaluateDirectReceiveEligibility({ ...PASS, accountAgeDays: 29 })
ok('age 29 (<30) → ACCOUNT_TOO_NEW', !v.eligible && arrEq(v.reasons, ['ACCOUNT_TOO_NEW']), JSON.stringify(v))
v = evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: 499 })
ok('bond 499 (<500) → BASE_BOND_INSUFFICIENT', !v.eligible && arrEq(v.reasons, ['BASE_BOND_INSUFFICIENT']), JSON.stringify(v))

// ── 3. 边界 ──
ok('age exactly 30 → passes (>=)', evaluateDirectReceiveEligibility({ ...PASS, accountAgeDays: 30 }).checks.accountAge === true)
ok('bond exactly == required → passes (>=)', evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: 500, requiredBaseBondUnits: 500 }).checks.baseBond === true)
ok('bond over required → passes', evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: 600 }).checks.baseBond === true)

// ── 4. FAIL-CLOSED:缺失/坏值绝不放行 ──
let z = evaluateDirectReceiveEligibility({})
ok('empty facts → not eligible + all 4 reasons', !z.eligible && z.reasons.length === 4, JSON.stringify(z))
z = evaluateDirectReceiveEligibility(null)
ok('null facts → not eligible (no throw)', !z.eligible && z.reasons.length === 4)
z = evaluateDirectReceiveEligibility(undefined)
ok('undefined facts → not eligible (no throw)', !z.eligible && z.reasons.length === 4)
z = evaluateDirectReceiveEligibility({ kycVerified: true, sanctionsCleared: true, accountAgeDays: NaN, baseBondLockedUnits: NaN, requiredBaseBondUnits: 500 })
ok('NaN age/bond → ACCOUNT_TOO_NEW + BASE_BOND_INSUFFICIENT', arrEq(z.reasons, ['ACCOUNT_TOO_NEW', 'BASE_BOND_INSUFFICIENT']), JSON.stringify(z))
// 防 truthy 误放行:kyc 用非布尔真值不算过
z = evaluateDirectReceiveEligibility({ ...PASS, kycVerified: 1 as unknown as boolean })
ok('kyc=1 (truthy non-bool) → still NOT verified (must be === true)', z.checks.kyc === false)
z = evaluateDirectReceiveEligibility({ ...PASS, accountAgeDays: -5 })
ok('negative age → ACCOUNT_TOO_NEW', z.checks.accountAge === false)

// ── 5. never-0 bond 不变量:required<=0 → 永不放行(即使 locked 也 0/正)──
ok('required=0 → BASE_BOND_INSUFFICIENT (always some bond)', evaluateDirectReceiveEligibility({ ...PASS, requiredBaseBondUnits: 0, baseBondLockedUnits: 0 }).checks.baseBond === false)
ok('required negative → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ ...PASS, requiredBaseBondUnits: -1 }).checks.baseBond === false)
ok('required missing → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ kycVerified: true, sanctionsCleared: true, accountAgeDays: 30, baseBondLockedUnits: 500 }).checks.baseBond === false)
// base-units 整数不变量:分数/非安全整数 units 不是合法 base-units → fail-closed(对齐 money.ts assertUnits)
ok('fractional required (500.5) → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ ...PASS, requiredBaseBondUnits: 500.5, baseBondLockedUnits: 500.5 }).checks.baseBond === false)
ok('fractional locked (500.5) vs int required 500 → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: 500.5, requiredBaseBondUnits: 500 }).checks.baseBond === false)
ok('int locked 501 vs fractional required 500.5 → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: 501, requiredBaseBondUnits: 500.5 }).checks.baseBond === false)
ok('non-safe-integer units → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: Number.MAX_SAFE_INTEGER + 2, requiredBaseBondUnits: 500 }).checks.baseBond === false)
ok('Infinity units → BASE_BOND_INSUFFICIENT', evaluateDirectReceiveEligibility({ ...PASS, baseBondLockedUnits: Infinity, requiredBaseBondUnits: 500 }).checks.baseBond === false)

// ── 6. 多项同时失败 → 列全 ──
z = evaluateDirectReceiveEligibility({ kycVerified: false, sanctionsCleared: false, accountAgeDays: 10, baseBondLockedUnits: 0, requiredBaseBondUnits: 500 })
ok('all four failing → 4 reasons listed', arrEq(z.reasons, ['KYC_NOT_VERIFIED', 'SANCTIONS_NOT_CLEARED', 'ACCOUNT_TOO_NEW', 'BASE_BOND_INSUFFICIENT']), JSON.stringify(z))

// ── 7. config 可调(治理收紧账龄)──
ok('config min 60: age 30 → too new', evaluateDirectReceiveEligibility({ ...PASS, accountAgeDays: 30 }, { minAccountAgeDays: 60 }).checks.accountAge === false)
ok('config min 60: age 60 → passes', evaluateDirectReceiveEligibility({ ...PASS, accountAgeDays: 60 }, { minAccountAgeDays: 60 }).checks.accountAge === true)
ok('bad config → falls back to default 30', evaluateDirectReceiveEligibility({ ...PASS, accountAgeDays: 30 }, { minAccountAgeDays: NaN as unknown as number }).checks.accountAge === true)
ok('default exported = 30', DEFAULT_DIRECT_RECEIVE_ELIGIBILITY.minAccountAgeDays === 30)

// ── 8. accountAgeDays 助手 ──
ok('age helper: 31d ago → 31', accountAgeDays('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z') === 31)
ok('age helper: same instant → 0', accountAgeDays('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z') === 0)
ok('age helper: future created → 0 (fail-closed)', accountAgeDays('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z') === 0)
ok('age helper: null → 0', accountAgeDays(null, '2026-01-01T00:00:00Z') === 0)
ok('age helper: garbage → 0', accountAgeDays('not-a-date', '2026-01-01T00:00:00Z') === 0)
ok('age helper: exactly 30d → 30', accountAgeDays('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z') === 30)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-eligibility tests passed`)
