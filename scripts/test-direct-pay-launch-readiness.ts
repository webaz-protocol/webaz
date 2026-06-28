#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — PHASE 7A launch readiness surface 测试。
 * 验:默认 main / fresh DB → ready=false;各类 blocker(enabled/cap/region/rail breaker/seller suspended/no
 *   production base-bond/KYB/sanctions/AML)都能返回;#112 rail-clearance blockers 被并入;readiness 纯只读
 *   (不写 deposits / production_receipt / 不激活 privileges);即便普通 controls 看似可用,只要 production base-bond /
 *   rail clearance / KYB-sanctions-AML 不满足仍 ready=false。
 * Usage: npm run test:direct-pay-launch-readiness
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-readiness-'))

const { readDirectPayLaunchReadiness, sellerDirectPayReadinessView } = await import('../src/direct-pay-launch-readiness.js')
const { requestDeferral, approveDeferral } = await import('../src/direct-receive-deferral.js')
const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
for (const u of ['seller1', 'seller2', 'seller3']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)

// getProtocolParam over a mutable params object
let cp: Record<string, unknown> = {}
const gp = <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
const has = (r: { blockers: string[] }, code: string): boolean => r.blockers.includes(code)

// ══════ 1. default fresh DB / empty config → ready=false with global + rail blockers ══════
cp = {}
const r1 = readDirectPayLaunchReadiness(db, { getProtocolParam: gp })
ok('1. default → ready=false', r1.ready === false)
ok('1a. NOT_ENABLED', has(r1, 'DIRECT_PAY_NOT_ENABLED'))
ok('1b. REGION_NOT_ALLOWED', has(r1, 'DIRECT_PAY_REGION_NOT_ALLOWED'))
ok('1c. PER_TX_CAP_UNSET', has(r1, 'DIRECT_PAY_PER_TX_CAP_UNSET'))
ok('1d. NO_LEGAL_CLEARED_PRODUCTION_RAIL', has(r1, 'DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL'))
// 1e. operator_attested 是【已实现】生产轨(#116) → "无实现 rail"(RAIL_IMPLEMENTATION_GATED)不再是上线 blocker;
//   真正的 blocker 是"无 legal-cleared rail"(1d)。usdc/fiat 虽仍 gated,但只要有一条 rail 已实现,该项就不成立(intersection 语义)。
ok('1e. RAIL_IMPLEMENTATION_GATED NOT a launch blocker (operator_attested IS implemented)', !has(r1, 'DIRECT_PAY_RAIL_IMPLEMENTATION_GATED'))
ok('1f. RAIL_POLICY_VERSION_UNSET (#112)', has(r1, 'DIRECT_PAY_RAIL_POLICY_VERSION_UNSET'))
ok('1g. RAIL_JURISDICTION_ALLOWLIST_EMPTY (#112)', has(r1, 'DIRECT_PAY_RAIL_JURISDICTION_ALLOWLIST_EMPTY'))
ok('1h. anyRailLegalCleared=false', r1.facts.anyRailLegalCleared === false)
ok('1i. readiness enumerates operator_attested too (not just usdc/fiat)', !!r1.facts.perRailClearance['operator_attested'] && r1.facts.perRailClearance['usdc_onchain'].includes('NO_LEGAL_CLEARED_RAIL') && r1.facts.perRailClearance['fiat_psp'].includes('POLICY_VERSION_UNSET'))
ok('1i2. operator_attested perRail: NO_LEGAL_CLEARED_RAIL but NOT RAIL_IMPLEMENTATION_GATED (implemented, just unregistered)', r1.facts.perRailClearance['operator_attested'].includes('NO_LEGAL_CLEARED_RAIL') && !r1.facts.perRailClearance['operator_attested'].includes('RAIL_IMPLEMENTATION_GATED'))
// no sellerId → seller facts null, no seller blockers
ok('1j. no sellerId → seller facts null, no seller blockers', r1.facts.sellerEvaluated === false && r1.facts.productionBaseBondLocked === null && !has(r1, 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND'))

// ══════ 2. rail breaker tripped surfaces ══════
cp = { 'direct_pay.rail_breaker_tripped': true }
ok('2. RAIL_BREAKER_TRIPPED surfaces', has(readDirectPayLaunchReadiness(db, { getProtocolParam: gp }), 'DIRECT_PAY_RAIL_BREAKER_TRIPPED'))

// ══════ 3. seller-specific blockers (no seller data) ══════
cp = {}
const r3 = readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller1' })
ok('3. sellerEvaluated=true', r3.facts.sellerEvaluated === true)
ok('3a. SELLER_NO_PRODUCTION_BASE_BOND', has(r3, 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND'))
ok('3b. SELLER_KYB_NOT_APPROVED', has(r3, 'DIRECT_PAY_SELLER_KYB_NOT_APPROVED'))
ok('3c. SELLER_SANCTIONS_NOT_CLEARED', has(r3, 'DIRECT_PAY_SELLER_SANCTIONS_NOT_CLEARED'))
// no AML flags → AML clear → no AML blocker; not suspended → no suspend blocker
ok('3d. no AML flags → no AML blocker; not suspended → no suspend blocker', !has(r3, 'DIRECT_PAY_SELLER_AML_REVIEW_REQUIRED') && !has(r3, 'DIRECT_PAY_SELLER_SUSPENDED'))
// no active payment instruction → PAYMENT_INSTRUCTION_MISSING (mirrors real create's NO_PAYMENT_INSTRUCTION gate)
ok('3e. no active instruction → PAYMENT_INSTRUCTION_MISSING + fact false', has(r3, 'DIRECT_PAY_SELLER_PAYMENT_INSTRUCTION_MISSING') && r3.facts.paymentInstructionPresent === false)

// ══════ 4. AML breaker + suspension surface when present ══════
db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status) VALUES ('afr','seller2','structuring','high','open')").run()
ok('4. AML open/high → SELLER_AML_REVIEW_REQUIRED', has(readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller2' }), 'DIRECT_PAY_SELLER_AML_REVIEW_REQUIRED'))
db.prepare("INSERT INTO direct_receive_privileges (user_id, status, tier) VALUES ('seller3','suspended','T0') ON CONFLICT(user_id) DO UPDATE SET status='suspended'").run()
ok('4b. suspended privilege → SELLER_SUSPENDED', has(readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller3' }), 'DIRECT_PAY_SELLER_SUSPENDED'))

// ══════ 5. controls fully "open" + KYB/sanctions/AML cleared for seller → STILL ready=false ══════
// (production base-bond + rail clearance can't be satisfied on main → never ready)
cp = { 'direct_pay.enabled': true, 'direct_pay.rail_breaker_tripped': false, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG', 'direct_pay.per_tx_cap_units': toUnits(1000) }
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kyb_s1','seller1','approved')").run()
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc_s1','seller1','clear')").run()
const r5 = readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller1' })
ok('5. controls open + KYB/sanctions cleared → global control blockers gone', !has(r5, 'DIRECT_PAY_NOT_ENABLED') && !has(r5, 'DIRECT_PAY_REGION_NOT_ALLOWED') && !has(r5, 'DIRECT_PAY_PER_TX_CAP_UNSET') && !has(r5, 'DIRECT_PAY_SELLER_KYB_NOT_APPROVED') && !has(r5, 'DIRECT_PAY_SELLER_SANCTIONS_NOT_CLEARED'))
ok('5a. STILL ready=false (production bond + rail clearance unmet)', r5.ready === false)
ok('5b. remaining blockers include SELLER_NO_PRODUCTION_BASE_BOND + NO_LEGAL_CLEARED_PRODUCTION_RAIL', has(r5, 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND') && has(r5, 'DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL'))
// still no active instruction → instruction blocker present
ok('5c. no instruction yet → PAYMENT_INSTRUCTION_MISSING present', has(r5, 'DIRECT_PAY_SELLER_PAYMENT_INSTRUCTION_MISSING'))
// seed an active payment instruction → that blocker clears (but bond/rail keep ready=false)
db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES ('pi_s1','seller1','PayNow +65 9xxx (off-protocol)','PayNow','active')").run()
const r5b = readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller1' })
ok('5d. after seeding active instruction → blocker gone, fact true', !has(r5b, 'DIRECT_PAY_SELLER_PAYMENT_INSTRUCTION_MISSING') && r5b.facts.paymentInstructionPresent === true)
ok('5e. STILL ready=false (bond + rail clearance remain)', r5b.ready === false && has(r5b, 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND') && has(r5b, 'DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL'))
// jurisdiction-aware: even with a concrete region (SG) configured, no rail is legal-cleared FOR THAT region → still not cleared
ok('5f. jurisdiction-aware: region=SG configured but anyRailLegalCleared=false + NO_LEGAL_CLEARED_PRODUCTION_RAIL', r5b.facts.anyRailLegalCleared === false && has(r5b, 'DIRECT_PAY_NO_LEGAL_CLEARED_PRODUCTION_RAIL'))

// ══════ 6. read-only: readiness writes NOTHING ══════
const snap = () => ({
  deposits: (db.prepare("SELECT COUNT(*) n FROM direct_receive_deposits").get() as any).n,
  prodReceipts: (db.prepare("SELECT COUNT(*) n FROM direct_receive_deposits WHERE production_receipt_confirmed_at IS NOT NULL").get() as any).n,
  activePrivs: (db.prepare("SELECT COUNT(*) n FROM direct_receive_privileges WHERE status='active'").get() as any).n,
  amlFlags: (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n,
  kyb: (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews").get() as any).n,
  instructions: (db.prepare("SELECT COUNT(*) n FROM direct_receive_payment_instructions").get() as any).n,
})
const before = snap()
for (let i = 0; i < 5; i++) { readDirectPayLaunchReadiness(db, { getProtocolParam: gp }); readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller1' }) }
const after = snap()
ok('6. readiness is READ-ONLY: deposits/prodReceipts/activePrivs/amlFlags/kyb all unchanged', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`)
ok('6a. zero production receipts ever (sellerHasProductionBaseBondLocked can never be true on main)', after.prodReceipts === 0)

// ══════ 7. contract: rail-clearance decision MUST be jurisdiction-aware (regression guard) ══════
// Prevent silently reverting the cleared/anyRailLegalCleared decision back to the coarse
// bondRailClearanceBlockers(...).length===0 (which ignores cfg.region vs the rail's legal allowlist).
const src = readFileSync(new URL('../src/direct-pay-launch-readiness.ts', import.meta.url), 'utf8')
ok('7. readiness imports the jurisdiction-aware isBondRailClearedForProduction', /import\s*\{[^}]*\bisBondRailClearedForProduction\b[^}]*\}\s*from\s*'\.\/direct-pay-bond-rail-clearance\.js'/.test(src))
ok('7a. anyRailLegalCleared derived via isBondRailClearedForProduction(rid, cfg.region)', /isBondRailClearedForProduction\s*\(\s*rid\s*,\s*cfg\.region\s*\)/.test(src))
ok('7b. cleared decision does NOT use coarse perRailClearance length for anyRailLegalCleared', !/anyRailLegalCleared\s*=\s*[^\n]*perRailClearance\[[^\]]*\]\.length\s*===\s*0/.test(src))

// ══════ 8. sellerDirectPayReadinessView — DE-IDENTIFIED seller self view ══════
db.exec("CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)")
// seller1 from test 5 has KYB approved + sanctions clear + active instruction (no AML flag) → compliance+instruction ok; bond/platform not.
const sv = sellerDirectPayReadinessView(db, { getProtocolParam: gp, sellerId: 'seller1' })
const svJson = JSON.stringify(sv)
ok('8. seller view shape { directPayReady, items[] }', typeof sv.directPayReady === 'boolean' && Array.isArray(sv.items))
ok('8a. directPayReady=false on main', sv.directPayReady === false)
ok('8b. NO raw launch blocker codes leaked', !/DIRECT_PAY_(NOT_ENABLED|RAIL_|REGION_NOT|PER_TX|NO_LEGAL|SELLER_KYB|SELLER_SANCTIONS|SELLER_AML|SELLER_NO_PRODUCTION|SELLER_SUSPENDED|SELLER_PAYMENT)/.test(svJson))
ok('8c. NO KYB/sanctions/AML/KYC terms leaked to seller', !/KYB|SANCTION|AML|KYC/i.test(svJson))
ok('8d. only the 6 de-id codes present', sv.items.every((i: any) => ['PLATFORM_OPEN', 'PAYMENT_INSTRUCTION', 'PASSKEY', 'BASE_BOND', 'COMPLIANCE_REVIEW', 'NOT_SUSPENDED'].includes(i.code)))
ok('8e. compliance collapsed to ONE COMPLIANCE_REVIEW item', sv.items.filter((i: any) => i.code === 'COMPLIANCE_REVIEW').length === 1)
const item = (c: string): any => sv.items.find((i: any) => i.code === c)
ok('8f. PAYMENT_INSTRUCTION ok (seeded) + actionable', item('PAYMENT_INSTRUCTION').ok === true && item('PAYMENT_INSTRUCTION').actionable === true)
ok('8g. COMPLIANCE_REVIEW ok (KYB+sanctions seeded, no AML flag) — collapsed, not actionable', item('COMPLIANCE_REVIEW').ok === true && item('COMPLIANCE_REVIEW').actionable === false)
ok('8h. BASE_BOND not ok (gated on main)', item('BASE_BOND').ok === false)
ok('8i. PLATFORM_OPEN not ok (rail clearance gated)', item('PLATFORM_OPEN').ok === false)
ok('8j. PASSKEY not ok (no credential seeded)', item('PASSKEY').ok === false && item('PASSKEY').actionable === true)
// a flagged seller: AML flag must NOT surface as AML — only collapses COMPLIANCE_REVIEW to not-ok
db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status) VALUES ('af_sv','seller1','structuring','high','open')").run()
const sv2 = sellerDirectPayReadinessView(db, { getProtocolParam: gp, sellerId: 'seller1' })
ok('8k. AML flag → COMPLIANCE_REVIEW not-ok, still NO AML term leaked', sv2.items.find((i: any) => i.code === 'COMPLIANCE_REVIEW').ok === false && !/AML|SANCTION|KYB/i.test(JSON.stringify(sv2)))
// read-only
const svBefore = snap()
for (let i = 0; i < 3; i++) sellerDirectPayReadinessView(db, { getProtocolParam: gp, sellerId: 'seller1' })
ok('8l. seller view is read-only', JSON.stringify(snap()) === JSON.stringify(svBefore))

// ══════ 9. P1 fix: readiness mirrors the create gate — active 缓交 satisfies base-bond (no false NO_PRODUCTION_BASE_BOND) ══════
// seller_dfr: no production bond, but an active granted deferral → base-bond门 satisfied, just like the real create gate.
const nowIso = new Date().toISOString()
requestDeferral(db, { deferralId: 'dfr_rdy', userId: 'seller_dfr', periodDays: 30, nowIso })
approveDeferral(db, { deferralId: 'dfr_rdy', adminId: 'admin1', nowIso })
const rDfr = readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller_dfr' })
ok('9. active 缓交 → facts.baseBondSatisfied true + activeDeferral true (no production bond)', rDfr.facts.baseBondSatisfied === true && rDfr.facts.activeDeferral === true && rDfr.facts.productionBaseBondLocked === false)
ok('9a. active 缓交 → NO DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND blocker (mirrors create gate)', !has(rDfr, 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND'))
ok('9b. seller without deferral/bond STILL gets the blocker', has(readDirectPayLaunchReadiness(db, { getProtocolParam: gp, sellerId: 'seller_dfr_none' }), 'DIRECT_PAY_SELLER_NO_PRODUCTION_BASE_BOND'))
// seller de-id view: BASE_BOND item ok for a 缓交 seller (was wrongly false before the fix)
const svDfr = sellerDirectPayReadinessView(db, { getProtocolParam: gp, sellerId: 'seller_dfr' })
ok('9c. seller view BASE_BOND ok=true for 缓交 seller', svDfr.items.find((i: any) => i.code === 'BASE_BOND')?.ok === true)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-launch-readiness tests passed`)
