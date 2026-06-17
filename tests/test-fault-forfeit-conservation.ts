// RFC-007 stage 4 — 违约没收【守恒 + 不牟利 + 推广人受偿】单测(真实 settleFault,非复刻)。
// 不变式:settleFault 前后 系统总额 = Σ(wallets.balance+staked+escrowed) + commission_reserve.balance 恒定。
//   即 没收的 F 被【完整】分给 协议费/买家/推广人 —— 绝不印钱、绝不转负。
// 另查:协议 ≤ 原始平台费;推广人 ≤ 各自原始佣金;残值(超封顶/无推广人)→ 买家(决策 A 2026-06-07,买家可超 50%,不入公池)。
import Database from 'better-sqlite3'
import { settleFault } from '../src/layer0-foundation/L0-2-state-machine/engine.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }
const r2 = (n: number) => Math.round(n * 100) / 100

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, staked REAL DEFAULT 0, escrowed REAL DEFAULT 0, earned REAL DEFAULT 0);
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, status TEXT, buyer_id TEXT, seller_id TEXT, product_id TEXT, logistics_id TEXT,
      total_amount REAL, source TEXT DEFAULT 'shop', stake_backing REAL DEFAULT 0, bid_stake_held REAL DEFAULT 0,
      l1_uid TEXT, l2_uid TEXT, l3_uid TEXT, snapshot_commission_rate REAL, settled_fault_at TEXT
    );
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

const systemTotal = (db: Database.Database) => {
  const w = (db.prepare('SELECT COALESCE(SUM(balance+staked+escrowed),0) AS s FROM wallets').get() as { s: number }).s
  const cr = (db.prepare("SELECT balance FROM commission_reserve WHERE id='main'").get() as { balance: number }).balance
  return r2(w + cr)
}
const bal = (db: Database.Database, u: string) => (db.prepare('SELECT COALESCE(balance,0) AS b FROM wallets WHERE user_id=?').get(u) as { b: number } | undefined)?.b ?? 0
const staked = (db: Database.Database, u: string) => (db.prepare('SELECT COALESCE(staked,0) AS s FROM wallets WHERE user_id=?').get(u) as { s: number } | undefined)?.s ?? 0
const reserveBal = (db: Database.Database) => (db.prepare("SELECT balance FROM commission_reserve WHERE id='main'").get() as { balance: number }).balance

// ── 场景 B:有质押 + 完整 l1/l2/l3 推广人 ──────────────────────
{
  const db = freshDb()
  // total=1000, stake_backing=150(0.15), commission_rate=0.05 → pool=50(l1=35/l2=10/l3=5)
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0),('l1',0,0,0),('l2',0,0,0),('l3',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('p1', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,l1_uid,l2_uid,l3_uid,snapshot_commission_rate) VALUES ('oB','paid','buyer','seller','p1',1000,'shop',150,'l1','l2','l3',0.05)").run()
  const before = systemTotal(db)
  settleFault(db, 'oB', 'fault_seller')
  expect('B 守恒:系统总额前后不变(无印钱)', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('B 卖家 staked 150→0(全额没收)', staked(db, 'seller') === 0, staked(db, 'seller'))
  // F=150: protocolTake=min(150,20)=20; R=130; buyer 基础 65; promoterHalf=65 capped 50; residual 15 → 买家
  //   买家 = escrow 退款 1000 + 基础 65 + 残值 15 = 1080(下行断言)
  expect('B 协议只回收原始费 20(≤2%)', bal(db, 'sys_protocol') === 20, bal(db, 'sys_protocol'))
  expect('B 买家 = escrow 1000 + R*50%=65 + 残值 15 = 1080', bal(db, 'buyer') === 1080, bal(db, 'buyer'))
  expect('B l1 受偿封顶原始佣金 35', bal(db, 'l1') === 35, bal(db, 'l1'))
  expect('B l2 受偿 10', bal(db, 'l2') === 10, bal(db, 'l2'))
  expect('B l3 受偿 5', bal(db, 'l3') === 5, bal(db, 'l3'))
  expect('B 残值 15 → 买家(不进公池)', reserveBal(db) === 0, reserveBal(db))
  expect('B 没收 F 完整分配:20+(65+15)+35+10+5=150', r2(20 + 80 + 35 + 10 + 5) === 150)
  expect('B 推广人均 ≤ 各自原始佣金', bal(db, 'l1') <= 35 && bal(db, 'l2') <= 10 && bal(db, 'l3') <= 5)
}

// ── 场景 C:有质押 + 无推广人(l1/l2/l3 全空)──────────────────
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('p2', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,snapshot_commission_rate) VALUES ('oC','paid','buyer','seller','p2',1000,'shop',150,0.05)").run()
  const before = systemTotal(db)
  settleFault(db, 'oC', 'fault_seller')
  expect('C 守恒:系统总额前后不变', systemTotal(db) === before, { before, after: systemTotal(db) })
  // F=150: protocolTake=20; R=130; buyer 基础 65; promoterHalf=65 → 无推广人 → 残值 65 全归买家
  expect('C 协议回收 20', bal(db, 'sys_protocol') === 20, bal(db, 'sys_protocol'))
  expect('C 买家 = escrow 1000 + 65 + 残值 65 = 1130(可超 50%)', bal(db, 'buyer') === 1130, bal(db, 'buyer'))
  expect('C 残值(无推广人)全归买家,公池 0', reserveBal(db) === 0, reserveBal(db))
  expect('C 没收 F 完整:20+(65+65 买家)=150', r2(20 + 65 + 65) === 150)
}

