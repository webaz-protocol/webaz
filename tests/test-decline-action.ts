// RFC-007 stage 2 — 卖家主动拒单(decline)单测(真实 transition + settleFault)。
// 验证:① seller 现在可显式触发 paid→fault_seller(stage 2 新增权限);② buyer 不可(权限边界);
//       ③ decline_reason_code/declined_at 落库;④ 拒单后违约结算守恒(买家全退、无印钱)。
import Database from 'better-sqlite3'
import { transition, settleFault, settleDeclinedNoFault, checkTimeouts } from '../src/layer0-foundation/L0-2-state-machine/engine.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, staked REAL DEFAULT 0, escrowed REAL DEFAULT 0, earned REAL DEFAULT 0);
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, status TEXT, buyer_id TEXT, seller_id TEXT, product_id TEXT, logistics_id TEXT,
      total_amount REAL, source TEXT DEFAULT 'shop', stake_backing REAL DEFAULT 0, bid_stake_held REAL DEFAULT 0,
      l1_uid TEXT, l2_uid TEXT, l3_uid TEXT, snapshot_commission_rate REAL, has_pending_claim INTEGER DEFAULT 0,
      pay_deadline TEXT, accept_deadline TEXT, ship_deadline TEXT, pickup_deadline TEXT, delivery_deadline TEXT, confirm_deadline TEXT,
      decline_reason_code TEXT, declined_at TEXT, decline_objective_pending INTEGER DEFAULT 0, decline_contest_deadline TEXT,
      decline_contested INTEGER DEFAULT 0, settled_fault_at TEXT, updated_at TEXT
    );
    CREATE TABLE reputation_events (id TEXT PRIMARY KEY, user_id TEXT, order_id TEXT, event_type TEXT, points REAL, reason TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE order_state_history (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT, actor_id TEXT, actor_role TEXT, evidence_ids TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE products (id TEXT PRIMARY KEY, stock INTEGER DEFAULT 0);
    CREATE TABLE commission_reserve (id TEXT PRIMARY KEY, balance REAL DEFAULT 0, total_chain_gap REAL DEFAULT 0, total_region_cap REAL DEFAULT 0, total_orphan_sponsor REAL DEFAULT 0, updated_at TEXT);
    CREATE TABLE commission_reserve_txns (id TEXT PRIMARY KEY, kind TEXT, from_user_id TEXT, amount REAL, related_order_id TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE protocol_params (key TEXT PRIMARY KEY, value TEXT);
  `)
  db.prepare("INSERT INTO commission_reserve (id, balance) VALUES ('main', 0)").run()
  db.prepare("INSERT INTO protocol_params (key, value) VALUES ('protocol_fee_rate_shop','0.02'),('fault_penalty_rate','0.30')").run()
  db.prepare("INSERT INTO users (id,name,role) VALUES ('seller','S','seller'),('buyer','B','buyer'),('sys_protocol','SYS','system'),('arb','Arb','arbitrator')").run()
  db.prepare("INSERT INTO products (id, stock) VALUES ('p1', 0)").run()
  return db
}
const bal = (db: Database.Database, u: string) => (db.prepare('SELECT COALESCE(balance,0) AS b FROM wallets WHERE user_id=?').get(u) as { b: number } | undefined)?.b ?? 0
const staked = (db: Database.Database, u: string) => (db.prepare('SELECT COALESCE(staked,0) AS s FROM wallets WHERE user_id=?').get(u) as { s: number } | undefined)?.s ?? 0
const systemTotal = (db: Database.Database) => {
  const w = (db.prepare('SELECT COALESCE(SUM(balance+staked+escrowed),0) AS s FROM wallets').get() as { s: number }).s
  const cr = (db.prepare("SELECT balance FROM commission_reserve WHERE id='main'").get() as { balance: number }).balance
  return Math.round((w + cr) * 100) / 100
}

// ── 权限边界:buyer 不能触发 paid→fault_seller ──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing) VALUES ('o1','paid','buyer','seller','p1',1000,150)").run()
  const r = transition(db, 'o1', 'fault_seller', 'buyer', [], 'buyer 尝试拒单')
  expect('权限边界:buyer 无法触发 paid→fault_seller', r.success === false, r)
  expect('权限边界:订单仍是 paid', (db.prepare("SELECT status FROM orders WHERE id='o1'").get() as { status: string }).status === 'paid')
}

// ── seller 主动拒单 paid→fault_seller(stage 2 新权限)+ 落库 + 守恒结算 ──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,snapshot_commission_rate) VALUES ('o2','paid','buyer','seller','p1',1000,150,0)").run()
  const before = systemTotal(db)
  // 镜像路由:写 decline 列 → transition(seller) → settleFault → 系统 complete
  db.prepare("UPDATE orders SET decline_reason_code='price_regret', declined_at=datetime('now') WHERE id='o2'").run()
  const r1 = transition(db, 'o2', 'fault_seller', 'seller', [], '卖家主动拒单 reason=price_regret')
  expect('seller 可触发 paid→fault_seller(stage 2 新权限)', r1.success === true, r1)
  expect('订单状态 → fault_seller', (db.prepare("SELECT status FROM orders WHERE id='o2'").get() as { status: string }).status === 'fault_seller')
  expect('decline_reason_code 落库', (db.prepare("SELECT decline_reason_code FROM orders WHERE id='o2'").get() as { decline_reason_code: string }).decline_reason_code === 'price_regret')
  expect('declined_at 落库', !!(db.prepare("SELECT declined_at FROM orders WHERE id='o2'").get() as { declined_at: string }).declined_at)
  settleFault(db, 'o2', 'fault_seller')
  const r2 = transition(db, 'o2', 'completed', 'sys_protocol', [], '主动拒单：系统执行违约结算')
  expect('系统执行 fault_seller→completed', r2.success === true, r2)
  expect('拒单结算守恒(系统总额不变,无印钱)', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('买家全额退款 ≥ 1000(escrow + 罚没补偿)', bal(db, 'buyer') >= 1000, bal(db, 'buyer'))
}

// ── stage 3:客观-声称拒单 → 临时判责(不结算)+ checkTimeouts 到期终结 ──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,snapshot_commission_rate) VALUES ('o3','paid','buyer','seller','p1',1000,150,0)").run()
  const before = systemTotal(db)
  // 镜像路由客观分支:转 fault_seller + 置 pending + deadline(此处设为【已过期】以便 checkTimeouts 立即终结)
  db.prepare("UPDATE orders SET decline_reason_code='stock_consumed_concurrent', declined_at=datetime('now') WHERE id='o3'").run()
  const r1 = transition(db, 'o3', 'fault_seller', 'seller', [], '卖家主动拒单(临时判责)')
  expect('stage3 客观拒单 → fault_seller(临时)', r1.success === true, r1)
  db.prepare("UPDATE orders SET decline_objective_pending=1, decline_contest_deadline=datetime('now','-1 hours') WHERE id='o3'").run()
  // 临时判责【未结算】:settled_fault_at 应为空、escrow 仍锁、stake 未没收
  expect('stage3 临时判责未结算(settled_fault_at NULL)', (db.prepare("SELECT settled_fault_at FROM orders WHERE id='o3'").get() as { settled_fault_at: string | null }).settled_fault_at === null)
  expect('stage3 买家 escrow 仍锁(未退)', systemTotal(db) === before)
  // checkTimeouts:举证窗口已过期 + 无人仲裁 → 终结为违约
  checkTimeouts(db)
  expect('stage3 到期终结 → completed', (db.prepare("SELECT status FROM orders WHERE id='o3'").get() as { status: string }).status === 'completed')
  expect('stage3 终结后已结算(settled_fault_at 非空)', !!(db.prepare("SELECT settled_fault_at FROM orders WHERE id='o3'").get() as { settled_fault_at: string }).settled_fault_at)
  expect('stage3 pending 已清', (db.prepare("SELECT decline_objective_pending AS p FROM orders WHERE id='o3'").get() as { p: number }).p === 0)
  expect('stage3 终结结算守恒(无印钱)', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('stage3 买家终结后全额退款 ≥ 1000', bal(db, 'buyer') >= 1000, bal(db, 'buyer'))
}

// ── stage 3:举证窗口【未到期】→ checkTimeouts 不终结(保留临时判责) ──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,decline_reason_code,decline_objective_pending,decline_contest_deadline) VALUES ('o4','fault_seller','buyer','seller','p1',1000,150,'force_majeure',1,datetime('now','+12 hours'))").run()
  checkTimeouts(db)
  expect('stage3 窗口内不终结(仍 fault_seller)', (db.prepare("SELECT status FROM orders WHERE id='o4'").get() as { status: string }).status === 'fault_seller')
  expect('stage3 窗口内未结算(settled_fault_at NULL)', (db.prepare("SELECT settled_fault_at FROM orders WHERE id='o4'").get() as { settled_fault_at: string | null }).settled_fault_at === null)
  expect('stage3 窗口内 pending 仍为 1(待仲裁)', (db.prepare("SELECT decline_objective_pending AS p FROM orders WHERE id='o4'").get() as { p: number }).p === 1)
}

// ── stage 5:仲裁维持(uphold)→ declined_nofault 无责结算(全退+退质押+中性标记,守恒)──
{
  const db = freshDb()
  // 临时判责中:escrow 锁 1000、卖家 staked 锁 150(模拟已背书),已 contested
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,decline_reason_code,decline_objective_pending,decline_contested) VALUES ('o5','fault_seller','buyer','seller','p1',1000,150,'force_majeure',1,1)").run()
  const before = systemTotal(db)
  const r1 = transition(db, 'o5', 'declined_nofault', 'arb', [], '仲裁维持:客观无责')
  expect('stage5 仲裁员可 fault_seller→declined_nofault', r1.success === true, r1)
  settleDeclinedNoFault(db, 'o5')
  const r2 = transition(db, 'o5', 'completed', 'sys_protocol', [], '无责结算完成')
  expect('stage5 declined_nofault→completed', r2.success === true, r2)
  expect('stage5 无责守恒(系统总额不变)', systemTotal(db) === before, { before, after: systemTotal(db) })
  expect('stage5 买家全额退款 1000', bal(db, 'buyer') === 1000, bal(db, 'buyer'))
  expect('stage5 卖家质押全退(staked 150→0, balance 150)', staked(db, 'seller') === 0 && bal(db, 'seller') === 150, { s: staked(db, 'seller'), b: bal(db, 'seller') })
  expect('stage5 卖家零成本(无罚没)', bal(db, 'seller') === 150)
  expect('stage5 中性 no_fault_decline 信誉事件 points=0', (db.prepare("SELECT points FROM reputation_events WHERE order_id='o5' AND event_type='no_fault_decline'").get() as { points: number } | undefined)?.points === 0)
  expect('stage5 pending 已清', (db.prepare("SELECT decline_objective_pending AS p FROM orders WHERE id='o5'").get() as { p: number }).p === 0)
}

// ── stage 5:已 contested → checkTimeouts 不自动终结(即使已过期,等仲裁)──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,decline_reason_code,decline_objective_pending,decline_contested,decline_contest_deadline) VALUES ('o6','fault_seller','buyer','seller','p1',1000,150,'force_majeure',1,1,datetime('now','-2 hours'))").run()
  checkTimeouts(db)
  expect('stage5 contested 不被自动终结(仍 fault_seller)', (db.prepare("SELECT status FROM orders WHERE id='o6'").get() as { status: string }).status === 'fault_seller')
  expect('stage5 contested 未结算(等仲裁)', (db.prepare("SELECT settled_fault_at FROM orders WHERE id='o6'").get() as { settled_fault_at: string | null }).settled_fault_at === null)
}

// ── stage 5:无责结算幂等 ──
{
  const db = freshDb()
  db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
  db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,decline_objective_pending) VALUES ('o7','declined_nofault','buyer','seller','p1',1000,150,1)").run()
  settleDeclinedNoFault(db, 'o7')
  const afterFirst = systemTotal(db)
  settleDeclinedNoFault(db, 'o7')
  expect('stage5 无责结算幂等(二次不变)', systemTotal(db) === afterFirst, { afterFirst, second: systemTotal(db) })
}

// ── Codex #119 P1: route-level — 主观拒单结算失败【绝不能】被当成 success ──
// 通过真实 registerOrdersActionRoutes 挂到 express,注入会抛错的 settleFault,
// 断言:接口返回 500 + error_code=DECLINE_SETTLEMENT_FAILED,success 不为 true,
//   不谎称已退款,订单停在 fault_seller,买家未被退款。再加正例(真实 settleFault → success)。
async function routeDeclineTests(): Promise<void> {
  const express = (await import('express')).default
  const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
  const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')

  function makeServer(db: Database.Database, settleFaultImpl: (db: Database.Database, orderId: string, faultState: string) => void) {
    setSeamDb(db)
    const app = express()
    app.use(express.json())
    const noop = () => {}
    registerOrdersActionRoutes(app, {
      db,
      auth: () => ({ id: 'seller', role: 'seller' }),
      isTrustedRole: () => false,
      generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`,
      transition,              // real engine
      notifyTransition: noop,
      settleOrder: noop,
      settleFault: settleFaultImpl,
      detectFraud: noop,
      createDispute: noop,
      checkTimeouts: noop,
      recordViolationReputation: noop,
      broadcastSystemEvent: noop,
    } as unknown as Parameters<typeof registerOrdersActionRoutes>[1])
    return app
  }

  async function post(app: ReturnType<typeof express>, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    const port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      return { status: res.status, body: json }
    } finally {
      server.close()
    }
  }

  // 失败路径:settleFault 抛错 → 接口绝不能 success
  {
    const db = freshDb()
    db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
    db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,snapshot_commission_rate) VALUES ('ofail','paid','buyer','seller','p1',1000,150,0)").run()
    const app = makeServer(db, () => { throw new Error('settleFault boom (simulated)') })
    const { status, body } = await post(app, '/api/orders/ofail/action', { action: 'decline', decline_reason_code: 'price_regret' })
    expect('decline 结算失败 → 非 2xx(500)', status === 500, { status, body })
    expect('decline 结算失败 → success 不为 true', body.success !== true, body)
    expect('decline 结算失败 → error_code=DECLINE_SETTLEMENT_FAILED', body.error_code === 'DECLINE_SETTLEMENT_FAILED', body)
    expect('decline 结算失败 → 不谎称已退款(note 不含"退款")', !String(body.note ?? '').includes('退款'), body)
    expect('decline 结算失败 → 买家未被退款(balance 仍 0)', bal(db, 'buyer') === 0, bal(db, 'buyer'))
    expect('decline 结算失败 → buyer escrow 未动(仍 1000)', (db.prepare("SELECT escrowed FROM wallets WHERE user_id='buyer'").get() as { escrowed: number }).escrowed === 1000)
    expect('decline 结算失败 → 订单停在 fault_seller', (db.prepare("SELECT status FROM orders WHERE id='ofail'").get() as { status: string }).status === 'fault_seller')
  }

  // 正例:真实 settleFault → success + completed + 守恒
  {
    const db = freshDb()
    db.prepare("INSERT INTO wallets (user_id, balance, staked, escrowed) VALUES ('seller',0,150,0),('buyer',0,0,1000),('sys_protocol',0,0,0)").run()
    db.prepare("INSERT INTO orders (id,status,buyer_id,seller_id,product_id,total_amount,stake_backing,snapshot_commission_rate) VALUES ('ook','paid','buyer','seller','p1',1000,150,0)").run()
    const before = systemTotal(db)
    const app = makeServer(db, settleFault)   // real engine settleFault
    const { status, body } = await post(app, '/api/orders/ook/action', { action: 'decline', decline_reason_code: 'price_regret' })
    expect('decline 正例 → 200 success', status === 200 && body.success === true, { status, body })
    expect('decline 正例 → 订单 completed', (db.prepare("SELECT status FROM orders WHERE id='ook'").get() as { status: string }).status === 'completed')
    expect('decline 正例 → 买家至少全额退款(退款+无责残值归买家,≥1000)', bal(db, 'buyer') >= 1000, bal(db, 'buyer'))
    expect('decline 正例 → 守恒(系统总额不变)', systemTotal(db) === before, { before, after: systemTotal(db) })
  }
}

await routeDeclineTests()

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
