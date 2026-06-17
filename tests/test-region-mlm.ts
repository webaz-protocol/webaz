// Phase B — Region MLM gate 单测
// 测三个核心路径：max_levels=0 整池入 charity_fund / 30d 冷却 / userMlmGate 返回值
import Database from 'better-sqlite3'
import { generateId } from '../src/layer0-foundation/L0-1-database/schema.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ─── 最小 DB — 复刻 region_config + charity_fund + charity_fund_txns schema ──
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE region_config (
    region TEXT PRIMARY KEY,
    max_levels INTEGER NOT NULL,
    active INTEGER DEFAULT 1,
    mlm_ui_visible INTEGER DEFAULT 1
  );
  CREATE TABLE charity_fund (
    id TEXT PRIMARY KEY,
    balance REAL DEFAULT 0,
    total_donated REAL DEFAULT 0,
    total_disbursed REAL DEFAULT 0,
    total_redirected REAL DEFAULT 0,
    total_chain_gap REAL DEFAULT 0,
    total_orphan_sponsor REAL DEFAULT 0,
    total_region_cap REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE charity_fund_txns (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    from_user_id TEXT,
    amount REAL NOT NULL,
    related_order_id TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE commission_reserve (
    id TEXT PRIMARY KEY,
    balance REAL DEFAULT 0,
    total_chain_gap REAL DEFAULT 0,
    total_orphan_sponsor REAL DEFAULT 0,
    total_region_cap REAL DEFAULT 0,
    total_disbursed REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE commission_reserve_txns (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    from_user_id TEXT,
    amount REAL NOT NULL,
    related_order_id TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE users (id TEXT PRIMARY KEY, region TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, total_amount REAL, buyer_region TEXT, snapshot_commission_rate REAL, settled_commission_at TEXT, l1_uid TEXT, l2_uid TEXT, l3_uid TEXT);
  CREATE TABLE region_change_log (id TEXT PRIMARY KEY, user_id TEXT, from_region TEXT, to_region TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
`)
db.prepare("INSERT INTO charity_fund (id) VALUES ('main')").run()
db.prepare("INSERT INTO commission_reserve (id) VALUES ('main')").run()

// 配置地区
db.prepare(`INSERT INTO region_config VALUES ('global', 3, 1, 1)`).run()
db.prepare(`INSERT INTO region_config VALUES ('china', 2, 1, 1)`).run()
db.prepare(`INSERT INTO region_config VALUES ('no_mlm_land', 0, 1, 0)`).run()  // 完全禁 MLM

// ─── 1. userMlmGate 返回值正确 ────────────────────────────────
function userMlmGate(userRegion: string): { payoutLevels: 0|1|2|3; mlmUiVisible: boolean } {
  const row = db.prepare(`SELECT max_levels, mlm_ui_visible FROM region_config WHERE region = ?`).get(userRegion) as { max_levels: number; mlm_ui_visible: number } | undefined
  const payoutLevels = (row?.max_levels ?? 3) as 0|1|2|3
  const mlmUiVisible = payoutLevels > 0 && (row?.mlm_ui_visible ?? 1) === 1
  return { payoutLevels, mlmUiVisible }
}
const g1 = userMlmGate('global')
expect('global: payoutLevels=3 mlmUiVisible=true', g1.payoutLevels === 3 && g1.mlmUiVisible === true)
const g2 = userMlmGate('china')
expect('china: payoutLevels=2 mlmUiVisible=true', g2.payoutLevels === 2 && g2.mlmUiVisible === true)
const g3 = userMlmGate('no_mlm_land')
expect('no_mlm_land: payoutLevels=0 mlmUiVisible=false', g3.payoutLevels === 0 && g3.mlmUiVisible === false)
const g4 = userMlmGate('unknown_region')
expect('未知地区 fallback: payoutLevels=3 mlmUiVisible=true', g4.payoutLevels === 3 && g4.mlmUiVisible === true)

// ─── 2. settleCommission max_levels=0 → 整池入 commission_reserve（三级公池，2026-06-04 解耦）──
type CommissionRedirectKind = 'redirect_chain_gap' | 'redirect_orphan_sponsor' | 'redirect_region_cap'
function redirectToCommissionReserve(amount: number, kind: CommissionRedirectKind, args: { orderId?: string; note?: string } = {}) {
  if (!Number.isFinite(amount) || amount <= 0) return
  const a = Math.round(amount * 100) / 100
  const totalCol = kind === 'redirect_chain_gap' ? 'total_chain_gap'
    : kind === 'redirect_orphan_sponsor' ? 'total_orphan_sponsor'
    : 'total_region_cap'
  db.transaction(() => {
    db.prepare(`UPDATE commission_reserve SET balance = balance + ?, ${totalCol} = ${totalCol} + ?, updated_at = datetime('now') WHERE id = 'main'`).run(a, a)
    db.prepare(`INSERT INTO commission_reserve_txns (id, kind, amount, related_order_id, note) VALUES (?,?,?,?,?)`).run(generateId('crt'), kind, a, args.orderId || null, args.note || null)
  })()
}

function getRegionMaxLevels(region: string): number {
  const row = db.prepare(`SELECT max_levels FROM region_config WHERE region = ?`).get(region) as { max_levels: number } | undefined
  return row?.max_levels ?? 3
}

const LEVEL_RATES: Record<number, number> = { 1: 0.70, 2: 0.20, 3: 0.10 }

// 复刻 settleCommission (2026-06-04 解耦后：兜底入 commission_reserve，redirected 恒 0)
function settleCommission(orderId: string): { pool: number; redirected: number } {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown> | undefined
  if (!order || order.settled_commission_at) return { pool: 0, redirected: 0 }
  const total = Number(order.total_amount || 0)
  const rate = Number(order.snapshot_commission_rate ?? 0.10)
  const region = (order.buyer_region as string) || 'global'
  const maxLevels = getRegionMaxLevels(region)
  const pool = Math.round(total * rate * 100) / 100

  if (maxLevels === 0) {
    redirectToCommissionReserve(pool, 'redirect_region_cap', { orderId, note: '区域禁 MLM' })
    db.prepare("UPDATE orders SET settled_commission_at = datetime('now') WHERE id = ?").run(orderId)
    return { pool, redirected: 0 }  // 入 commission_reserve，不回 global_fund
  }
  // 简化：只测 max_levels 截断 → commission_reserve
  const recipients = [{ level: 1, uid: order.l1_uid }, { level: 2, uid: order.l2_uid }, { level: 3, uid: order.l3_uid }]
  for (const { level, uid } of recipients) {
    const amount = Math.round(pool * LEVEL_RATES[level] * 100) / 100
    if (level > maxLevels) { redirectToCommissionReserve(amount, 'redirect_region_cap', { orderId, note: `L${level} 截断` }) }
    // (简化：不实际付款，只测路由)
  }
  db.prepare("UPDATE orders SET settled_commission_at = datetime('now') WHERE id = ?").run(orderId)
  return { pool, redirected: 0 }  // commission 不再回流 global_fund
}

// 订单 in no_mlm_land
db.prepare(`INSERT INTO orders VALUES ('ord_nml','buyer1',100,'no_mlm_land',0.1,NULL,NULL,NULL,NULL)`).run()
const r1 = settleCommission('ord_nml')
expect('max_levels=0 → pool=10 redirected=0（全池入 reserve，不回 global_fund）', r1.pool === 10 && r1.redirected === 0)

const cr1 = db.prepare(`SELECT balance, total_region_cap FROM commission_reserve WHERE id='main'`).get() as { balance: number; total_region_cap: number }
expect('commission_reserve.balance = 10', cr1.balance === 10)
expect('commission_reserve.total_region_cap = 10', cr1.total_region_cap === 10)

// 慈善基金纯净：佣金兜底【不】入 charity_fund
const cfPure = db.prepare(`SELECT balance FROM charity_fund WHERE id='main'`).get() as { balance: number }
expect('charity_fund 纯净（佣金兜底不入慈善）= 0', cfPure.balance === 0)

const txn1 = db.prepare(`SELECT kind, amount FROM commission_reserve_txns ORDER BY created_at DESC LIMIT 1`).get() as { kind: string; amount: number }
expect('txn kind = redirect_region_cap', txn1.kind === 'redirect_region_cap')
expect('txn amount = 10', txn1.amount === 10)

// 幂等：同 order 再调一次不重复入账
settleCommission('ord_nml')
const cr2 = db.prepare(`SELECT balance FROM commission_reserve WHERE id='main'`).get() as { balance: number }
expect('幂等：第二次不重复入账', cr2.balance === 10)

// 正常地区 (china, max_levels=2) — pool 正常派发，L3 截断进 commission_reserve
db.prepare(`INSERT INTO orders VALUES ('ord_cn','buyer1',100,'china',0.1,NULL,'u1','u2',NULL)`).run()
const r2 = settleCommission('ord_cn')
expect('china max_levels=2 pool=10 redirected=0（L3 截断入 reserve）', r2.pool === 10 && r2.redirected === 0)
// commission_reserve +1（china 的 L3 10% = 1）；charity 仍 0
const cr3 = db.prepare(`SELECT balance FROM commission_reserve WHERE id='main'`).get() as { balance: number }
expect('china L3 截断入 commission_reserve（10+1=11）', cr3.balance === 11)
const cfStill0 = db.prepare(`SELECT balance FROM charity_fund WHERE id='main'`).get() as { balance: number }
expect('charity_fund 始终纯净 = 0', cfStill0.balance === 0)

// ─── 3. region 切换 30 天冷却 ────────────────────────────────
db.prepare(`INSERT INTO users VALUES ('usr_test', 'global')`).run()
function tryRegionChange(userId: string): { ok: boolean; error?: string; remainDays?: number } {
  const lastChange = db.prepare(`SELECT created_at FROM region_change_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).get(userId) as { created_at: string } | undefined
  if (lastChange) {
    const sinceMs = Date.now() - new Date(lastChange.created_at + 'Z').getTime()
    const COOLDOWN_MS = 30 * 24 * 3600 * 1000
    if (sinceMs < COOLDOWN_MS) {
      return { ok: false, error: 'cooldown', remainDays: Math.ceil((COOLDOWN_MS - sinceMs) / (24 * 3600_000)) }
    }
  }
  db.prepare(`INSERT INTO region_change_log (id, user_id, from_region, to_region, ip) VALUES (?,?,?,?,?)`).run(generateId('rcl'), userId, 'global', 'us', null)
  return { ok: true }
}

// 首次切换 → 成功
const r3a = tryRegionChange('usr_test')
expect('首次 region 切换成功', r3a.ok === true)

// 立刻再切 → 冷却
const r3b = tryRegionChange('usr_test')
expect('立即再切 → cooldown 拒绝', r3b.ok === false && r3b.error === 'cooldown')
expect('冷却剩余天数 = 30', r3b.remainDays === 30)

// 模拟 31 天前记录 → 允许再切
db.prepare(`INSERT INTO region_change_log (id, user_id, from_region, to_region, ip, created_at)
  VALUES (?,?,?,?,?,datetime('now','-31 days'))`).run(generateId('rcl'), 'usr_test2', 'global', 'china', null)
const r3c = tryRegionChange('usr_test2')
expect('31 天前的记录 → 可以再切', r3c.ok === true)

// ─── 4. commission_reserve 科目分项不串（在 reserve，非 charity）──
redirectToCommissionReserve(5, 'redirect_chain_gap')
redirectToCommissionReserve(3, 'redirect_orphan_sponsor')
const cf4 = db.prepare(`SELECT total_region_cap, total_chain_gap, total_orphan_sponsor FROM commission_reserve WHERE id='main'`).get() as { total_region_cap: number; total_chain_gap: number; total_orphan_sponsor: number }
expect('total_region_cap 仍 11（10 整池 + 1 china L3，未被其他 kind 污染）', cf4.total_region_cap === 11)
expect('total_chain_gap = 5', cf4.total_chain_gap === 5)
expect('total_orphan_sponsor = 3', cf4.total_orphan_sponsor === 3)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
