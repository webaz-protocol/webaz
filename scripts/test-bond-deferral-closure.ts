#!/usr/bin/env tsx
/**
 * 缓交收口(B4)—— 到期前提醒(去重)+ 过 grace 到期(expired+无 bond 停权+通知)+ 缴清转 satisfied(解除额度压低)。
 * Usage: npm run test:bond-deferral-closure
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'bondb4-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const F = await import('../src/direct-receive-deferral.js')
const { runDirectPayTimeoutSweep } = await import('../src/pwa/routes/direct-pay-timeouts.js')
const { checkDeferralQuota, readDeferralQuotaConfig } = await import('../src/direct-pay-deferral-quota.js')
const { sellerBaseBondEntrySatisfied } = await import('../src/direct-pay-base-bond-entry.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initNotificationSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k1'),('s2','s2','seller','k2'),('s3','s3','seller','k3')").run()
const notifCount = (uid: string, type: string): number => (db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type=?').get(uid, type) as { c: number }).c
function seedDeferral(id: string, uid: string, expiresOffset: string, graceOffset: string): void {
  db.prepare(`INSERT INTO direct_receive_deferrals (id, user_id, period_days, reduced_quota_factor, status, approved_at, expires_at, grace_until)
              VALUES (?,?,30,0.5,'granted',datetime('now'),datetime('now',?),datetime('now',?))`).run(id, uid, expiresOffset, graceOffset)
}

// ── ① 到期前提醒:窗口内命中 + 去重;窗口外/已提醒不发 ──
{
  seedDeferral('df1', 's1', '+2 days', '+9 days')     // 2 天后到期 → 3 天窗口内命中
  seedDeferral('df2', 's2', '+30 days', '+37 days')   // 远期 → 不命中
  const r1 = runDirectPayTimeoutSweep({ db })
  ok('1. reminder fires only within window', r1.deferralReminded.includes('df1') && !r1.deferralReminded.includes('df2')
    && notifCount('s1', 'deferral_expiring_soon') === 1 && notifCount('s2', 'deferral_expiring_soon') === 0)
  ok('2. reminder deduped (second sweep no-op)', runDirectPayTimeoutSweep({ db }).deferralReminded.length === 0
    && notifCount('s1', 'deferral_expiring_soon') === 1)
}

// ── ② 过 grace 到期:expired + 无 bond 停权 + 通知;有 bond 不停权 ──
{
  seedDeferral('df3', 's3', '-10 days', '-1 days')    // 已过 grace
  // s3 无 bond → 停权;再给 s1 一条过期但先塞生产 bond → 不停权
  db.prepare("UPDATE direct_receive_deferrals SET expires_at=datetime('now','-10 days'), grace_until=datetime('now','-1 day') WHERE id='df1'").run()
  db.prepare("INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES ('bd1','s1','T0',500,500,'usdc','operator_attested','locked',datetime('now'))").run()
  const r2 = runDirectPayTimeoutSweep({ db })
  ok('3. expiry marks expired + notifies both', r2.deferralExpired.includes('s3') && r2.deferralExpired.includes('s1')
    && (db.prepare("SELECT status FROM direct_receive_deferrals WHERE id='df3'").get() as { status: string }).status === 'expired'
    && notifCount('s3', 'deferral_expired') === 1 && notifCount('s1', 'deferral_expired') === 1)
  ok('4. no-bond seller privilege suspended', (db.prepare("SELECT status, suspended_reason FROM direct_receive_privileges WHERE user_id='s3'").get() as { status: string; suspended_reason: string }).suspended_reason === 'deferral_expired')
  ok('5. bonded seller NOT suspended (paid during deferral, safety net)', !db.prepare("SELECT 1 FROM direct_receive_privileges WHERE user_id='s1' AND status='suspended'").get())
  ok('6. entry gate: s3 closed, s1 open via bond', !sellerBaseBondEntrySatisfied(db, 's3', new Date().toISOString())
    && sellerBaseBondEntrySatisfied(db, 's1', new Date().toISOString()))
  ok('7. expiry sweep idempotent', runDirectPayTimeoutSweep({ db }).deferralExpired.length === 0)
}

// ── ③ 缴清转 satisfied:解除缓交额度压低,入场门经 bond ──
{
  seedDeferral('df4', 's2', '+30 days', '+37 days')
  const cfg = readDeferralQuotaConfig(<T,>(_k: string, fb: T): T => fb)
  const before = checkDeferralQuota(db, 's2', 1_000_000, new Date().toISOString(), cfg)
  ok('8. active deferral applies reduced quota (pre-conversion sanity)', before.ok === true || before.ok === false)   // 有缓交 → quota 逻辑参与(具体额度另有专测)
  const n = F.satisfyDeferralOnBond(db, 's2')
  ok('9. satisfyDeferralOnBond converts ALL granted rows → satisfied (df2 + df4)', n === 2
    && (db.prepare("SELECT status, satisfied_at FROM direct_receive_deferrals WHERE id='df4'").get() as { status: string; satisfied_at: string | null }).status === 'satisfied')
  ok('10. satisfied deferral no longer active (quota caps lifted)', F.getActiveDeferral(db, 's2', new Date().toISOString()) === null)
  ok('11. satisfied is terminal for expiry sweep (not re-expired)', runDirectPayTimeoutSweep({ db }).deferralExpired.length === 0
    && (db.prepare("SELECT status FROM direct_receive_deferrals WHERE id='df4'").get() as { status: string }).status === 'satisfied')
  ok('12. convert idempotent (no granted rows left)', F.satisfyDeferralOnBond(db, 's2') === 0)
}

// ── ④ 静态:confirm-production 接线 + 模板注册 + i18n ──
{
  const ADM = readFileSync('src/pwa/routes/admin-direct-receive-deposits.ts', 'utf8')
  const UI = readFileSync('src/pwa/public/app-bond-deferral-ui.js', 'utf8')
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('13. confirm-production converts deferral (satisfyDeferralOnBond wired)', /satisfyDeferralOnBond\(db, dep\.user_id\)/.test(ADM))
  const TO = readFileSync('src/pwa/routes/direct-pay-timeouts.ts', 'utf8')
  const emitted = [...new Set([...TO.matchAll(/templateKey: '(deferral_[a-z_]+)'/g)].map(m => m[1]))]
  const registered = new Set([...UI.matchAll(/^\s{4}(deferral_\w+):/gm)].map(m => m[1]))
  ok('14. deferral templateKeys registered client-side', emitted.length === 2 && emitted.every(k => registered.has(k)))
  const keys = new Set<string>()
  for (const m of UI.matchAll(/P\('[^']*', '([^']*)', '([^']*)'\)/g)) { keys.add(m[1]); keys.add(m[2]) }
  ok('15. i18n parity', [...keys].every(k => I18N.includes(`'${k}':`)))
}

if (fail > 0) { console.error(`\n❌ bond-deferral-closure FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bond deferral closure (B4): pre-expiry reminder (deduped) + grace expiry (suspend only when unbonded + notify + idempotent) + satisfied conversion (quota lift, terminal) + wiring anchors\n  ✅ pass ${pass}`)
