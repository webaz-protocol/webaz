#!/usr/bin/env tsx
/**
 * WAZ 退役 PR-A2 — 清零引擎回归锁(src/waz-sunset-store.ts)。
 * Proves:
 *   ① fail-closed 盘点:escrowed>0 / 非终态 escrow 单 / open RFQ/拍卖/团购 / active bid 押金 /
 *     pending 提现 → 全部列为 blocker;commit 硬拒(零写入)。
 *   ② dry-run 幂等零写入:钱包原样、冲正表空。
 *   ③ commit:balance/staked/earned/fee_staked 全部经 applyWalletDelta 负 delta 归零;每笔一行
 *     append-only 冲正(before/delta 快照);单事务;历史流水(charity_fund_txns)原封不动。
 *   ④ 幂等:二次 commit nothing-to-do(零新冲正行);校验 residual=空。
 *   ⑤ 基金池默认不动;--include-funds 才清零并记 fund:* 冲正。
 *   ⑥ 冲正台账 append-only:UPDATE/DELETE 被触发器 ABORT。
 * Usage: npm run test:waz-sunset-script
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'wazsunset-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { runWazSunsetZeroing, wazSunsetInventory, initWazSunsetSchema } = await import('../src/waz-sunset-store.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
// 盘点扫描面的 server-inline 表(最小 fixture 镜像建表)
db.exec(`CREATE TABLE IF NOT EXISTS rfqs (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open');
  CREATE TABLE IF NOT EXISTS bids (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', stake_locked REAL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS auctions (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open');
  CREATE TABLE IF NOT EXISTS auction_bids (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', stake_locked REAL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS group_buys (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS withdrawal_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending');
  CREATE TABLE IF NOT EXISTS charity_fund (id TEXT PRIMARY KEY, balance REAL DEFAULT 0, total_donated REAL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS charity_fund_txns (id TEXT PRIMARY KEY, kind TEXT, amount REAL)`)
try { db.exec('ALTER TABLE orders ADD COLUMN payment_rail TEXT') } catch { /* 已存在 */ }

const mkWallet = (id: string, w: { balance?: number; staked?: number; escrowed?: number; earned?: number; fee_staked?: number }): void => {
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES (?,?,'buyer',?)").run(id, id, 'k_' + id)
  db.prepare('INSERT INTO wallets (user_id, balance, staked, escrowed, earned, fee_staked) VALUES (?,?,?,?,?,?)')
    .run(id, w.balance ?? 0, w.staked ?? 0, w.escrowed ?? 0, w.earned ?? 0, w.fee_staked ?? 0)
}
mkWallet('u1', { balance: 100.5, earned: 250 })
mkWallet('u2', { balance: 3.14, staked: 7, fee_staked: 2 })
mkWallet('u3', { escrowed: 10 })                                     // ← blocker
db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail) VALUES ('ordX','p','u1','u2',1,10,10,10,'paid','escrow')").run()   // ← blocker
db.prepare("INSERT INTO rfqs (id,status) VALUES ('rfqX','open')").run()                                  // ← blocker
db.prepare("INSERT INTO bids (id,status,stake_locked) VALUES ('bidX','active',3)").run()                 // ← blocker
db.prepare("INSERT INTO withdrawal_requests (id,status) VALUES ('wdX','pending')").run()                 // ← blocker
db.prepare("INSERT INTO charity_fund (id,balance) VALUES ('main',42)").run()
db.prepare("INSERT INTO charity_fund_txns (id,kind,amount) VALUES ('cft1','donation',42)").run()

// ── ① 盘点 + commit 硬拒 ──
const inv = wazSunsetInventory(db)
const kinds = new Set(inv.map(b => b.kind))
ok('inventory: all five blocker kinds detected', ['wallet_escrowed', 'order_in_flight', 'rfq_open', 'bid_stake_active', 'withdrawal_pending'].every(k => kinds.has(k)), JSON.stringify([...kinds]))
let threw = false
try { runWazSunsetZeroing(db, { runId: 'r0', reason: 't', commit: true }) } catch { threw = true }
const w1 = db.prepare("SELECT balance FROM wallets WHERE user_id='u1'").get() as { balance: number }
ok('commit with blockers → hard-refused, zero writes', threw && w1.balance === 100.5 && (db.prepare('SELECT COUNT(*) n FROM waz_sunset_corrections').get() as { n: number }).n === 0)

