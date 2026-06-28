#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — base-bond 入场判定(sellerBaseBondEntrySatisfied)测试。
 * 验:保证金门 = 已交生产级 base-bond OR 有有效缓交。无 bond 且无有效缓交 → false(fail-closed);
 *   有效缓交 → true(缓交卖家免先交保证金即可入场);生产 bond → true;缓交过期 → 回 false。
 *   这是"缓交批准的卖家能入场"的钥匙;其余合规门(KYB/制裁/AML/Passkey/收款说明)不在本判定内,另行 AND。
 * Usage: npm run test:direct-pay-base-bond-entry
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-bond-entry-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { sellerBaseBondEntrySatisfied } = await import('../src/direct-pay-base-bond-entry.js')
const { requestDeferral, approveDeferral } = await import('../src/direct-receive-deferral.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
const NOW = '2026-07-01T00:00:00.000Z'
const plus = (days: number) => new Date(Date.parse(NOW) + days * 86_400_000).toISOString()

// 1. 无 bond + 无缓交 → false(fail-closed)
ok('1. no bond + no deferral → false (fail-closed)', sellerBaseBondEntrySatisfied(db, 's_none', NOW) === false)

// 2. 有效缓交(granted,未过 grace)→ true(缓交卖家免先交保证金入场)
requestDeferral(db, { deferralId: 'd_a', userId: 's_defer', periodDays: 30, nowIso: NOW })
approveDeferral(db, { deferralId: 'd_a', adminId: 'admin1', nowIso: NOW, graceDays: 7 })
ok('2. active deferral → true (缓交 satisfies entry, no bond needed)', sellerBaseBondEntrySatisfied(db, 's_defer', plus(10)) === true)
ok('2a. still satisfied within grace (day 33)', sellerBaseBondEntrySatisfied(db, 's_defer', plus(33)) === true)

// 3. 缓交过 grace → 不再满足(无 bond → false)
ok('3. after grace (day 40) + no bond → false', sellerBaseBondEntrySatisfied(db, 's_defer', plus(40)) === false)

// 4. 生产级 base-bond(production_receipt_confirmed_at 非 NULL)→ true(走真实保证金路)
db.prepare(`INSERT INTO direct_receive_deposits (id, user_id, tier, required_amount, amount, currency, deposit_rail, status, production_receipt_confirmed_at, created_at, updated_at)
  VALUES ('dep_b','s_bond','T0',500,500,'usdc','operator_attested','locked', datetime('now'), datetime('now'), datetime('now'))`).run()
ok('4. production base-bond locked → true', sellerBaseBondEntrySatisfied(db, 's_bond', NOW) === true)

// 5. 非生产 locked(无 production receipt)→ 不算(manual/test 不能冒充)
db.prepare(`INSERT INTO direct_receive_deposits (id, user_id, tier, required_amount, amount, currency, deposit_rail, status, production_receipt_confirmed_at, created_at, updated_at)
  VALUES ('dep_m','s_manual','T0',500,500,'usdc','manual','locked', NULL, datetime('now'), datetime('now'))`).run()
ok('5. manual locked WITHOUT production receipt + no deferral → false', sellerBaseBondEntrySatisfied(db, 's_manual', NOW) === false)

// 6. bond 卖家也叠加缓交 → 仍 true(OR)
requestDeferral(db, { deferralId: 'd_b', userId: 's_bond', periodDays: 30, nowIso: NOW })
approveDeferral(db, { deferralId: 'd_b', adminId: 'admin1', nowIso: NOW })
ok('6. bond + deferral → true', sellerBaseBondEntrySatisfied(db, 's_bond', plus(5)) === true)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-base-bond-entry tests passed`)
