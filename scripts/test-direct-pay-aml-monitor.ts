#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — PR-6C AML flag writer scaffold 测试。
 * 验:runDirectPayAmlMonitor / safeRunDirectPayAmlMonitor 按治理阈值 append-only 写 aml_flags;
 *   默认 inert(阈值 0 不触发);幂等(同 order+rule 不重复);写出的 medium/open flag 使 #107 breaker 判 false;
 *   cleared/low/non-suspend 不阻断;只写 aml_flags 无 order/wallet/stake/stock 副作用;fail-soft 吞异常。
 * Usage: npm run test:direct-pay-aml-monitor
 */
import Database from 'better-sqlite3'

const { runDirectPayAmlMonitor, safeRunDirectPayAmlMonitor, DIRECT_PAY_AML_PARAMS } = await import('../src/direct-pay-aml-monitor.js')
const { sellerDirectPayAmlClear } = await import('../src/direct-pay-controls.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
// 最小 schema:本测试只需 orders(monitor 窗口查询)+ aml_flags(写入 + breaker 读取)。
db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, seller_id TEXT, payment_rail TEXT, total_amount REAL, created_at TEXT)`)
db.exec(`CREATE TABLE aml_flags (id TEXT PRIMARY KEY, subject_user_id TEXT NOT NULL, related_order_id TEXT, rule TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'low', detail TEXT, status TEXT NOT NULL DEFAULT 'open', disposition TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now')))`)

// orders 计数辅助(验"无 order 副作用")+ direct_p2p 单播种(created_at 用 SQLite datetime 格式)。
const NOW = '2026-06-28T12:00:00.000Z'
const tsAgo = (h: number): string => new Date(new Date(NOW).getTime() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
let on = 0
const seedOrder = (seller: string, amount: number, hoursAgo: number): string => {
  const id = 'ord' + (++on)
  db.prepare("INSERT INTO orders (id, seller_id, payment_rail, total_amount, created_at) VALUES (?,?,?,?,?)").run(id, seller, 'direct_p2p', amount, tsAgo(hoursAgo))
  return id
}
const amlCount = (seller: string): number => (db.prepare("SELECT COUNT(*) n FROM aml_flags WHERE subject_user_id=?").get(seller) as { n: number }).n
const ordersN = (): number => (db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n
// gp:从一个可变 params 对象读(模拟 protocol_params,缺失回落 fallback)。
let params: Record<string, unknown> = {}
const gp = <T,>(k: string, fb: T): T => (k in params ? params[k] as T : fb)

// ── 0. param 描述默认全 inert(velocity/concentration 阈值默认 0)──
const byKey = Object.fromEntries(DIRECT_PAY_AML_PARAMS.map(p => [p.key, p.value]))
ok('params: velocity_max_orders default 0 (inert)', byKey['direct_pay.aml.velocity_max_orders'] === '0')
ok('params: small_order_amount default 0 (inert)', byKey['direct_pay.aml.small_order_amount'] === '0')
ok('params: concentration_max_small_orders default 0 (inert)', byKey['direct_pay.aml.concentration_max_small_orders'] === '0')
ok('params: window_hours default 24', byKey['direct_pay.aml.window_hours'] === '24')

// ── 1. default params → INERT:即便有很多单也不写 flag ──
for (let i = 0; i < 5; i++) seedOrder('s_inert', 10, 1)
const inertTrigger = seedOrder('s_inert', 10, 0)
params = {}  // all default
runDirectPayAmlMonitor(db, { sellerId: 's_inert', orderId: inertTrigger, nowIso: NOW, getProtocolParam: gp })
ok('inert defaults → no flag written even with 6 orders', amlCount('s_inert') === 0)

// ── 2. velocity over threshold → writes a medium/open flag ──
params = { 'direct_pay.aml.velocity_max_orders': 3 }
for (let i = 0; i < 2; i++) seedOrder('s_vel', 20, 2)
const velTrigger = seedOrder('s_vel', 20, 0)  // 3rd order in window → count 3 >= 3
const r2 = runDirectPayAmlMonitor(db, { sellerId: 's_vel', orderId: velTrigger, nowIso: NOW, getProtocolParam: gp })
ok('velocity ≥ threshold → 1 flag written', r2.flagsWritten.length === 1 && amlCount('s_vel') === 1, JSON.stringify(r2))
const velFlag = db.prepare("SELECT rule, severity, status, related_order_id, detail FROM aml_flags WHERE subject_user_id='s_vel'").get() as any
ok('velocity flag is rule=velocity severity=medium status=open', velFlag.rule === 'velocity' && velFlag.severity === 'medium' && velFlag.status === 'open', JSON.stringify(velFlag))
ok('velocity flag related_order_id = trigger order', velFlag.related_order_id === velTrigger)
ok('velocity flag detail is numbers-only (no PII): window/count/threshold', /"order_count":3/.test(velFlag.detail) && !/seller|buyer|addr|name/i.test(velFlag.detail), velFlag.detail)

// ── 3. below threshold → no flag ──
params = { 'direct_pay.aml.velocity_max_orders': 10 }
seedOrder('s_low', 20, 1); const lowTrigger = seedOrder('s_low', 20, 0)
runDirectPayAmlMonitor(db, { sellerId: 's_low', orderId: lowTrigger, nowIso: NOW, getProtocolParam: gp })
ok('velocity below threshold → no flag', amlCount('s_low') === 0)

// ── 3b. orders outside the window are NOT counted ──
params = { 'direct_pay.aml.velocity_max_orders': 2, 'direct_pay.aml.window_hours': 24 }
seedOrder('s_win', 20, 48); seedOrder('s_win', 20, 30)  // both older than 24h
const winTrigger = seedOrder('s_win', 20, 0)             // only this is in-window → count 1 < 2
runDirectPayAmlMonitor(db, { sellerId: 's_win', orderId: winTrigger, nowIso: NOW, getProtocolParam: gp })
ok('out-of-window orders not counted → no flag', amlCount('s_win') === 0)

// ── 4. idempotent: same order + rule re-run does not duplicate ──
params = { 'direct_pay.aml.velocity_max_orders': 3 }
const reRun = runDirectPayAmlMonitor(db, { sellerId: 's_vel', orderId: velTrigger, nowIso: NOW, getProtocolParam: gp })
ok('idempotent: re-run same order/rule → 0 new flags', reRun.flagsWritten.length === 0 && amlCount('s_vel') === 1)

// ── 5. written medium/open flag makes #107 breaker return false ──
ok('breaker: s_vel (open/medium flag) → sellerDirectPayAmlClear false', sellerDirectPayAmlClear(db, 's_vel') === false)
ok('breaker: s_low (no flag) → sellerDirectPayAmlClear true', sellerDirectPayAmlClear(db, 's_low') === true)
// cleared/low/non-suspend still not blocking (reader contract holds with writer-produced rows)
db.prepare("UPDATE aml_flags SET status='cleared' WHERE subject_user_id='s_vel'").run()
ok('breaker: after flag CLEARED → sellerDirectPayAmlClear true again', sellerDirectPayAmlClear(db, 's_vel') === true)

// ── 6. concentration rule (small repeated orders) ──
params = { 'direct_pay.aml.small_order_amount': 5, 'direct_pay.aml.concentration_max_small_orders': 3 }
for (let i = 0; i < 2; i++) seedOrder('s_con', 3, 2)         // small (<=5)
seedOrder('s_con', 100, 1)                                   // large — not counted
const conTrigger = seedOrder('s_con', 4, 0)                  // 3rd small in window
const r6 = runDirectPayAmlMonitor(db, { sellerId: 's_con', orderId: conTrigger, nowIso: NOW, getProtocolParam: gp })
ok('concentration ≥ threshold (small orders only) → 1 flag', r6.flagsWritten.length === 1 && amlCount('s_con') === 1, JSON.stringify(r6))
const conFlag = db.prepare("SELECT rule, detail FROM aml_flags WHERE subject_user_id='s_con'").get() as any
ok('concentration flag rule=concentration, counts only small orders (3)', conFlag.rule === 'concentration' && /"small_order_count":3/.test(conFlag.detail), JSON.stringify(conFlag))
// concentration needs BOTH params > 0 (only small_order_amount set → inert)
params = { 'direct_pay.aml.small_order_amount': 5 }
seedOrder('s_con2', 3, 1); const con2 = seedOrder('s_con2', 3, 0)
runDirectPayAmlMonitor(db, { sellerId: 's_con2', orderId: con2, nowIso: NOW, getProtocolParam: gp })
ok('concentration inert when max_small_orders unset (0)', amlCount('s_con2') === 0)

// ── 7. no order/stake/stock side effects: monitor only writes aml_flags ──
const ordersBefore = ordersN()
params = { 'direct_pay.aml.velocity_max_orders': 1 }
const sideTrigger = seedOrder('s_side', 20, 0)  // seeding the trigger is the test harness, not the monitor
const ordersAfterSeed = ordersN()
const amlBefore = amlCount('s_side')
runDirectPayAmlMonitor(db, { sellerId: 's_side', orderId: sideTrigger, nowIso: NOW, getProtocolParam: gp })
ok('monitor adds NO orders rows (only aml_flags)', ordersN() === ordersAfterSeed && ordersAfterSeed === ordersBefore + 1)
ok('monitor wrote exactly the aml_flag (its only write)', amlCount('s_side') === amlBefore + 1)

// ── 8. fail-soft: throwing getProtocolParam is swallowed, nothing written, no throw ──
const amlTotalBefore = (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as { n: number }).n
const boomTrigger = seedOrder('s_boom', 20, 0)
let threw = false
let res8: any
try { res8 = safeRunDirectPayAmlMonitor(db, { sellerId: 's_boom', orderId: boomTrigger, nowIso: NOW, getProtocolParam: (() => { throw new Error('boom') }) as any }) } catch { threw = true }
ok('fail-soft: safeRun does NOT throw on monitor error', threw === false)
ok('fail-soft: returns { ok:false, error }', res8 && res8.ok === false && typeof res8.error === 'string', JSON.stringify(res8))
ok('fail-soft: no aml_flags written on error', (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as { n: number }).n === amlTotalBefore)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-aml-monitor tests passed`)
