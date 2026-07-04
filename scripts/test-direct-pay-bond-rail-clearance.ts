#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — Phase 4 production base-bond RAIL-CLEARANCE registry 测试。
 * 验:registry 全 fail-closed(legal_cleared=false / allowlist=[] / policy_version=占位 / production_ready=false);
 *   isBondRailClearedForProduction 恒 false;assertBondRailCleared 恒抛;blockers 返回预期码;且【关键】registry 无法
 *   绕过 confirmProductionReceipt —— production receipt 永不写、sellerHasProductionBaseBondLocked 恒 false。
 * Usage: npm run test:direct-pay-bond-rail-clearance
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-railclr-'))

const { getBondRailClearance, isBondRailClearedForProduction, assertBondRailCleared, bondRailClearanceBlockers, BOND_POLICY_VERSION_PLACEHOLDER } = await import('../src/direct-pay-bond-rail-clearance.js')
const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { openDeposit, confirmProductionReceipt, sellerHasProductionBaseBondLocked, isProductionBaseBondLocked } = await import('../src/direct-receive-deposits.js')
const { toUnits } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

// ══════ Part A: registry defaults — all fail-closed ══════
for (const rid of ['usdc_onchain', 'fiat_psp']) {
  const c = getBondRailClearance(rid)!
  ok(`registry ${rid}: present + legal_cleared=false`, !!c && c.legalCleared === false)
  ok(`registry ${rid}: jurisdiction_allowlist empty`, c.jurisdictionAllowlist.length === 0)
  ok(`registry ${rid}: policy_version = placeholder`, c.policyVersion === BOND_POLICY_VERSION_PLACEHOLDER)
  ok(`registry ${rid}: production_ready=false`, c.productionReady === false)
}
ok('registry asset_category usdc/fiat correct', getBondRailClearance('usdc_onchain')!.assetCategory === 'usdc' && getBondRailClearance('fiat_psp')!.assetCategory === 'fiat')
ok('registry manual → null (non-production confirm rail, fail-closed)', getBondRailClearance('manual') === null)
ok('registry unknown rail → null', getBondRailClearance('weird_rail') === null)

// ══════ Part B: isBondRailClearedForProduction — always false ══════
for (const rid of ['usdc_onchain', 'fiat_psp', 'manual', 'weird_rail']) {
  ok(`isBondRailClearedForProduction(${rid}, 'SG') === false`, isBondRailClearedForProduction(rid, 'SG') === false)
  ok(`isBondRailClearedForProduction(${rid}, '') === false`, isBondRailClearedForProduction(rid, '') === false)
}

// ══════ Part C: assertBondRailCleared — always throws ══════
for (const rid of ['usdc_onchain', 'fiat_psp', 'manual', 'weird_rail']) {
  ok(`assertBondRailCleared(${rid}) throws (fail-closed)`, throws(() => assertBondRailCleared(rid, 'SG')))
}

// ══════ Part D: blockers helper ══════
const bUsdc = bondRailClearanceBlockers('usdc_onchain')
ok('blockers(usdc_onchain): RAIL_IMPLEMENTATION_GATED (deposit-rail gated, legalCleared=false)', bUsdc.includes('RAIL_IMPLEMENTATION_GATED'))
ok('blockers(usdc_onchain): NO_LEGAL_CLEARED_RAIL', bUsdc.includes('NO_LEGAL_CLEARED_RAIL'))
ok('blockers(usdc_onchain): EMPTY_JURISDICTION_ALLOWLIST', bUsdc.includes('EMPTY_JURISDICTION_ALLOWLIST'))
ok('blockers(usdc_onchain): POLICY_VERSION_UNSET', bUsdc.includes('POLICY_VERSION_UNSET'))
ok('blockers(usdc_onchain): NO_PRODUCTION_RECEIPT when no receipt', bUsdc.includes('NO_PRODUCTION_RECEIPT'))
ok('blockers(usdc_onchain, hasProductionReceipt:true): drops NO_PRODUCTION_RECEIPT, keeps rail blockers', !bondRailClearanceBlockers('usdc_onchain', { hasProductionReceipt: true }).includes('NO_PRODUCTION_RECEIPT') && bondRailClearanceBlockers('usdc_onchain', { hasProductionReceipt: true }).includes('NO_LEGAL_CLEARED_RAIL'))
ok('blockers(manual): RAIL_IMPLEMENTATION_GATED + NO_LEGAL_CLEARED_RAIL (manual non-production, not in registry)', bondRailClearanceBlockers('manual').includes('RAIL_IMPLEMENTATION_GATED') && bondRailClearanceBlockers('manual').includes('NO_LEGAL_CLEARED_RAIL'))

