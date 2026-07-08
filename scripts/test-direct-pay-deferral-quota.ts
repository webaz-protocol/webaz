#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 缓交期额度强制(checkDeferralQuota)测试。
 * 验:① 笔数上限 = floor(base × factor) 下限≥1;② 累计金额绝对封顶;任一超即拒(COUNT/AMOUNT 两码)。
 *   适用范围:仅【active deferral 且无生产 bond】卖家;有 bond / 无 deferral → no-op(ok)。
 *   计入口径(2026-07-08):只算【已付款且有效】单(DEFERRAL_QUOTA_COUNTED_STATUSES 白名单);未付款/取消/退款/拒单不占额。
 *   窗口外单不计;纯读(不写库)。
 * Usage: npm run test:direct-pay-deferral-quota
 */
import Database from 'better-sqlite3'
import { toUnits } from '../src/money.js'

const { requestDeferral, approveDeferral } = await import('../src/direct-receive-deferral.js')
const { checkDeferralQuota, readDeferralQuotaConfig, DEFERRAL_QUOTA_CODES, DEFERRAL_QUOTA_COUNTED_STATUSES } = await import('../src/direct-pay-deferral-quota.js')
const { coarsenBuyerFacingDirectPayCode } = await import('../src/direct-pay-controls.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
db.exec("CREATE TABLE direct_receive_deferrals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reason TEXT, period_days INTEGER NOT NULL, reduced_quota_factor REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'pending', approved_by TEXT, approved_at TEXT, expires_at TEXT, grace_until TEXT, created_at TEXT DEFAULT (datetime('now')))")
db.exec("CREATE TABLE direct_receive_deposits (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, production_receipt_confirmed_at TEXT)")
db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, seller_id TEXT, payment_rail TEXT, status TEXT, total_amount REAL, created_at TEXT, settled_fault_at TEXT)")

const NOW = '2026-07-01T00:00:00.000Z'
const sqlTime = (iso: string): string => new Date(iso).toISOString().slice(0, 19).replace('T', ' ')
const plusDays = (d: number): string => new Date(Date.parse(NOW) + d * 86_400_000).toISOString()
let oc = 0
// 插入一条 direct_p2p 订单(可指定金额/状态/创建时间偏移天数)
const order = (sellerId: string, amount: number, status = 'accepted', dayOffset = 0): void => {   // 默认用【已付款计入态】accepted(口径改后 direct_pay_window 不再计入)
  db.prepare("INSERT INTO orders (id, seller_id, payment_rail, status, total_amount, created_at) VALUES (?,?,?,?,?,?)")
    .run('o' + (++oc), sellerId, 'direct_p2p', status, amount, sqlTime(plusDays(dayOffset)))
}
// 给某卖家建一条 active granted 缓交(指定 factor)
const grantDeferral = (sellerId: string, factor: number): void => {
  const id = 'd_' + sellerId
  requestDeferral(db, { deferralId: id, userId: sellerId, periodDays: 30, nowIso: NOW })
  approveDeferral(db, { deferralId: id, adminId: 'admin1', nowIso: NOW, graceDays: 7, reducedQuotaFactor: factor })
}
const CFG = { windowDays: 30, baseOrderCount: 10, maxWindowAmountUnits: toUnits(500) }
const check = (sellerId: string, amt: number) => checkDeferralQuota(db, sellerId, toUnits(amt), NOW, CFG)

// ── 1. no-op 范围:无 deferral / 有生产 bond → ok(不归本模块管)──
ok('1. no deferral → ok (no-op)', check('s_none', 10000).ok === true)
db.prepare("INSERT INTO direct_receive_deposits (id, user_id, status, production_receipt_confirmed_at) VALUES ('dep1','s_bond','locked', datetime('now'))").run()
grantDeferral('s_bond', 0.5)   // 同时有 bond 和 deferral → bond 优先,不压
ok('1a. production bond present → ok even with active deferral (bond precedence)', check('s_bond', 99999).ok === true)

