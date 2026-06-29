#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 上线就绪聚合(summarizeDirectPayLaunchReadiness)测试。
 * 验:全局未就绪 → go=false;全局就绪 + 一个 ready 卖家且有可直付商品 → go=true;卖家 ready 但 0 可直付品 → 不 launchable;
 *   店铺豁免卖家 → 所有在售品算可直付;候选集合 = 任一 direct-pay 表里出现过的卖家;纯读。
 * Usage: npm run test:direct-pay-launch-summary
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-summary-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { summarizeDirectPayLaunchReadiness } = await import('../src/direct-pay-launch-summary.js')
const { toUnits } = await import('../src/money.js')
const { requestDeferral, approveDeferral } = await import('../src/direct-receive-deferral.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
try { db.exec("ALTER TABLE products ADD COLUMN has_variants INTEGER DEFAULT 0") } catch { /* exists */ }
const cp: Record<string, unknown> = {}
const gp = <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)

// ── 1. fresh: global not ready, no sellers → no-go ──
const s0 = summarizeDirectPayLaunchReadiness(db, gp)
ok('1. fresh → go=false', s0.go === false)
ok('1a. global not ready (NOT_ENABLED present)', s0.global.ready === false && s0.global.blockers.includes('DIRECT_PAY_NOT_ENABLED'))
ok('1b. no candidate sellers', s0.sellers.length === 0)

// helpers
const seedSeller = (id: string) => db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(id, id, 'seller', 'k_' + id)
const seedProduct = (pid: string, sid: string) => db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES (?,?,?,?,?,?, 'active')").run(pid, sid, 'T', 'd', 50, 10)
const seedBond = (sid: string) => db.prepare("INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)").run('dep_' + sid, sid, 'T0', 500, 500, 'usdc', 'manual', 'locked', new Date().toISOString())
const seedKyb = (sid: string) => db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES (?,?,'approved')").run('kyb_' + sid, sid)
const seedSanctions = (sid: string) => db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES (?,?,'clear')").run('sc_' + sid, sid)
const seedInstr = (sid: string) => db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES (?,?,?,?,'active')").run('pi_' + sid, sid, 'PayNow', 'PayNow')
const seedProductVerified = (pid: string, sid: string) => db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES (?,?,?,?, 'verified','admin1',datetime('now'))").run('pvf_' + pid, pid, sid, 'wzv_' + pid)
const seedStoreExempt = (sid: string) => db.prepare("INSERT INTO store_verifications (id, user_id, code, status, per_product_exempt, reviewed_by, reviewed_at) VALUES (?,?,?, 'verified', 1, 'admin1', datetime('now'))").run('sv_' + sid, sid, 'wzs_' + sid)

// open the global gate
cp['direct_pay.enabled'] = true
cp['direct_pay.region'] = 'SG'
cp['direct_pay.region_allowlist'] = 'SG'
cp['direct_pay.per_tx_cap_units'] = toUnits(1000)

// ── 2. fully-ready seller with a verified product → launchable + go=true ──
seedSeller('s_ok'); seedProduct('p_ok', 's_ok'); seedBond('s_ok'); seedKyb('s_ok'); seedSanctions('s_ok'); seedInstr('s_ok'); seedProductVerified('p_ok', 's_ok')
const s2 = summarizeDirectPayLaunchReadiness(db, gp)
ok('2. global now ready', s2.global.ready === true)
const ok2 = s2.sellers.find(s => s.sellerId === 's_ok')!
ok('2a. s_ok ready + 1/1 eligible product + launchable', ok2.ready === true && ok2.eligibleProductCount === 1 && ok2.activeProductCount === 1 && ok2.launchable === true, JSON.stringify(ok2))
ok('2b. go=true (global ready + a launchable seller)', s2.go === true)

// ── 3. seller ready but 0 eligible products → not launchable ──
seedSeller('s_noprod'); seedProduct('p_unv', 's_noprod'); seedBond('s_noprod'); seedKyb('s_noprod'); seedSanctions('s_noprod'); seedInstr('s_noprod')  // product NOT verified
const s3 = summarizeDirectPayLaunchReadiness(db, gp)
const np = s3.sellers.find(s => s.sellerId === 's_noprod')!
ok('3. s_noprod ready but 0 eligible products → not launchable', np.ready === true && np.eligibleProductCount === 0 && np.launchable === false, JSON.stringify(np))

// ── 4. store-exempt seller → all active products eligible (even unverified) ──
seedSeller('s_ex'); seedProduct('p_ex1', 's_ex'); seedProduct('p_ex2', 's_ex'); seedBond('s_ex'); seedKyb('s_ex'); seedSanctions('s_ex'); seedInstr('s_ex'); seedStoreExempt('s_ex')
const s4 = summarizeDirectPayLaunchReadiness(db, gp)
const ex = s4.sellers.find(s => s.sellerId === 's_ex')!
ok('4. store-exempt seller → all active products eligible + launchable', ex.storeExempt === true && ex.eligibleProductCount === 2 && ex.launchable === true, JSON.stringify(ex))