// ── 场景 A:起步免赔付(stake_backing=0)──────────────────────
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,0,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('p3', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,snapshot_commission_rate) VALUES ('oA','paid','buyer','seller','p3',1000,'shop',0,0.05)").run()
  const before = systemTotal(db)
  settleFault(db, 'oA', 'fault_seller')
  expect('A 守恒:系统总额前后不变', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('A 起步免赔付:无没收(seller staked=0)', staked(db, 'seller') === 0)
  expect('A 买家仍全额退款 1000', bal(db, 'buyer') === 1000, bal(db, 'buyer'))
  expect('A 协议/公池 零变化', bal(db, 'sys_protocol') === 0 && reserveBal(db) === 0)
}

// ── 场景 D:二手(stakeAmount=0,无 seller stake)─────────────
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO secondhand_items (id, status) VALUES ('s1','sold')").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,snapshot_commission_rate) VALUES ('oD','paid','buyer','seller','s1',1000,'secondhand',150,0.05)").run()
  const before = systemTotal(db)
  settleFault(db, 'oD', 'fault_seller')
  expect('D 守恒:系统总额前后不变', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('D 二手无 seller stake → 不没收(staked 不变 150)', staked(db, 'seller') === 150, staked(db, 'seller'))
  expect('D 买家全额退款 1000', bal(db, 'buyer') === 1000, bal(db, 'buyer'))
  expect('D 二手物品状态恢复 available', (db.prepare("SELECT status FROM secondhand_items WHERE id='s1'").get() as { status: string }).status === 'available')
}

// ── 场景 E:幂等(重复 settleFault 不二次扣)─────────────────
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0),('l1',0,0,0),('l2',0,0,0),('l3',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('p5', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,l1_uid,l2_uid,l3_uid,snapshot_commission_rate) VALUES ('oE','paid','buyer','seller','p5',1000,'shop',150,'l1','l2','l3',0.05)").run()
  settleFault(db, 'oE', 'fault_seller')
  const afterFirst = systemTotal(db)
  const sellerStakedAfter = staked(db, 'seller')
  settleFault(db, 'oE', 'fault_seller')   // 重入
  expect('E 幂等:二次调用系统总额不变', systemTotal(db) === afterFirst, { afterFirst, second: systemTotal(db) })
  expect('E 幂等:卖家 staked 不二次扣', staked(db, 'seller') === sellerStakedAfter)
}

