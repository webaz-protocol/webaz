// 争议结算守恒测试 —— 守住 executeSettlement 的 4 个裁定不漏钱(本 PR 修了 4 处"算了没入账"的蒸发漏)。
// 直接调真函数(executeSettlement / executeLiabilitySplit),最小 in-memory schema + transition 真跑。
import Database from 'better-sqlite3'
import { initOrderChainSchema } from '../src/layer0-foundation/L0-2-state-machine/order-chain.js'
import { executeSettlement, executeLiabilitySplit } from '../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import { toUnits } from '../src/money.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, name TEXT, api_key TEXT);
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, staked REAL DEFAULT 0, escrowed REAL DEFAULT 0, earned REAL DEFAULT 0);
    CREATE TABLE products (id TEXT PRIMARY KEY, stake_amount REAL DEFAULT 0);
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, status TEXT, buyer_id TEXT, seller_id TEXT, product_id TEXT, logistics_id TEXT,
      total_amount REAL, source TEXT DEFAULT 'shop', updated_at TEXT
    );
    CREATE TABLE order_state_history (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT,
      actor_id TEXT, actor_role TEXT, evidence_ids TEXT DEFAULT '[]', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
  `)
  initOrderChainSchema(db)
  db.prepare("INSERT INTO users VALUES ('sys_protocol','system','sys','K0')").run()
  db.prepare("INSERT INTO users VALUES ('buyer','buyer','b','K1')").run()
  db.prepare("INSERT INTO users VALUES ('seller','seller','s','K2')").run()
  db.prepare("INSERT INTO users VALUES ('liable','logistics','l','K3')").run()
  for (const u of ['sys_protocol', 'buyer', 'seller', 'liable']) db.prepare("INSERT INTO wallets (user_id) VALUES (?)").run(u)
  return db
}

const totalMoney = (db: Database.Database): number => {
  const ws = db.prepare('SELECT COALESCE(balance,0) b, COALESCE(staked,0) s, COALESCE(escrowed,0) e FROM wallets').all() as any[]
  return ws.reduce((acc, w) => acc + w.b + w.s + w.e, 0)
}
const r2 = (n: number) => Math.round(n * 100) / 100

// 用除不尽金额 + 奇数 stake 制造取整压力
function setupOrder(db: Database.Database, total: number, stake: number, opts: { logistics?: boolean; liableBal?: number } = {}) {
  db.prepare("INSERT INTO products VALUES ('prd', ?)").run(stake)
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,logistics_id,total_amount) VALUES ('ord','disputed','buyer','seller','prd',?,?)")
    .run(opts.logistics ? 'liable' : null, total)
  db.prepare("UPDATE wallets SET escrowed = ? WHERE user_id='buyer'").run(total)
  db.prepare("UPDATE wallets SET staked = ? WHERE user_id='seller'").run(stake)
  if (opts.liableBal) db.prepare("UPDATE wallets SET balance = ? WHERE user_id='liable'").run(opts.liableBal)
}

// ── refund_buyer:买家全退 + 卖家罚没【一半】质押(修复前漏退另一半 → 蒸发)──
{
  const db = freshDb(); setupOrder(db, 33.33, 5.55)
  const before = totalMoney(db)
  const res = executeSettlement(db, 'ord', 'refund_buyer')
  const after = totalMoney(db)
  const seller = db.prepare("SELECT balance,staked FROM wallets WHERE user_id='seller'").get() as any
  expect('refund_buyer 成功', res.success)
  expect('refund_buyer 守恒(残差≤1e-9)', Math.abs(after - before) <= 1e-9, { before, after })
  // 卖家净损恰好一半质押(整数港口后为精确二分;旧 2dp round 给的是 2.77,新为精确 2.775)
  expect('refund_buyer 卖家只损失一半质押(精确二分)', toUnits(seller.balance + seller.staked) === Math.round(toUnits(5.55) / 2), seller)
}

// ── release_seller:卖家胜诉,协议费【入金库】(修复前蒸发)──
for (const logistics of [false, true]) {
  const db = freshDb(); setupOrder(db, 99.99, 10, { logistics })
  const before = totalMoney(db)
  const res = executeSettlement(db, 'ord', 'release_seller')
  const after = totalMoney(db)
  const sys = db.prepare("SELECT balance FROM wallets WHERE user_id='sys_protocol'").get() as any
  expect(`release_seller 守恒 (logistics=${logistics})`, Math.abs(after - before) <= 1e-9, { before, after })
  expect(`release_seller 协议费入金库 (logistics=${logistics})`, r2(sys.balance) === r2(99.99 * 0.02), sys)
}

// ── partial_refund 协商:全额退质押(option a,无责不罚)──
{
  const db = freshDb(); setupOrder(db, 100.01, 8.88)
  const before = totalMoney(db)
  const res = executeSettlement(db, 'ord', 'partial_refund', 40.00)
  const after = totalMoney(db)
  const seller = db.prepare("SELECT balance,staked FROM wallets WHERE user_id='seller'").get() as any
  expect('partial_refund(协商)守恒', Math.abs(after - before) <= 1e-9, { before, after })
  expect('partial_refund(协商)质押全额退卖家(不罚)', r2(seller.balance + seller.staked) === r2((100.01 - 40) + 8.88), seller)
}

// ── partial_refund 第三方责任:协议费入金库 + 责任方赔买家 ──
{
  const db = freshDb(); setupOrder(db, 77.77, 5, { liableBal: 50 })
  const before = totalMoney(db)
  const res = executeSettlement(db, 'ord', 'partial_refund', 30.00, 'liable')
  const after = totalMoney(db)
  const sys = db.prepare("SELECT balance FROM wallets WHERE user_id='sys_protocol'").get() as any
  expect('partial_refund(第三方)守恒', Math.abs(after - before) <= 1e-9, { before, after })
  expect('partial_refund(第三方)协议费入金库', r2(sys.balance) === r2(77.77 * 0.02), sys)
}

// ── liability_split:本就守恒,回归保护 ──
{
  const db = freshDb(); setupOrder(db, 50, 10)
  db.prepare("UPDATE wallets SET balance = 20 WHERE user_id='liable'").run()
  const before = totalMoney(db)
  const res = executeLiabilitySplit(db, 'ord', [{ user_id: 'liable', role: 'logistics', amount: 15 } as any], 30)
  const after = totalMoney(db)
  expect('liability_split 守恒', Math.abs(after - before) <= 1e-9, { before, after })
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
