// Codex #112 P1 — RFC-008 fee migration must clamp historical value>cap, not only tighten max_value.
//   Mirrors the migration in src/pwa/server.ts (RFC-008 block). If that SQL changes, update here.
//   Verifies: a drifted value (e.g. 0.05 under old max 0.20) is clamped back to the cap so runtime
//   getProtocolParam (which reads `value`) can never charge above the hard cap; log entries written;
//   the fund_base pre-launch waiver (0.01→0) only touches the untouched default.
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE protocol_params (key TEXT PRIMARY KEY, value TEXT, type TEXT, description TEXT, category TEXT,
      default_value TEXT, min_value REAL, max_value REAL, updated_at TEXT, updated_by TEXT, requires_meta_rule_change INTEGER DEFAULT 0);
    CREATE TABLE protocol_params_log (id TEXT PRIMARY KEY, key TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, action TEXT, created_at TEXT DEFAULT (datetime('now')));
  `)
  return db
}
// ── exact migration SQL (mirror of server.ts RFC-008 block) ──
let npl = 0
function runRfc008Migration(db: Database.Database) {
  db.prepare(`UPDATE protocol_params SET max_value = 0.02, updated_at = datetime('now')
    WHERE key IN ('protocol_fee_rate_shop','protocol_fee_rate_secondhand') AND max_value > 0.02`).run()
  db.prepare(`UPDATE protocol_params SET max_value = 0.01, updated_at = datetime('now')
    WHERE key = 'fund_base_rate' AND max_value > 0.01`).run()
  const clampFeeValue = (key: string, cap: number) => {
    const cur = db.prepare('SELECT value FROM protocol_params WHERE key = ? AND CAST(value AS REAL) > ?').get(key, cap) as { value: string } | undefined
    if (!cur) return
    db.prepare(`UPDATE protocol_params SET value = ?, updated_at = datetime('now') WHERE key = ? AND CAST(value AS REAL) > ?`).run(String(cap), key, cap)
    db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'migrate')`).run(`ppl_${++npl}`, key, cur.value, String(cap), 'migration_RFC-008')
  }
  clampFeeValue('protocol_fee_rate_shop', 0.02)
  clampFeeValue('protocol_fee_rate_secondhand', 0.02)
  clampFeeValue('fund_base_rate', 0.01)
  db.prepare(`UPDATE protocol_params SET value = '0', default_value = '0', updated_at = datetime('now')
    WHERE key = 'fund_base_rate' AND value = '0.01' AND updated_by IS NULL`).run()
  // Codex #111:require_seller_stake 是假开关 → max 锁 0 + 历史 value>0 降回 0
  db.prepare(`UPDATE protocol_params SET max_value = 0, updated_at = datetime('now') WHERE key = 'require_seller_stake' AND max_value > 0`).run()
  const rss = db.prepare(`SELECT value FROM protocol_params WHERE key = 'require_seller_stake' AND CAST(value AS REAL) > 0`).get() as { value: string } | undefined
  if (rss) {
    db.prepare(`UPDATE protocol_params SET value = '0', updated_at = datetime('now') WHERE key = 'require_seller_stake'`).run()
    db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'migrate')`).run(`ppl_${++npl}`, 'require_seller_stake', rss.value, '0', 'migration_RFC-008')
  }
}
const row = (db: Database.Database, k: string) => db.prepare('SELECT value, max_value FROM protocol_params WHERE key=?').get(k) as { value: string; max_value: number }
const logCount = (db: Database.Database, k: string) => (db.prepare("SELECT COUNT(*) AS n FROM protocol_params_log WHERE key=? AND action='migrate'").get(k) as { n: number }).n

// ── Scenario 1: governance had pushed values ABOVE the (now lower) cap ──
{
  const db = freshDb()
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('protocol_fee_rate_shop','0.05',0.20,'gov1')").run()
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('protocol_fee_rate_secondhand','0.01',0.20,NULL)").run()
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('fund_base_rate','0.05',0.10,'gov1')").run()
  runRfc008Migration(db)
  expect('shop: value 0.05→0.02 (Codex scenario)', row(db,'protocol_fee_rate_shop').value === '0.02', row(db,'protocol_fee_rate_shop'))
  expect('shop: max 0.20→0.02', row(db,'protocol_fee_rate_shop').max_value === 0.02)
  expect('secondhand: value 0.01 untouched (≤cap)', row(db,'protocol_fee_rate_secondhand').value === '0.01')
  expect('secondhand: max 0.20→0.02', row(db,'protocol_fee_rate_secondhand').max_value === 0.02)
  expect('fund_base: value 0.05→0.01 (clamped, NOT →0: governance-set)', row(db,'fund_base_rate').value === '0.01', row(db,'fund_base_rate'))
  expect('fund_base: max 0.10→0.01', row(db,'fund_base_rate').max_value === 0.01)
  expect('log: shop clamp recorded', logCount(db,'protocol_fee_rate_shop') === 1)
  expect('log: fund_base clamp recorded', logCount(db,'fund_base_rate') === 1)
  expect('log: secondhand NOT recorded (no clamp)', logCount(db,'protocol_fee_rate_secondhand') === 0)
}

// ── Scenario 2: pristine defaults — clamp no-ops, fund_base pre-launch waiver still fires ──
{
  const db = freshDb()
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('protocol_fee_rate_shop','0.02',0.02,NULL)").run()
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('fund_base_rate','0.01',0.01,NULL)").run()
  runRfc008Migration(db)
  expect('shop default 0.02 unchanged (not >cap)', row(db,'protocol_fee_rate_shop').value === '0.02')
  expect('fund_base pristine 0.01 → 0 (pre-launch waiver, not clamp)', row(db,'fund_base_rate').value === '0')
  expect('fund_base: no clamp log (waiver path, value was not >cap)', logCount(db,'fund_base_rate') === 0)
}

// ── Scenario 3: require_seller_stake false-switch neutralized (Codex #111) ──
{
  const db = freshDb()
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('require_seller_stake','1',1,'gov1')").run()
  runRfc008Migration(db)
  expect('require_seller_stake: value 1→0 (假开关中和)', row(db,'require_seller_stake').value === '0', row(db,'require_seller_stake'))
  expect('require_seller_stake: max 1→0 (不可再开启)', row(db,'require_seller_stake').max_value === 0)
  expect('require_seller_stake: clamp 记录在案', logCount(db,'require_seller_stake') === 1)
}
{
  const db = freshDb()  // default 0/0 → idempotent no-op
  db.prepare("INSERT INTO protocol_params (key,value,max_value,updated_by) VALUES ('require_seller_stake','0',0,NULL)").run()
  runRfc008Migration(db)
  expect('require_seller_stake default 0/0 unchanged + no log', row(db,'require_seller_stake').value === '0' && row(db,'require_seller_stake').max_value === 0 && logCount(db,'require_seller_stake') === 0)
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