// ── 2. 笔数上限 = floor(base × factor),下限 ≥ 1 ──
grantDeferral('s_count', 0.5)   // countLimit = floor(10 × 0.5) = 5
for (let i = 0; i < 4; i++) order('s_count', 10)   // 4 existing
ok('2. 4 existing, +1 = 5 ≤ limit(5) → ok', check('s_count', 10).ok === true)
order('s_count', 10)   // 5th
const over = check('s_count', 10)
ok('2a. 5 existing, +1 = 6 > limit(5) → COUNT rejected', over.ok === false && (over as any).code === DEFERRAL_QUOTA_CODES.COUNT, JSON.stringify(over))
// cancelled 不计入笔数:加 3 条 cancelled,仍按 5 算 → 仍超(说明 cancelled 不算,但也不影响"已有5")
order('s_count', 10, 'cancelled'); order('s_count', 10, 'cancelled')
const stillCount = db.prepare("SELECT COUNT(*) n FROM orders WHERE seller_id='s_count' AND status!='cancelled'").get() as any
ok('2b. cancelled excluded → non-cancelled count stays 5', stillCount.n === 5)

// ── 3. 窗口:窗口外订单不计 ──
grantDeferral('s_win', 0.1)   // countLimit = max(1, floor(10×0.1)=1) = 1
order('s_win', 10, 'accepted', -40)   // 40 天前(窗口外);用计入态 accepted 纯测窗口排除
ok('3. only out-of-window order → counts as 0 → +1 = 1 ≤ limit(1) → ok', check('s_win', 10).ok === true)
ok('3a. floor ≥ 1 (factor 0.1, base 10 → limit 1, not 0)', check('s_win', 10).ok === true)
order('s_win', 10)   // 1 in-window
ok('3b. 1 in-window + out-of-window → +1 = 2 > limit(1) → COUNT rejected', check('s_win', 10).ok === false)

// ── 4. 金额绝对封顶(不随 factor 缩放)──
grantDeferral('s_amt', 0.9)   // countLimit = 9(高,不让笔数先触顶)
for (let i = 0; i < 4; i++) order('s_amt', 100)   // 累计 400(units 400_00),4 单 ≤ 9
ok('4. window amount 400 + new 50 = 450 ≤ cap(500) → ok', check('s_amt', 50).ok === true)
const amtOver = check('s_amt', 120)   // 400 + 120 = 520 > 500
ok('4a. window amount 400 + new 120 = 520 > cap(500) → AMOUNT rejected', amtOver.ok === false && (amtOver as any).code === DEFERRAL_QUOTA_CODES.AMOUNT, JSON.stringify(amtOver))

// ── 5. readDeferralQuotaConfig:默认 + 治理覆盖 + 下限保护 ──
const cp: Record<string, unknown> = {}
const gp = <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
const def = readDeferralQuotaConfig(gp)
ok('5. defaults: window 30d, base 20, maxAmount toUnits(500)', def.windowDays === 30 && def.baseOrderCount === 20 && def.maxWindowAmountUnits === toUnits(500))
cp['direct_pay.deferral_window_days'] = 14; cp['direct_pay.deferral_base_order_count'] = 5; cp['direct_pay.deferral_max_window_amount_units'] = toUnits(200)
const ov = readDeferralQuotaConfig(gp)
ok('5a. governance overrides honored', ov.windowDays === 14 && ov.baseOrderCount === 5 && ov.maxWindowAmountUnits === toUnits(200))
cp['direct_pay.deferral_window_days'] = 0; cp['direct_pay.deferral_base_order_count'] = 0
const fl = readDeferralQuotaConfig(gp)
ok('5b. floors: windowDays≥1, baseOrderCount≥1', fl.windowDays === 1 && fl.baseOrderCount === 1)