// ── 场景 F1(RFC-008 stage 2):罚没率解耦 — penalty(30%)>背书(15%) 且卖家有自由 balance → 扣到 balance ──
{
  const db = freshDb()
  // total=1000 → penalty=300; backing=150; 卖家自由 balance=500
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',500,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0),('l1',0,0,0),('l2',0,0,0),('l3',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('pF1', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,l1_uid,l2_uid,l3_uid,snapshot_commission_rate) VALUES ('oF1','paid','buyer','seller','pF1',1000,'shop',150,'l1','l2','l3',0.05)").run()
  const before = systemTotal(db)
  settleFault(db, 'oF1', 'fault_seller')
  expect('F1 守恒:系统总额前后不变(扣到自由余额也守恒)', systemTotal(db) === before, { before, after: systemTotal(db) })
  // fromStaked=min(300,150)=150 → staked 0;remainder=150;fromBalance=min(150,500)=150 → balance 500-150=350;F=300
  expect('F1 staked 150→0(背书先扣光)', staked(db, 'seller') === 0, staked(db, 'seller'))
  expect('F1 卖家自由 balance 500→350(不足部分扣自由余额)', bal(db, 'seller') === 350, bal(db, 'seller'))
  // F=300: protocolTake=min(300,20)=20; R=280; buyer 基础 140; promoterHalf=140 capped 50; residual 90 → 买家
  expect('F1 协议回收 20(≤2%)', bal(db, 'sys_protocol') === 20, bal(db, 'sys_protocol'))
  expect('F1 买家 = escrow 1000 + 140 + 残值 90 = 1230', bal(db, 'buyer') === 1230, bal(db, 'buyer'))
  expect('F1 推广封顶原始佣金 l1=35/l2=10/l3=5', bal(db, 'l1') === 35 && bal(db, 'l2') === 10 && bal(db, 'l3') === 5)
  expect('F1 残值 90 → 买家(不进公池)', reserveBal(db) === 0, reserveBal(db))
  expect('F1 没收 F 完整:20+(140+90)+35+10+5=300', r2(20 + 230 + 35 + 10 + 5) === 300)
}

// ── 场景 F2(RFC-008 stage 2):起步免赔付 backing=0 但卖家有自由 balance → 绝不碰自由余额 ──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',500,0,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('pF2', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,snapshot_commission_rate) VALUES ('oF2','paid','buyer','seller','pF2',1000,'shop',0,0.05)").run()
  const before = systemTotal(db)
  settleFault(db, 'oF2', 'fault_seller')
  expect('F2 守恒:系统总额前后不变', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('F2 起步免赔付:卖家自由 balance 500 原封不动(不重引门槛)', bal(db, 'seller') === 500, bal(db, 'seller'))
  expect('F2 买家仍全额退款 1000', bal(db, 'buyer') === 1000, bal(db, 'buyer'))
  expect('F2 协议/公池 零变化(无没收)', bal(db, 'sys_protocol') === 0 && reserveBal(db) === 0)
}

// ── 场景 F3(RFC-008 stage 2):卖家自由余额不足 remainder → 封顶其真实余额,不转负 ──
{
  const db = freshDb()
  // penalty=300; backing=150; 自由 balance 仅 40 → fromBalance=min(150,40)=40; F=190
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',40,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('pF3', 0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,source,stake_backing,snapshot_commission_rate) VALUES ('oF3','paid','buyer','seller','pF3',1000,'shop',150,0)").run()
  const before = systemTotal(db)
  settleFault(db, 'oF3', 'fault_seller')
  expect('F3 守恒:系统总额前后不变', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('F3 staked 150→0', staked(db, 'seller') === 0, staked(db, 'seller'))
  expect('F3 自由余额 40→0(封顶真实余额,不转负)', bal(db, 'seller') === 0, bal(db, 'seller'))
  expect('F3 卖家余额永不为负', bal(db, 'seller') >= 0)
  // F=190: protocolTake=20; R=170; buyer 基础 85; 无推广人(rate=0)→ 残值 85 → 买家。买家 = 1000+85+85=1170
  expect('F3 没收 F=190 完整:20+(85+85 买家),公池 0', r2(20 + 85 + 85) === 190 && reserveBal(db) === 0 && bal(db, 'buyer') === 1170)
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