// ── 5. seller missing compliance (only instruction) → not ready, blockers present ──
seedSeller('s_bad'); seedProduct('p_bad', 's_bad'); seedInstr('s_bad')  // no bond/kyb/sanctions
const s5 = summarizeDirectPayLaunchReadiness(db, gp)
const bad = s5.sellers.find(s => s.sellerId === 's_bad')!
ok('5. s_bad not ready (missing base-bond/KYB) → blockers, not launchable', bad.ready === false && bad.blockers.length > 0 && bad.launchable === false, JSON.stringify(bad))
ok('5a. seller blockers exclude global ones', !bad.blockers.includes('DIRECT_PAY_NOT_ENABLED'))

// ── 6. global gate closed again → go=false even with launchable sellers ──
cp['direct_pay.enabled'] = false
const s6 = summarizeDirectPayLaunchReadiness(db, gp)
ok('6. global disabled → go=false despite launchable sellers', s6.go === false && s6.global.ready === false && s6.launchableSellerCount >= 1)

// ── 7. candidate set = union across direct-pay tables (all seeded sellers present) ──
cp['direct_pay.enabled'] = true
const ids = summarizeDirectPayLaunchReadiness(db, gp).sellers.map(s => s.sellerId)
ok('7. candidates include all seeded direct-pay sellers', ['s_ok', 's_noprod', 's_ex', 's_bad'].every(x => ids.includes(x)))

// ── 8. read-only ──
const before = (db.prepare("SELECT COUNT(*) n FROM product_verifications").get() as any).n
summarizeDirectPayLaunchReadiness(db, gp); summarizeDirectPayLaunchReadiness(db, gp)
ok('8. summarize is read-only', (db.prepare("SELECT COUNT(*) n FROM product_verifications").get() as any).n === before)

// ── 9. P2: variant (规格) product is NOT eligible (direct_p2p v1 rejects it) ──
seedSeller('s_var'); seedBond('s_var'); seedKyb('s_var'); seedSanctions('s_var'); seedInstr('s_var')
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status, has_variants) VALUES ('p_var','s_var','V','d',50,10,'active',1)").run()
seedProductVerified('p_var', 's_var')   // even verified, a variant product can't go direct_p2p v1
const s9 = summarizeDirectPayLaunchReadiness(db, gp)
const vr = s9.sellers.find(s => s.sellerId === 's_var')!
ok('9. ready seller with ONLY a variant product → 0 eligible, not launchable', vr.ready === true && vr.eligibleProductCount === 0 && vr.launchable === false, JSON.stringify(vr))

// ── 10. P1: 缓交 seller with quota exhausted → eligible product does NOT count → not launchable ──
seedSeller('s_q'); seedKyb('s_q'); seedSanctions('s_q'); seedInstr('s_q')   // NO production bond → enters via deferral
requestDeferral(db, { deferralId: 'dq_s', userId: 's_q', periodDays: 30, nowIso: new Date().toISOString() })
approveDeferral(db, { deferralId: 'dq_s', adminId: 'admin1', nowIso: new Date().toISOString() })   // factor clamps → 0.5
seedProduct('p_q', 's_q'); seedProductVerified('p_q', 's_q')
cp['direct_pay.deferral_base_order_count'] = 1   // countLimit = max(1, floor(1×0.5)) = 1
// exhaust: one existing non-cancelled direct_p2p order in window → existing 1 + new 1 = 2 > 1
db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, created_at) VALUES ('o_q','p_q','buyer1','s_q',1,50,50,0,'direct_pay_window','direct_p2p', datetime('now'))").run()
const s10 = summarizeDirectPayLaunchReadiness(db, gp)
const q = s10.sellers.find(s => s.sellerId === 's_q')!
ok('10. 缓交 seller ready + verified product but quota exhausted → 0 eligible, not launchable', q.ready === true && q.eligibleProductCount === 0 && q.launchable === false, JSON.stringify(q))
// sanity: lift the quota → same product becomes eligible (proves quota was the blocker, not verification)
cp['direct_pay.deferral_base_order_count'] = 50
const q2 = summarizeDirectPayLaunchReadiness(db, gp).sellers.find(s => s.sellerId === 's_q')!
ok('10a. raise quota → 缓交 seller product now eligible + launchable', q2.eligibleProductCount === 1 && q2.launchable === true, JSON.stringify(q2))
delete cp['direct_pay.deferral_base_order_count']

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-launch-summary tests passed`)