// ── 6. 纯读:checkDeferralQuota 不写任何表 ──
const snap = () => JSON.stringify(['orders', 'direct_receive_deferrals', 'direct_receive_deposits'].map(t => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n))
const before = snap()
for (let i = 0; i < 5; i++) check('s_count', 10)
ok('6. checkDeferralQuota is read-only (no row count change)', snap() === before)

// ── 7. de-id drift guard:两个 quota code 必须被 coarsenBuyerFacingDirectPayCode 收敛(买家面不泄露缓交/超额)──
ok('7. COUNT code coarsens to SELLER_NOT_ELIGIBLE', coarsenBuyerFacingDirectPayCode(DEFERRAL_QUOTA_CODES.COUNT) === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE')
ok('7a. AMOUNT code coarsens to SELLER_NOT_ELIGIBLE', coarsenBuyerFacingDirectPayCode(DEFERRAL_QUOTA_CODES.AMOUNT) === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE')

// ── 8. 计入口径逐状态锁死:已付款有效计入,未付款/取消/退款/拒单不占额 ──
const statusCounted = (status: string): boolean => {   // countLimit=1;加一条该状态单;+1 新单 → 计入则 2>1 拒(false),不计则 1≤1 ok(true) → 返回是否计入
  const s = 's_st_' + status
  grantDeferral(s, 0.1)   // countLimit = max(1, floor(10×0.1)) = 1
  order(s, 10, status)
  return check(s, 10).ok === false
}
for (const st of ['accepted', 'shipped', 'picked_up', 'in_transit', 'delivered', 'confirmed', 'completed', 'resolved_for_seller', 'payment_query', 'disputed']) {
  ok(`8. 已付款有效态 ${st} → 占额(触顶拒)`, statusCounted(st))
}
for (const st of ['created', 'pending_accept', 'direct_pay_window', 'direct_expired_unconfirmed', 'cancelled', 'refunded_full', 'refunded_partial', 'fault_seller', 'fault_buyer', 'fault_logistics', 'declined_nofault', 'dispute_dismissed', 'expired']) {
  ok(`8. 未付款/取消/退款态 ${st} → 不占额(不触顶)`, !statusCounted(st))
}
ok('8a. COUNTED_STATUSES 常量含 accepted/completed/disputed,不含 cancelled/direct_pay_window(防常量↔SQL 漂移)',
  DEFERRAL_QUOTA_COUNTED_STATUSES.includes('accepted' as never) && DEFERRAL_QUOTA_COUNTED_STATUSES.includes('completed' as never) && DEFERRAL_QUOTA_COUNTED_STATUSES.includes('disputed' as never)
  && !(DEFERRAL_QUOTA_COUNTED_STATUSES as readonly string[]).includes('cancelled') && !(DEFERRAL_QUOTA_COUNTED_STATUSES as readonly string[]).includes('direct_pay_window'))

// ── 8b. completed 边界:拒单/违约结算(settled_fault_at 非空)= 买家已退款 → 不占额;genuine completed(NULL)→ 占额 ──
//   fault_seller→completed / declined_nofault→completed 都终态 completed,但 settled_fault_at 被 settleFault/settleDeclinedNoFault 写入。
grantDeferral('s_fc', 0.1)   // countLimit = 1
db.prepare("INSERT INTO orders (id, seller_id, payment_rail, status, total_amount, created_at, settled_fault_at) VALUES ('o_fc','s_fc','direct_p2p','completed',10,?, ?)")
  .run(sqlTime(plusDays(0)), sqlTime(plusDays(0)))
ok('8b. completed + settled_fault_at(拒单/违约已退款)→ 不占额(+1=1≤1 → ok)', check('s_fc', 10).ok === true)
grantDeferral('s_gc', 0.1)   // countLimit = 1
order('s_gc', 10, 'completed')   // genuine completed:order() 不写 settled_fault_at → NULL
ok('8c. genuine completed(settled_fault_at NULL)→ 占额(+1=2>1 → 拒)', check('s_gc', 10).ok === false)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-deferral-quota tests passed`)
