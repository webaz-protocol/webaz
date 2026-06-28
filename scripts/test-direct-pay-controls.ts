#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — LAUNCH CONTROLS SSOT 测试 (PR-4a)。
 * 验:evaluateDirectPayLaunchControls 默认 fail-closed + 五道门逐项拒(全局/地区/上限/base-bond/KYC)+ 全过放行;
 *   readDirectPayControlsConfig 默认全 fail-closed、参数解析正确;sellerKycSanctionsPassed fail-closed(needs clear, no flag)。
 * Usage: npm run test:direct-pay-controls
 */
import Database from 'better-sqlite3'

const { evaluateDirectPayLaunchControls, readDirectPayControlsConfig, sellerKycSanctionsPassed, DEFAULT_DIRECT_PAY_CONTROLS, DIRECT_PAY_CONTROL_PARAMS } =
  await import('../src/direct-pay-controls.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// all-pass baseline (production base-bond + KYC are hard invariants — no cfg flags for them)
const CFG = { enabled: true, region: 'SG', regionAllowlist: ['SG', 'MY'], perTxCapUnits: toUnits(100) }
const FACTS = { amountUnits: toUnits(50), productionBaseBondLocked: true, kycSanctionsPassed: true }

// ── 1. defaults fail-closed ──
ok('DEFAULT config is disabled', DEFAULT_DIRECT_PAY_CONTROLS.enabled === false)
ok('null cfg + null facts → DIRECT_PAY_DISABLED', evaluateDirectPayLaunchControls(null, null).error_code === 'DIRECT_PAY_DISABLED')
ok('enabled=false (default) → DIRECT_PAY_DISABLED even with passing facts', evaluateDirectPayLaunchControls({ ...CFG, enabled: false }, FACTS).error_code === 'DIRECT_PAY_DISABLED')

// ── 2. region gate ──
ok('enabled, empty allowlist → REGION_UNSUPPORTED', evaluateDirectPayLaunchControls({ ...CFG, regionAllowlist: [] }, FACTS).error_code === 'DIRECT_PAY_REGION_UNSUPPORTED')
ok('enabled, region not in allowlist → REGION_UNSUPPORTED', evaluateDirectPayLaunchControls({ ...CFG, region: 'US' }, FACTS).error_code === 'DIRECT_PAY_REGION_UNSUPPORTED')
ok('enabled, empty region → REGION_UNSUPPORTED', evaluateDirectPayLaunchControls({ ...CFG, region: '' }, FACTS).error_code === 'DIRECT_PAY_REGION_UNSUPPORTED')

// ── 3. per-tx cap ──
ok('cap unset (0) → CAP_EXCEEDED', evaluateDirectPayLaunchControls({ ...CFG, perTxCapUnits: 0 }, FACTS).error_code === 'DIRECT_PAY_CAP_EXCEEDED')
ok('amount > cap → CAP_EXCEEDED', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amountUnits: toUnits(101) }).error_code === 'DIRECT_PAY_CAP_EXCEEDED')
ok('amount <= 0 → CAP_EXCEEDED', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amountUnits: 0 }).error_code === 'DIRECT_PAY_CAP_EXCEEDED')
ok('fractional amount → CAP_EXCEEDED (not valid units)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amountUnits: 50.5 as any }).error_code === 'DIRECT_PAY_CAP_EXCEEDED')
ok('amount == cap → allowed (boundary)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amountUnits: toUnits(100) }).ok === true)

// ── 4. production base-bond (HARD INVARIANT — always enforced, no cfg flag can disable) ──
ok('no production base-bond → NOT_AVAILABLE', evaluateDirectPayLaunchControls(CFG, { ...FACTS, productionBaseBondLocked: false }).error_code === 'DIRECT_PAY_NOT_AVAILABLE')
ok('base-bond enforced even if a stray requireProductionBaseBond:false is passed (no bypass)', evaluateDirectPayLaunchControls({ ...CFG, requireProductionBaseBond: false } as any, { ...FACTS, productionBaseBondLocked: false }).error_code === 'DIRECT_PAY_NOT_AVAILABLE')

// ── 5. KYC/sanctions (HARD INVARIANT — always enforced, no cfg flag can disable) ──
ok('no KYC/sanctions → KYC_REQUIRED', evaluateDirectPayLaunchControls(CFG, { ...FACTS, kycSanctionsPassed: false }).error_code === 'DIRECT_PAY_KYC_REQUIRED')
ok('KYC enforced even if a stray requireKycSanctions:false is passed (no bypass)', evaluateDirectPayLaunchControls({ ...CFG, requireKycSanctions: false } as any, { ...FACTS, kycSanctionsPassed: false }).error_code === 'DIRECT_PAY_KYC_REQUIRED')

// ── 6. all conditions pass ──
const okd = evaluateDirectPayLaunchControls(CFG, FACTS)
ok('all conditions pass → ok, status 200, no error_code', okd.ok === true && okd.status === 200 && okd.error_code === undefined, JSON.stringify(okd))
// short-circuit order: missing everything → first gate (DISABLED), not a later one
ok('short-circuits at the first failing gate (global before region)', evaluateDirectPayLaunchControls({ ...CFG, enabled: false, regionAllowlist: [] }, FACTS).error_code === 'DIRECT_PAY_DISABLED')

// ── 7. readDirectPayControlsConfig: defaults fail-closed + parsing ──
const cfgDefault = readDirectPayControlsConfig(<T,>(_k: string, fb: T): T => fb)
ok('loader default: disabled', cfgDefault.enabled === false)
ok('loader default: empty allowlist', cfgDefault.regionAllowlist.length === 0)
ok('loader default: cap 0', cfgDefault.perTxCapUnits === 0)
ok('loader config has NO require* fields (hard invariants not config-driven)', !('requireProductionBaseBond' in cfgDefault) && !('requireKycSanctions' in cfgDefault))
const params: Record<string, unknown> = { 'direct_pay.enabled': true, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG, MY ,', 'direct_pay.per_tx_cap_units': toUnits(50) }
const cfgSet = readDirectPayControlsConfig(<T,>(k: string, fb: T): T => (k in params ? params[k] as T : fb))
ok('loader parses enabled/region/allowlist(csv trim+drop empties)/cap', cfgSet.enabled === true && cfgSet.region === 'SG' && JSON.stringify(cfgSet.regionAllowlist) === JSON.stringify(['SG', 'MY']) && cfgSet.perTxCapUnits === toUnits(50), JSON.stringify(cfgSet))

// ── 8. sellerKycSanctionsPassed (fail-closed; needs explicit clear, no flag/block) ──
const db = new Database(':memory:')
db.exec("CREATE TABLE sanctions_screening (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'clear', source TEXT, reason TEXT, screened_at TEXT, created_at TEXT)")
ok('no screening row → false (fail-closed)', sellerKycSanctionsPassed(db, 's1') === false)
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc1','s1','clear')").run()
ok('clear row → true', sellerKycSanctionsPassed(db, 's1') === true)
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc2','s1','flagged')").run()
ok('clear + flagged → false (any flag/block fails-closed)', sellerKycSanctionsPassed(db, 's1') === false)
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc3','s2','blocked')").run()
ok('only blocked → false', sellerKycSanctionsPassed(db, 's2') === false)

// ── 9. seed list (DIRECT_PAY_CONTROL_PARAMS) — boot 必 seed 这 6 个 key,默认仍全部 fail-closed ──
// server.ts 把它展开进 DEFAULT_PARAMS(boot seed + admin PATCH 依赖 key 存在);此处守 key 齐全 + 默认全关。
const seedByKey = Object.fromEntries(DIRECT_PAY_CONTROL_PARAMS.map(p => [p.key, p]))
const EXPECTED: Record<string, string> = {
  'direct_pay.enabled': 'false',
  'direct_pay.region': '',
  'direct_pay.region_allowlist': '',
  'direct_pay.per_tx_cap_units': '0',
}
for (const [k, v] of Object.entries(EXPECTED)) {
  ok(`seed list has ${k} (fail-closed default '${v}')`, !!seedByKey[k] && seedByKey[k].value === v, JSON.stringify(seedByKey[k]))
}
ok('seed list has exactly the 4 operational control keys', DIRECT_PAY_CONTROL_PARAMS.length === 4)
// hard invariants must NOT be governance params (no operator soft-bypass of launch blockers)
ok('require_production_base_bond NOT a param (hard invariant)', !seedByKey['direct_pay.require_production_base_bond'])
ok('require_kyc_sanctions NOT a param (hard invariant)', !seedByKey['direct_pay.require_kyc_sanctions'])
// 用 seed 默认构造 getProtocolParam(按 type 强转,模拟 server.getProtocolParam)→ readConfig → evaluate 必须全关
const seedGet = <T,>(key: string, fb: T): T => {
  const p = seedByKey[key]; if (!p) return fb
  if (p.type === 'number') return Number(p.value) as unknown as T
  if (p.type === 'boolean') return (p.value === 'true' || p.value === '1') as unknown as T
  return p.value as unknown as T
}
const cfgFromSeed = readDirectPayControlsConfig(seedGet)
ok('seeded defaults → readConfig disabled + cap 0 + empty allowlist', cfgFromSeed.enabled === false && cfgFromSeed.perTxCapUnits === 0 && cfgFromSeed.regionAllowlist.length === 0)
ok('seeded defaults → evaluate DIRECT_PAY_DISABLED (gate stays closed end-to-end)', evaluateDirectPayLaunchControls(cfgFromSeed, FACTS).error_code === 'DIRECT_PAY_DISABLED')

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-controls tests passed`)