// ══════ Part E: registry CANNOT bypass confirmProductionReceipt / cannot flip the seller gate ══════
const db = initDatabase()
db.pragma('foreign_keys = OFF')
db.prepare("INSERT OR IGNORE INTO penalty_fund (id, balance, total_fee_stake_slash, total_base_bond_slash, updated_at) VALUES ('main',0,0,0,datetime('now'))").run()
db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES ('seller1','s1','seller','k1')").run()
const REQ = toUnits(500)
// usdc/fiat production rails → confirmReceipt GATED (Lock A throws first); registry Lock B also throws.
openDeposit(db, { depositId: 'dU', userId: 'seller1', tier: 'T0', currency: 'usdc', depositRail: 'usdc_onchain' })
ok('confirmProductionReceipt(usdc_onchain) THROWS (双闸 fail-closed)', throws(() => confirmProductionReceipt(db, { depositId: 'dU', railId: 'usdc_onchain', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
ok('dU production_receipt NOT written', isProductionBaseBondLocked(db, { depositId: 'dU' }) === false)
// manual non-production lock must NOT be upgradable, and the seller gate stays false
openDeposit(db, { depositId: 'dM', userId: 'seller1', tier: 'T0', currency: 'fiat', depositRail: 'manual' })
ok('confirmProductionReceipt(manual) THROWS (Lock A: non-production)', throws(() => confirmProductionReceipt(db, { depositId: 'dM', railId: 'manual', expectedAmountUnits: REQ, receiptRef: 'r', jurisdiction: 'SG' })))
ok('seller-level production gate STILL false (Direct Pay non-launchable)', sellerHasProductionBaseBondLocked(db, 'seller1') === false)

// ── consistency with Lock A: impl-check uses `implemented`, not `legalCleared` ──
// operator_attested IS implemented (a built rail) but unregistered → blockers must say NO_LEGAL_CLEARED_RAIL,
// NOT RAIL_IMPLEMENTATION_GATED. (Locks the legalCleared→implemented audit fix; prevents regression.)
const oaB = bondRailClearanceBlockers('operator_attested', { hasProductionReceipt: true })
ok('operator_attested NOT flagged RAIL_IMPLEMENTATION_GATED (it IS implemented)', !oaB.includes('RAIL_IMPLEMENTATION_GATED'))
// 2026-07-05 放行(Holden 决策 B):operator_attested 已注册 SG + 条款版 policy —— 重锚为"已清"断言,
//   并锁死放行的【精确形状】(仅 SG、policy=条款版本;其余法域仍拒 → 白名单语义未松)。
ok('operator_attested CLEARED (registry entry: legal_cleared+production_ready+terms policy)', !oaB.includes('NO_LEGAL_CLEARED_RAIL') && !oaB.includes('POLICY_VERSION_UNSET') && !oaB.includes('EMPTY_JURISDICTION_ALLOWLIST'))
ok('operator_attested cleared for production in SG ONLY (other jurisdictions still rejected)', isBondRailClearedForProduction('operator_attested', 'SG') === true && isBondRailClearedForProduction('operator_attested', 'US') === false && isBondRailClearedForProduction('operator_attested', '') === false)
// gated usdc/fiat still flagged RAIL_IMPLEMENTATION_GATED (implemented=false)
ok('usdc_onchain still RAIL_IMPLEMENTATION_GATED (gated, implemented=false)', bondRailClearanceBlockers('usdc_onchain').includes('RAIL_IMPLEMENTATION_GATED'))

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-bond-rail-clearance tests passed`)
