// 资金精度对抗测试 —— 用"除不尽"的金额跑真实 settleFault,验证整数 base-unit 账本(RFC-014)。
// RFC-014 PR2 后 settleFault 已港口到整数 base-units + allocate 精确分配 + 绝对值落库:
//   ① 聚合守恒用【整数单位】求和 → 残差精确 0(不靠 float 容差)。
//   ② 每个钱包落库值必须是 base-unit 整数倍(v === toDecimal(toUnits(v)))→ 零 dust【硬门】。
// (旧判据"≠2位round"已过时:6dp 是合法精度,旧代码强行截 2 位才丢 sub-cent。)
import Database from 'better-sqlite3'
import { settleFault } from '../src/layer0-foundation/L0-2-state-machine/engine.js'
import { toUnits, toDecimal } from '../src/money.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, staked REAL DEFAULT 0, escrowed REAL DEFAULT 0, earned REAL DEFAULT 0);
    CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, buyer_id TEXT, seller_id TEXT, product_id TEXT, logistics_id TEXT,
      total_amount REAL, source TEXT DEFAULT 'shop', stake_backing REAL DEFAULT 0, bid_stake_held REAL DEFAULT 0,
      l1_uid TEXT, l2_uid TEXT, l3_uid TEXT, snapshot_commission_rate REAL, settled_fault_at TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, stock INTEGER DEFAULT 0);
    CREATE TABLE secondhand_items (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT);
    CREATE TABLE commission_reserve (id TEXT PRIMARY KEY, balance REAL DEFAULT 0, total_chain_gap REAL DEFAULT 0, total_region_cap REAL DEFAULT 0, total_orphan_sponsor REAL DEFAULT 0, updated_at TEXT);
    CREATE TABLE commission_reserve_txns (id TEXT PRIMARY KEY, kind TEXT, from_user_id TEXT, amount REAL, related_order_id TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE protocol_params (key TEXT PRIMARY KEY, value TEXT);
  `)
  db.prepare("INSERT INTO commission_reserve (id, balance) VALUES ('main', 0)").run()
  db.prepare("INSERT INTO protocol_params (key, value) VALUES ('protocol_fee_rate_shop','0.02'),('protocol_fee_rate_secondhand','0.01'),('fault_penalty_rate','0.30')").run()
  return db
}
// 聚合守恒的硬标准:用【整数 base-units】求和 → 残差精确 0(不靠 float 容差掩盖)。
const rawTotalUnits = (db: Database.Database): number => {
  const ws = db.prepare('SELECT COALESCE(balance,0) balance, COALESCE(staked,0) staked, COALESCE(escrowed,0) escrowed FROM wallets').all() as any[]
  let u = 0
  for (const w of ws) u += toUnits(w.balance) + toUnits(w.staked) + toUnits(w.escrowed)
  const cr = (db.prepare("SELECT balance FROM commission_reserve WHERE id='main'").get() as { balance: number }).balance
  return u + toUnits(cr)
}
// dust 判据(RFC-014 新不变量):落库值必须是 base-unit 整数倍,即 v === toDecimal(toUnits(v))。
const isClean = (v: number) => v === toDecimal(toUnits(v))
const dustWallets = (db: Database.Database) => (db.prepare('SELECT user_id, balance, staked, escrowed FROM wallets').all() as any[])
  .filter(w => [w.balance, w.staked, w.escrowed].some(v => !isClean(v)))
  .map(w => ({ u: w.user_id, balance: w.balance, staked: w.staked, escrowed: w.escrowed }))

// 对抗场景:除不尽的额度 + 奇数费率 → 制造分不尽的 cent
const cases = [
  { id: 'X1', total: 33.33,  backing: 5.55,  rate: 0.07 },
  { id: 'X2', total: 99.99,  backing: 33.33, rate: 0.03 },
  { id: 'X3', total: 100.01, backing: 10.10, rate: 0.07 },
  { id: 'X4', total: 7.77,   backing: 1.11,  rate: 0.05 },
  { id: 'X5', total: 1234.56, backing: 185.18, rate: 0.0725 },
]

let maxResidual = 0, dustCount = 0
for (const c of cases) {
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',1000,?,0),('buyer',0,0,?),('sys_protocol',0,0,0),('l1',0,0,0),('l2',0,0,0),('l3',0,0,0)").run(c.backing, c.total)
  db.prepare("INSERT INTO products (id, stock) VALUES (?, 0)").run('p_' + c.id)
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,l1_uid,l2_uid,l3_uid,snapshot_commission_rate) VALUES (?,'paid','buyer','seller',?,?,'shop',?,'l1','l2','l3',?)")
    .run('o_' + c.id, 'p_' + c.id, c.total, c.backing, c.rate)
  const before = rawTotalUnits(db)
  settleFault(db, 'o_' + c.id, 'fault_seller')
  const after = rawTotalUnits(db)
  const residual = Math.abs(after - before)
  maxResidual = Math.max(maxResidual, residual)
  const dust = dustWallets(db)
  dustCount += dust.length
  console.log(`  [${c.id}] total=${c.total} rate=${c.rate} → 守恒残差=${residual.toExponential(3)} · 浮点尘钱包=${dust.length}${dust.length ? ' ' + JSON.stringify(dust) : ''}`)
}

console.log(`\n=== 诊断结论 ===`)
console.log(`  最大聚合守恒残差(整数单位): ${maxResidual} base-units`)
console.log(`  带 dust 的钱包数(非 base-unit 整数倍): ${dustCount} / ${cases.length} 场景`)
// 硬不变量①(违反则 exit 1):整数单位聚合守恒精确 —— 不增发/不丢钱,残差必须 === 0。
expect('聚合守恒精确(整数 base-units):残差 === 0', maxResidual === 0, { maxResidual })
// 硬不变量②(RFC-014 PR2,settleFault 已港口):每个落库钱包值都是 base-unit 整数倍 → 零 dust。
expect('零 dust:所有钱包值 === toDecimal(toUnits(v))', dustCount === 0, { dustCount })

console.log(`\n${pass} pass · ${fail} fail (FINDING 不计入 fail)`)
if (fail > 0) process.exit(1)
