#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — base-bond 缓交(deferred deposit)生命周期测试。
 * 验:申请→pending;真人 admin 批→granted(到期/宽限/压低配额);拒;单一活跃;到期→宽限→expired(返回受影响 user);
 *   getActiveDeferral 在 grace 内可取、过 grace 为 null;不零威慑(配额系数有下限<1);只动 direct_receive_deferrals。
 * Usage: npm run test:direct-receive-deferral
 */
import Database from 'better-sqlite3'

const { requestDeferral, approveDeferral, rejectDeferral, getActiveDeferral, expireDeferrals, clampReducedQuotaFactor, DEFAULT_DEFERRAL_CONFIG } = await import('../src/direct-receive-deferral.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
db.exec("CREATE TABLE direct_receive_deferrals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reason TEXT, period_days INTEGER NOT NULL, reduced_quota_factor REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'pending', approved_by TEXT, approved_at TEXT, expires_at TEXT, grace_until TEXT, created_at TEXT DEFAULT (datetime('now')))")
// 副作用断言:缓交绝不应碰这些
db.exec("CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL)")
db.exec("CREATE TABLE direct_receive_deposits (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, production_receipt_confirmed_at TEXT)")
db.exec("CREATE TABLE direct_receive_privileges (user_id TEXT PRIMARY KEY, status TEXT)")
const sideN = (): number => ['wallets', 'direct_receive_deposits', 'direct_receive_privileges'].reduce((s, t) => s + (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n, 0)
const row = (id: string): any => db.prepare('SELECT * FROM direct_receive_deferrals WHERE id=?').get(id)
const T0 = '2026-07-01T00:00:00.000Z'
const plus = (days: number) => new Date(Date.parse(T0) + days * 86_400_000).toISOString()

// ── 1. clampReducedQuotaFactor:不零威慑(下限>0)+ 缓交期必压低(上限<1)──
ok('1. clamp floors at min (never 0)', clampReducedQuotaFactor(0) === DEFAULT_DEFERRAL_CONFIG.minReducedQuotaFactor && DEFAULT_DEFERRAL_CONFIG.minReducedQuotaFactor > 0)
ok('1a. clamp caps at max (<1)', clampReducedQuotaFactor(5) === DEFAULT_DEFERRAL_CONFIG.maxReducedQuotaFactor && DEFAULT_DEFERRAL_CONFIG.maxReducedQuotaFactor < 1)
ok('1b. clamp passes through in-range', clampReducedQuotaFactor(0.5) === 0.5)
ok('1c. clamp default for garbage', clampReducedQuotaFactor(undefined) >= DEFAULT_DEFERRAL_CONFIG.minReducedQuotaFactor && clampReducedQuotaFactor(NaN as any) <= DEFAULT_DEFERRAL_CONFIG.maxReducedQuotaFactor)

// ── 2. request → pending ──
ok('2. request → pending', requestDeferral(db, { deferralId: 'd1', userId: 'u1', periodDays: 30, reason: 'cashflow', nowIso: T0 }).ok && row('d1').status === 'pending')
ok('2a. missing args rejected', !requestDeferral(db, { deferralId: '', userId: 'u1', nowIso: T0 }).ok)
ok('2b. non-positive periodDays rejected', !requestDeferral(db, { deferralId: 'dx', userId: 'ux', periodDays: 0, nowIso: T0 }).ok)
ok('2c. duplicate active (pending) rejected', !requestDeferral(db, { deferralId: 'd1b', userId: 'u1', periodDays: 30, nowIso: T0 }).ok)

// ── 3. approve requires human admin; pending→granted with clocks ──
ok('3. approve without adminId rejected (no auto-grant)', !approveDeferral(db, { deferralId: 'd1', adminId: '', nowIso: T0 }).ok)
const ap = approveDeferral(db, { deferralId: 'd1', adminId: 'admin1', nowIso: T0, graceDays: 7, reducedQuotaFactor: 0.4 })
ok('3a. approve → granted', ap.ok && row('d1').status === 'granted' && row('d1').approved_by === 'admin1')
ok('3b. expires_at = now + period(30d), grace_until = +37d', row('d1').expires_at === '2026-07-31 00:00:00' && row('d1').grace_until === '2026-08-07 00:00:00')
ok('3c. reduced_quota_factor stored (clamped 0.4)', row('d1').reduced_quota_factor === 0.4)
ok('3d. approve idempotent', approveDeferral(db, { deferralId: 'd1', adminId: 'admin1', nowIso: T0 }).already === true)

// ── 4. getActiveDeferral: within window / within grace / after grace ──
ok('4. active within window (day 10)', getActiveDeferral(db, 'u1', plus(10))?.id === 'd1')
const inGrace = getActiveDeferral(db, 'u1', plus(33))   // past expires(30) before grace(37)
ok('4a. active within grace, inGrace=true (day 33)', inGrace?.id === 'd1' && inGrace?.inGrace === true)
ok('4b. NOT active after grace (day 40) → null', getActiveDeferral(db, 'u1', plus(40)) === null)
ok('4c. reducedQuotaFactor exposed on active', getActiveDeferral(db, 'u1', plus(10))?.reducedQuotaFactor === 0.4)

// ── 5. reject (separate user) ──
requestDeferral(db, { deferralId: 'd2', userId: 'u2', periodDays: 14, nowIso: T0 })
ok('5. reject without admin rejected', !rejectDeferral(db, { deferralId: 'd2', adminId: '' }).ok)
ok('5a. reject → rejected', rejectDeferral(db, { deferralId: 'd2', adminId: 'admin1' }).ok && row('d2').status === 'rejected')
ok('5b. cannot approve a rejected one', !approveDeferral(db, { deferralId: 'd2', adminId: 'admin1', nowIso: T0 }).ok)

// ── 6. expireDeferrals: past grace → expired + returns user; within grace untouched ──
requestDeferral(db, { deferralId: 'd3', userId: 'u3', periodDays: 10, nowIso: T0 })
approveDeferral(db, { deferralId: 'd3', adminId: 'admin1', nowIso: T0, graceDays: 3 })  // grace_until = +13d
const e1 = expireDeferrals(db, plus(11))  // within grace (11<13) → not expired
ok('6. within grace not expired', e1.expired.length === 0 && row('d3').status === 'granted')
const e2 = expireDeferrals(db, plus(20))  // past grace → expired
ok('6a. past grace → expired + returns user', e2.expired.includes('u3') && row('d3').status === 'expired')
ok('6b. after expiry, user may request again (single-active freed)', requestDeferral(db, { deferralId: 'd3b', userId: 'u3', periodDays: 10, nowIso: plus(20) }).ok)

// ── 7. read-only re: money/state — only direct_receive_deferrals is touched ──
ok('7. NO wallet/deposit/privilege side effects', sideN() === 0)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-receive-deferral tests passed`)