// ── 收敛全部 blocker(模拟正常状态机收敛后的世界)──
db.prepare("UPDATE wallets SET escrowed=0 WHERE user_id='u3'").run()
db.prepare("UPDATE orders SET status='completed' WHERE id='ordX'").run()
db.prepare("UPDATE rfqs SET status='expired' WHERE id='rfqX'").run()
db.prepare("UPDATE bids SET status='cancelled' WHERE id='bidX'").run()
db.prepare("UPDATE withdrawal_requests SET status='rejected' WHERE id='wdX'").run()
ok('inventory clean after convergence', wazSunsetInventory(db).length === 0, JSON.stringify(wazSunsetInventory(db)))

// ── ② dry-run 零写入 ──
const dry = runWazSunsetZeroing(db, { runId: 'r1', reason: 'dry', commit: false })
ok('dry-run: plan enumerates every nonzero field, nothing written',
  dry.committed === false && dry.plan.length === 5   // u1:balance+earned, u2:balance+staked+fee_staked
  && (db.prepare("SELECT balance FROM wallets WHERE user_id='u1'").get() as { balance: number }).balance === 100.5
  && (db.prepare('SELECT COUNT(*) n FROM waz_sunset_corrections').get() as { n: number }).n === 0, JSON.stringify(dry.plan))

// ── ③ commit ──
const res = runWazSunsetZeroing(db, { runId: 'r2', reason: 'WAZ sunset test', commit: true })
const allW = db.prepare('SELECT user_id, balance, staked, escrowed, earned, fee_staked FROM wallets ORDER BY user_id').all() as Array<Record<string, number>>
ok('commit: every wallet field zeroed', allW.every(w => Number(w.balance) === 0 && Number(w.staked) === 0 && Number(w.escrowed) === 0 && Number(w.earned) === 0 && Number(w.fee_staked) === 0), JSON.stringify(allW))
const corr = db.prepare("SELECT subject, field, before_units, delta_units, reason FROM waz_sunset_corrections WHERE run_id='r2' ORDER BY id").all() as Array<Record<string, unknown>>
ok('commit: one append-only correction per zeroed field with before/delta snapshot',
  corr.length === 5 && corr.every(c => Number(c.before_units) > 0 && Number(c.delta_units) === -Number(c.before_units) && c.reason === 'WAZ sunset test'), JSON.stringify(corr))
ok('commit: residual verify = all zero', res.residual.length === 0, JSON.stringify(res.residual))
ok('history txns untouched (charity_fund_txns row intact)', (db.prepare("SELECT COUNT(*) n FROM charity_fund_txns WHERE id='cft1'").get() as { n: number }).n === 1)
ok('fund pools untouched by default (charity_fund.balance stays 42)', (db.prepare("SELECT balance FROM charity_fund WHERE id='main'").get() as { balance: number }).balance === 42)

// ── ④ 幂等 ──
const again = runWazSunsetZeroing(db, { runId: 'r3', reason: 're-run', commit: true })
ok('idempotent: second commit is nothing-to-do (zero new corrections)', again.plan.length === 0 && (db.prepare("SELECT COUNT(*) n FROM waz_sunset_corrections WHERE run_id='r3'").get() as { n: number }).n === 0)

// ── ⑤ --include-funds ──
const funds = runWazSunsetZeroing(db, { runId: 'r4', reason: 'funds too', includeFunds: true, commit: true })
ok('include-funds: charity_fund zeroed with fund:* correction',
  (db.prepare("SELECT balance FROM charity_fund WHERE id='main'").get() as { balance: number }).balance === 0
  && funds.plan.some(p => p.subject === 'fund:charity_fund' && p.field === 'balance')
  && (db.prepare("SELECT COUNT(*) n FROM waz_sunset_corrections WHERE run_id='r4' AND subject='fund:charity_fund'").get() as { n: number }).n === 1)

// ── ⑥ append-only 触发器 ──
initWazSunsetSchema(db)
let upThrew = false; let delThrew = false
try { db.prepare("UPDATE waz_sunset_corrections SET reason='tamper' WHERE run_id='r2'").run() } catch { upThrew = true }
try { db.prepare("DELETE FROM waz_sunset_corrections WHERE run_id='r2'").run() } catch { delThrew = true }
ok('corrections ledger is append-only (UPDATE/DELETE ABORT)', upThrew && delThrew)

if (fail > 0) { console.error(`\n❌ waz-sunset-script FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ waz-sunset-script: fail-closed inventory → atomic zeroing via applyWalletDelta + append-only corrections → residual verify; dry-run writes nothing; idempotent; funds opt-in\n  ✅ pass ${pass}`)
