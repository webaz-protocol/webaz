#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — LAUNCH CONTROLS SSOT 测试 (PR-4a)。
 * 验:evaluateDirectPayLaunchControls 默认 fail-closed + 五道门逐项拒(全局/地区/上限/base-bond/KYC)+ 全过放行;
 *   readDirectPayControlsConfig 默认全 fail-closed、参数解析正确;sellerKycSanctionsPassed fail-closed(needs clear, no flag)。
 * Usage: npm run test:direct-pay-controls
 */
import Database from 'better-sqlite3'

const { evaluateDirectPayLaunchControls, readDirectPayControlsConfig, sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear, DEFAULT_DIRECT_PAY_CONTROLS, DIRECT_PAY_CONTROL_PARAMS } =
  await import('../src/direct-pay-controls.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// all-pass baseline (production base-bond + KYC are hard invariants — no cfg flags for them)
const CFG = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG', 'MY'], perTxCapUnits: toUnits(100) }
const FACTS = { amountUnits: toUnits(50), sellerBreakerTripped: false, productionBaseBondLocked: true, kycSanctionsPassed: true, amlClear: true }

// ── 1. defaults fail-closed ──
ok('DEFAULT config is disabled', DEFAULT_DIRECT_PAY_CONTROLS.enabled === false)
ok('DEFAULT config rail breaker not tripped (false) + cap 0', DEFAULT_DIRECT_PAY_CONTROLS.railBreakerTripped === false && DEFAULT_DIRECT_PAY_CONTROLS.perTxCapUnits === 0)
ok('null cfg + null facts → DIRECT_PAY_DISABLED', evaluateDirectPayLaunchControls(null, null).error_code === 'DIRECT_PAY_DISABLED')
ok('enabled=false (default) → DIRECT_PAY_DISABLED even with passing facts', evaluateDirectPayLaunchControls({ ...CFG, enabled: false }, FACTS).error_code === 'DIRECT_PAY_DISABLED')

// ── 1b. rail breaker (ops emergency stop; separate from enabled) ──
ok('enabled but rail breaker tripped → DIRECT_PAY_RAIL_BREAKER', evaluateDirectPayLaunchControls({ ...CFG, railBreakerTripped: true }, FACTS).error_code === 'DIRECT_PAY_RAIL_BREAKER')
ok('rail breaker checked AFTER global (enabled=false + breaker tripped → DISABLED first)', evaluateDirectPayLaunchControls({ ...CFG, enabled: false, railBreakerTripped: true }, FACTS).error_code === 'DIRECT_PAY_DISABLED')

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

// ── 3b. seller breaker (per-seller; fact, checked after cap, before invariants) ──
ok('sellerBreakerTripped → DIRECT_PAY_SELLER_SUSPENDED', evaluateDirectPayLaunchControls(CFG, { ...FACTS, sellerBreakerTripped: true }).error_code === 'DIRECT_PAY_SELLER_SUSPENDED')
ok('cap checked BEFORE seller breaker (over-cap + seller tripped → CAP_EXCEEDED first)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amountUnits: toUnits(101), sellerBreakerTripped: true }).error_code === 'DIRECT_PAY_CAP_EXCEEDED')
ok('seller breaker checked BEFORE base-bond invariant (seller tripped + no bond → SELLER_SUSPENDED first)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, sellerBreakerTripped: true, productionBaseBondLocked: false }).error_code === 'DIRECT_PAY_SELLER_SUSPENDED')

// ── 4. production base-bond (HARD INVARIANT — always enforced, no cfg flag can disable) ──
ok('no production base-bond → NOT_AVAILABLE', evaluateDirectPayLaunchControls(CFG, { ...FACTS, productionBaseBondLocked: false }).error_code === 'DIRECT_PAY_NOT_AVAILABLE')
ok('base-bond enforced even if a stray requireProductionBaseBond:false is passed (no bypass)', evaluateDirectPayLaunchControls({ ...CFG, requireProductionBaseBond: false } as any, { ...FACTS, productionBaseBondLocked: false }).error_code === 'DIRECT_PAY_NOT_AVAILABLE')

// ── 5. KYC/sanctions (HARD INVARIANT — always enforced, no cfg flag can disable) ──
ok('no KYC/sanctions → KYC_REQUIRED', evaluateDirectPayLaunchControls(CFG, { ...FACTS, kycSanctionsPassed: false }).error_code === 'DIRECT_PAY_KYC_REQUIRED')
ok('KYC enforced even if a stray requireKycSanctions:false is passed (no bypass)', evaluateDirectPayLaunchControls({ ...CFG, requireKycSanctions: false } as any, { ...FACTS, kycSanctionsPassed: false }).error_code === 'DIRECT_PAY_KYC_REQUIRED')

// ── 5b. AML runtime breaker (HARD INVARIANT — PR-6B; separate fact from kycSanctionsPassed) ──
ok('amlClear=false → AML_REVIEW_REQUIRED', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amlClear: false }).error_code === 'DIRECT_PAY_AML_REVIEW_REQUIRED')
ok('amlClear missing (undefined) → AML_REVIEW_REQUIRED (fail-closed)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, amlClear: undefined as any }).error_code === 'DIRECT_PAY_AML_REVIEW_REQUIRED')
// AML enforced even if a stray cfg flag is passed (no governance bypass of the invariant)
ok('AML enforced even with stray requireAmlClear:false cfg (no bypass)', evaluateDirectPayLaunchControls({ ...CFG, requireAmlClear: false } as any, { ...FACTS, amlClear: false }).error_code === 'DIRECT_PAY_AML_REVIEW_REQUIRED')
// order: KYC checked BEFORE AML (both invariants; KYC fails first when both fail)
ok('KYC checked BEFORE AML (no KYC + AML blocked → KYC_REQUIRED first)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, kycSanctionsPassed: false, amlClear: false }).error_code === 'DIRECT_PAY_KYC_REQUIRED')
// order: base-bond checked BEFORE AML
ok('base-bond checked BEFORE AML (no bond + AML blocked → NOT_AVAILABLE first)', evaluateDirectPayLaunchControls(CFG, { ...FACTS, productionBaseBondLocked: false, amlClear: false }).error_code === 'DIRECT_PAY_NOT_AVAILABLE')

// ── 6. all conditions pass ──
const okd = evaluateDirectPayLaunchControls(CFG, FACTS)
ok('all conditions pass → ok, status 200, no error_code', okd.ok === true && okd.status === 200 && okd.error_code === undefined, JSON.stringify(okd))
// short-circuit order: missing everything → first gate (DISABLED), not a later one
ok('short-circuits at the first failing gate (global before region)', evaluateDirectPayLaunchControls({ ...CFG, enabled: false, regionAllowlist: [] }, FACTS).error_code === 'DIRECT_PAY_DISABLED')

// ── 7. readDirectPayControlsConfig: defaults fail-closed + parsing ──
const cfgDefault = readDirectPayControlsConfig(<T,>(_k: string, fb: T): T => fb)
ok('loader default: disabled', cfgDefault.enabled === false)
ok('loader default: empty allowlist', cfgDefault.regionAllowlist.length === 0)
ok('loader default: cap 0 (fallback fail-closed when row missing)', cfgDefault.perTxCapUnits === 0)
ok('loader default: rail breaker not tripped (false)', cfgDefault.railBreakerTripped === false)
ok('loader config has NO require* fields (hard invariants not config-driven)', !('requireProductionBaseBond' in cfgDefault) && !('requireKycSanctions' in cfgDefault))
const params: Record<string, unknown> = { 'direct_pay.enabled': true, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG, MY ,', 'direct_pay.per_tx_cap_units': toUnits(50) }
const cfgSet = readDirectPayControlsConfig(<T,>(k: string, fb: T): T => (k in params ? params[k] as T : fb))
ok('loader parses enabled/region/allowlist(csv trim+drop empties)/cap', cfgSet.enabled === true && cfgSet.region === 'SG' && JSON.stringify(cfgSet.regionAllowlist) === JSON.stringify(['SG', 'MY']) && cfgSet.perTxCapUnits === toUnits(50), JSON.stringify(cfgSet))

// ── 8. PR-6A AML/KYB fail-closed readers (sanctions + KYB, with expiry) ──
const db = new Database(':memory:')
db.exec("CREATE TABLE sanctions_screening (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'clear', source TEXT, reason TEXT, screened_at TEXT, created_at TEXT, expires_at TEXT)")
db.exec("CREATE TABLE direct_receive_kyb_reviews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, expires_at TEXT, reason TEXT, created_at TEXT, updated_at TEXT)")
const PAST = "datetime('now','-1 day')", FUT = "datetime('now','+1 day')"
// sanctions clear reader
ok('sanctions: no row → false (fail-closed)', sellerDirectPaySanctionsClear(db, 's1') === false)
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc1','s1','clear')").run()
ok('sanctions: clear (no expiry) → true', sellerDirectPaySanctionsClear(db, 's1') === true)
db.prepare(`INSERT INTO sanctions_screening (id, user_id, status, expires_at) VALUES ('scx','s3','clear',${PAST})`).run()
ok('sanctions: clear but EXPIRED → false', sellerDirectPaySanctionsClear(db, 's3') === false)
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc2','s1','flagged')").run()
ok('sanctions: clear + flagged → false (any flag/block fails-closed)', sellerDirectPaySanctionsClear(db, 's1') === false)
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc3','s2','blocked')").run()
ok('sanctions: only blocked → false', sellerDirectPaySanctionsClear(db, 's2') === false)
// KYB reader
ok('kyb: no review → false (fail-closed)', sellerDirectPayKybPassed(db, 'k1') === false)
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kr1','k1','pending')").run()
ok('kyb: pending → false', sellerDirectPayKybPassed(db, 'k1') === false)
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kr2','k2','rejected')").run()
ok('kyb: rejected → false', sellerDirectPayKybPassed(db, 'k2') === false)
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kr3','k3','approved')").run()
ok('kyb: approved (no expiry) → true', sellerDirectPayKybPassed(db, 'k3') === true)
db.prepare(`INSERT INTO direct_receive_kyb_reviews (id, user_id, status, expires_at) VALUES ('kr4','k4','approved',${PAST})`).run()
ok('kyb: approved but EXPIRED → false', sellerDirectPayKybPassed(db, 'k4') === false)
db.prepare(`INSERT INTO direct_receive_kyb_reviews (id, user_id, status, expires_at) VALUES ('kr5','k5','approved',${FUT})`).run()
ok('kyb: approved + not-expired → true', sellerDirectPayKybPassed(db, 'k5') === true)
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kr6','k5','revoked')").run()
ok('kyb: approved then REVOKED → false (revocation blocks)', sellerDirectPayKybPassed(db, 'k5') === false)

// ── 8b. PR-6B AML runtime breaker reader (aml_flags; key=subject_user_id; fail-closed) ──
db.exec("CREATE TABLE aml_flags (id TEXT PRIMARY KEY, subject_user_id TEXT NOT NULL, related_order_id TEXT, rule TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'low', detail TEXT, status TEXT NOT NULL DEFAULT 'open', disposition TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT)")
let afn = 0
const aflag = (sub: string, severity: string, status: string, disposition: string | null = null): void => {
  db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status, disposition) VALUES (?,?,?,?,?,?)").run('af' + (++afn), sub, 'velocity', severity, status, disposition)
}
ok('aml: no flag → clear (true)', sellerDirectPayAmlClear(db, 'a_none') === true)
aflag('a_clearedhigh', 'high', 'cleared'); ok('aml: cleared high → clear (resolved, not blocking)', sellerDirectPayAmlClear(db, 'a_clearedhigh') === true)
aflag('a_lowopen', 'low', 'open'); ok('aml: low open (non-suspend) → clear', sellerDirectPayAmlClear(db, 'a_lowopen') === true)
aflag('a_lowdown', 'low', 'open', 'downgrade'); ok('aml: low + downgrade → clear (only suspend blocks via disposition)', sellerDirectPayAmlClear(db, 'a_lowdown') === true)
aflag('a_openmed', 'medium', 'open'); ok('aml: open medium → block', sellerDirectPayAmlClear(db, 'a_openmed') === false)
aflag('a_openhigh', 'high', 'open'); ok('aml: open high → block', sellerDirectPayAmlClear(db, 'a_openhigh') === false)
aflag('a_revmed', 'medium', 'reviewing'); ok('aml: reviewing medium → block', sellerDirectPayAmlClear(db, 'a_revmed') === false)
aflag('a_revhigh', 'high', 'reviewing'); ok('aml: reviewing high → block', sellerDirectPayAmlClear(db, 'a_revhigh') === false)
aflag('a_escmed', 'medium', 'escalated'); ok('aml: escalated medium → block', sellerDirectPayAmlClear(db, 'a_escmed') === false)
aflag('a_strhigh', 'high', 'str_filed'); ok('aml: str_filed high → block', sellerDirectPayAmlClear(db, 'a_strhigh') === false)
aflag('a_susplow', 'low', 'open', 'suspend'); ok('aml: disposition=suspend (low/open) → block (suspend overrides low severity)', sellerDirectPayAmlClear(db, 'a_susplow') === false)
aflag('a_clrsusp', 'high', 'cleared', 'suspend'); ok('aml: cleared + suspend → block (suspend wins over cleared, fail-closed)', sellerDirectPayAmlClear(db, 'a_clrsusp') === false)
aflag('a_badsev', 'critical', 'open'); ok('aml: malformed severity → block (fail-closed)', sellerDirectPayAmlClear(db, 'a_badsev') === false)
aflag('a_badstat', 'high', 'weird'); ok('aml: malformed status → block (fail-closed)', sellerDirectPayAmlClear(db, 'a_badstat') === false)
aflag('a_baddisp', 'low', 'open', 'frobnicate'); ok('aml: malformed disposition → block (fail-closed)', sellerDirectPayAmlClear(db, 'a_baddisp') === false)
aflag('a_multi', 'low', 'cleared'); aflag('a_multi', 'high', 'open'); ok('aml: any blocking flag among several → block', sellerDirectPayAmlClear(db, 'a_multi') === false)

// ── 9. seed list (DIRECT_PAY_CONTROL_PARAMS) — boot 必 seed 这 6 个 key,默认仍全部 fail-closed ──
// server.ts 把它展开进 DEFAULT_PARAMS(boot seed + admin PATCH 依赖 key 存在);此处守 key 齐全 + 默认全关。
const seedByKey = Object.fromEntries(DIRECT_PAY_CONTROL_PARAMS.map(p => [p.key, p]))
// fail-closed defaults: enabled off, rail breaker off, region/allowlist empty, cap 0 (no pass-through).
// The cap is a ceiling on the WebAZ-recorded order total; its concrete value (e.g. SG v1 policy units) is set later
// by a separate launch-policy PR — 5a only adds the capability and keeps the default fail-closed.
const EXPECTED: Record<string, string> = {
  'direct_pay.enabled': 'false',
  'direct_pay.rail_breaker_tripped': 'false',
  'direct_pay.region': '',
  'direct_pay.region_allowlist': '',
  'direct_pay.per_tx_cap_units': '0',
}
for (const [k, v] of Object.entries(EXPECTED)) {
  ok(`seed list has ${k} (default '${v}')`, !!seedByKey[k] && seedByKey[k].value === v, JSON.stringify(seedByKey[k]))
}
ok('seed list has exactly the 5 operational control keys', DIRECT_PAY_CONTROL_PARAMS.length === 5)
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
ok('seeded defaults → readConfig disabled + rail breaker false + cap 0 + empty allowlist', cfgFromSeed.enabled === false && cfgFromSeed.railBreakerTripped === false && cfgFromSeed.perTxCapUnits === 0 && cfgFromSeed.regionAllowlist.length === 0)
ok('seeded defaults → evaluate DIRECT_PAY_DISABLED (gate closed end-to-end)', evaluateDirectPayLaunchControls(cfgFromSeed, FACTS).error_code === 'DIRECT_PAY_DISABLED')

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-controls tests passed`)
