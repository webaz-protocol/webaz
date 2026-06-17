// #1106 — PV escrow 池守恒单测
// 不变式：pool_balance + pv_escrow_reserve + Σwallets = 常量（PV 奖励不凭空增减）
// 复刻 runBinarySettlement escrow 分支 / rewards-apply claim / escrow-expire 三处的 pool↔reserve 流转。
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE global_fund (id INTEGER PRIMARY KEY CHECK(id=1), pool_balance REAL DEFAULT 0, pv_escrow_reserve REAL DEFAULT 0);
  CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, earned REAL DEFAULT 0);
  CREATE TABLE pending_commission_escrow (
    id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_user_id TEXT, order_id TEXT, amount REAL,
    attribution_path TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, expires_at INTEGER, settled_at INTEGER
  );
`)
db.prepare("INSERT INTO global_fund (id, pool_balance) VALUES (1, 100)").run()

const fundTotal = () => {
  const g = db.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }
  const w = (db.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM wallets").get() as { s: number }).s
  return Math.round((g.pool_balance + g.pv_escrow_reserve + w) * 100) / 100
}
const INITIAL = fundTotal()
expect('初始 pool=100, total=100', INITIAL === 100)

// ─── 复刻：settlement 中 opt-out 待激活 → escrow（pool→reserve）──
function settleEscrow(userId: string, amount: number) {
  db.transaction(() => {
    const now = Date.now()
    db.prepare(`INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at) VALUES (?, NULL, ?, 'pv_pair', 'pending', ?, ?)`)
      .run(userId, amount, now, now + 30 * 86400 * 1000)
    db.prepare("UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve + ? WHERE id=1").run(amount)
    // cashDistributed += amount 的效果：结算末尾 pool = start - cashDistributed
    db.prepare("UPDATE global_fund SET pool_balance = pool_balance - ? WHERE id=1").run(amount)
  })()
}
// ─── 复刻：opt-in 兑付（reserve→wallet）──
function claimReal(userId: string) {
  const rows = db.prepare("SELECT id, amount, attribution_path FROM pending_commission_escrow WHERE recipient_user_id=? AND status='pending'").all(userId) as Array<{ id: number; amount: number; attribution_path: string }>
  for (const p of rows) {
    const upd = db.prepare("UPDATE pending_commission_escrow SET status='settled' WHERE id=? AND status='pending'").run(p.id)
    if (upd.changes === 0) continue
    db.prepare("INSERT INTO wallets (user_id, balance, earned) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=balance+?, earned=earned+?").run(userId, p.amount, p.amount, p.amount, p.amount)
    if (p.attribution_path === 'pv_pair') db.prepare("UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve - ? WHERE id=1").run(p.amount)
  }
}
// ─── 复刻：到期（reserve→pool）──
function expire(userId: string) {
  const rows = db.prepare("SELECT id, amount, attribution_path FROM pending_commission_escrow WHERE recipient_user_id=? AND status='pending'").all(userId) as Array<{ id: number; amount: number; attribution_path: string }>
  for (const p of rows) {
    const upd = db.prepare("UPDATE pending_commission_escrow SET status='expired' WHERE id=? AND status='pending'").run(p.id)
    if (upd.changes === 0) continue
    if (p.attribution_path === 'pv_pair') db.prepare("UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve - ?, pool_balance = pool_balance + ? WHERE id=1").run(p.amount, p.amount)
  }
}

// ── 场景 1：escrow 创建 → pool 减、reserve 增、total 不变 ──
settleEscrow('alice', 10)
let g1 = db.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }
expect('escrow 后 pool=90', g1.pool_balance === 90)
expect('escrow 后 reserve=10', g1.pv_escrow_reserve === 10)
expect('escrow 后 total 守恒=100', fundTotal() === 100)

// ── 场景 2：opt-in 兑付 → reserve→wallet，total 守恒 ──
claimReal('alice')
let g2 = db.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }
const aliceBal = (db.prepare("SELECT balance FROM wallets WHERE user_id='alice'").get() as { balance: number }).balance
expect('兑付后 alice 钱包=10', aliceBal === 10)
expect('兑付后 reserve=0', g2.pv_escrow_reserve === 0)
expect('兑付后 pool 仍=90（不再被二次扣/印）', g2.pool_balance === 90)
expect('兑付后 total 守恒=100', fundTotal() === 100)

// ── 场景 3：另一笔 escrow 到期 → reserve→pool，total 守恒 ──
settleEscrow('bob', 20)
expect('bob escrow 后 total 守恒=100', fundTotal() === 100)
expire('bob')
let g3 = db.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }
expect('bob 到期后 reserve=0', g3.pv_escrow_reserve === 0)
expect('bob 到期后 pool 退回=90', g3.pool_balance === 90)  // 90(claim后) -20(bob escrow) +20(到期退回) = 90
const bobBal = (db.prepare("SELECT COALESCE(balance,0) AS b FROM wallets WHERE user_id='bob'").get() as { b: number } | undefined)?.b ?? 0
expect('bob 到期未兑付，钱包=0', bobBal === 0)
expect('bob 到期后 total 守恒=100', fundTotal() === 100)

// ── 关键回归：旧 bug 下 claim 会让 total>100（印钱）。现在不会。──
expect('最终 total 严格守恒=100（无凭空印钱）', fundTotal() === 100)

// ─── Codex #69：pv_escrow_reserve 回填迁移 —— 按 delta 对账(不全量 SUM 再转)。
//     升级窗口混存:加列【前】的历史 pending pv_pair 未进 reserve;加列【后】新建的已进 reserve。
//     reserve 目标 = 当前所有 pending pv_pair 负债;只补 delta = liability - currentReserve 的正数。
//     复刻 server.ts 回填 SQL(若那段改了,这里同步)。
function freshMigDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE global_fund (id INTEGER PRIMARY KEY CHECK(id=1), pool_balance REAL DEFAULT 0, pv_escrow_reserve REAL DEFAULT 0);
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, earned REAL DEFAULT 0);
    CREATE TABLE pending_commission_escrow (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_user_id TEXT, order_id TEXT, amount REAL,
      attribution_path TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, expires_at INTEGER, settled_at INTEGER);
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
  `)
  return d
}
function runBackfill(d: Database.Database): void {  // 镜像 server.ts pv_escrow_reserve backfill(delta 对账)
  const done = d.prepare("SELECT value FROM system_state WHERE key = 'pv_escrow_reserve_backfilled'").get() as { value: string } | undefined
  if (done) return
  d.transaction(() => {
    const liability = (d.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM pending_commission_escrow WHERE status='pending' AND attribution_path='pv_pair'`).get() as { s: number }).s
    const gf = d.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }
    const pool = gf.pool_balance, currentReserve = gf.pv_escrow_reserve
    const delta = Math.round((liability - currentReserve) * 100) / 100
    if (delta > 0) {
      d.prepare("UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve + ?, pool_balance = pool_balance - ? WHERE id=1").run(delta, delta)
      if (pool < delta) d.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('pv_escrow_reserve_backfill_shortfall', ?)").run(String(Math.round((delta - pool) * 100) / 100))
    } else if (delta < 0) {
      d.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('pv_escrow_reserve_backfill_anomaly', ?)").run(String(Math.round((currentReserve - liability) * 100) / 100))
    }
    d.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('pv_escrow_reserve_backfilled', '1')").run()
  })()
}
const migTotal = (d: Database.Database) => {
  const g = d.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }
  const w = (d.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM wallets").get() as { s: number }).s
  return Math.round((g.pool_balance + g.pv_escrow_reserve + w) * 100) / 100
}
const ins = (d: Database.Database, uid: string, amount: number, exp = 9999999999) =>
  d.prepare("INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at) VALUES (?, NULL, ?, 'pv_pair', 'pending', 0, ?)").run(uid, amount, exp)
const gf = (d: Database.Database) => d.prepare("SELECT pool_balance, pv_escrow_reserve FROM global_fund WHERE id=1").get() as { pool_balance: number; pv_escrow_reserve: number }

// ── 场景 4(Codex 核心):混存 —— pool=90, reserve=10, pending pv_pair 总额=15(10 已隔离 + 5 历史未隔离)──
//    delta=15-10=5 → 只补 5:pool 90→85, reserve 10→15(绝不 pool=75/reserve=25 把已隔离的再扣一次)。
{
  const d = freshMigDb()
  d.prepare("INSERT INTO global_fund (id, pool_balance, pv_escrow_reserve) VALUES (1, 90, 10)").run()
  ins(d, 'isolated', 10); ins(d, 'historical', 5)   // 总 pending=15;reserve 里已有 10 对应 isolated
  expect('场景4 迁移前 total(pool+reserve+wallets)=100', migTotal(d) === 100)
  runBackfill(d)
  expect('场景4 回填后 pool=85(只扣 delta 5)', gf(d).pool_balance === 85, gf(d))
  expect('场景4 回填后 reserve=15(=总负债)', gf(d).pv_escrow_reserve === 15, gf(d))
  expect('场景4 回填后 total 守恒=100', migTotal(d) === 100)
  runBackfill(d)   // 幂等
  expect('场景4 幂等:二次回填 pool 仍=85 / reserve 仍=15', gf(d).pool_balance === 85 && gf(d).pv_escrow_reserve === 15, gf(d))
}

// ── 场景 5:纯历史(reserve=0)pending pv_pair 10, pool=100 → pool=90, reserve=10;之后兑付 reserve→0,守恒 ──
{
  const d = freshMigDb()
  d.prepare("INSERT INTO global_fund (id, pool_balance, pv_escrow_reserve) VALUES (1, 100, 0)").run()
  ins(d, 'carol', 10)
  runBackfill(d)
  expect('场景5 回填后 pool=90 / reserve=10', gf(d).pool_balance === 90 && gf(d).pv_escrow_reserve === 10, gf(d))
  expect('场景5 回填后 total 守恒=100', migTotal(d) === 100)
  // 兑付:reserve→wallet
  const p = d.prepare("SELECT id, amount FROM pending_commission_escrow WHERE recipient_user_id='carol'").get() as { id: number; amount: number }
  d.prepare("UPDATE pending_commission_escrow SET status='settled' WHERE id=?").run(p.id)
  d.prepare("INSERT INTO wallets (user_id, balance, earned) VALUES ('carol', ?, ?)").run(p.amount, p.amount)
  d.prepare("UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve - ? WHERE id=1").run(p.amount)
  expect('场景5 兑付后 reserve=0(不变负)', gf(d).pv_escrow_reserve === 0, gf(d))
  expect('场景5 兑付后 total 守恒=100', migTotal(d) === 100)
}

// ── 场景 6:已完全对齐(reserve 已=负债)→ delta=0,不动账 ──
{
  const d = freshMigDb()
  d.prepare("INSERT INTO global_fund (id, pool_balance, pv_escrow_reserve) VALUES (1, 80, 20)").run()
  ins(d, 'frank', 20)   // 负债 20 == reserve 20
  runBackfill(d)
  expect('场景6 delta=0:pool/reserve 不动(80/20)', gf(d).pool_balance === 80 && gf(d).pv_escrow_reserve === 20, gf(d))
  expect('场景6 total 守恒=100', migTotal(d) === 100)
}

// ── 场景 7:pool 不足覆盖 delta → 仍转账(守恒),记 shortfall(基于 delta 非 liability)──
{
  const d = freshMigDb()
  d.prepare("INSERT INTO global_fund (id, pool_balance, pv_escrow_reserve) VALUES (1, 4, 6)").run()  // reserve 已有 6
  ins(d, 'grace', 16)   // 负债 16;delta=16-6=10;pool 4 < 10
  runBackfill(d)
  expect('场景7 reserve 补到负债=16', gf(d).pv_escrow_reserve === 16, gf(d))
  expect('场景7 pool 转负=-6(4-10),total 守恒=10', gf(d).pool_balance === -6 && migTotal(d) === 10, gf(d))
  const sf = d.prepare("SELECT value FROM system_state WHERE key='pv_escrow_reserve_backfill_shortfall'").get() as { value: string } | undefined
  expect('场景7 shortfall=6 基于 delta(10)-pool(4),非 liability', sf?.value === '6', sf)
}

// ── 场景 8:reserve 超额(> 负债)→ 不反向移动,只记 anomaly ──
{
  const d = freshMigDb()
  d.prepare("INSERT INTO global_fund (id, pool_balance, pv_escrow_reserve) VALUES (1, 70, 30)").run()
  ins(d, 'heidi', 20)   // 负债 20 < reserve 30 → delta=-10
  runBackfill(d)
  expect('场景8 delta<0:不反向移动(pool 70 / reserve 30 不变)', gf(d).pool_balance === 70 && gf(d).pv_escrow_reserve === 30, gf(d))
  const an = d.prepare("SELECT value FROM system_state WHERE key='pv_escrow_reserve_backfill_anomaly'").get() as { value: string } | undefined
  expect('场景8 记 anomaly=10 供核账', an?.value === '10', an)
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
