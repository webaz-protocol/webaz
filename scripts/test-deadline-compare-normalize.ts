#!/usr/bin/env tsx
/**
 * Deadline 比较归一化回归(review #298 finding)。
 *
 * findActiveDeadlineTransition 此前用 JS 字符串直比 `now(ISO 'T') > deadline`。deadline 有两种存储格式:
 * escrow 建单走 addHours→ISO('…T…Z'),直付路径(ship_deadline @ orders-action)走 datetime('now',…)→空格格式。
 * 对【空格格式】deadline 在同一日历日,字符串比较会因 'T'(0x54) > ' '(0x20) 误判为已过 →
 * 最多提前 ~24h 自动判责(如 direct_p2p 卖家被提前判 fault_seller 未发货)。改为 datetime()<datetime() 归一化后,
 * 空格/ISO 两种格式都按真实时间判定。本测试直接跑【真实 checkTimeouts】(此前无回归覆盖)。
 * Usage: npm run test:deadline-compare-normalize
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'deadline-norm-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initSystemUser, checkTimeouts } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderChainSchema(db)
// server-boot ALTER 列(checkTimeouts SELECT / RFC-007 扫描 / settleFault 幂等标记读写)
for (const c of ['has_pending_claim INTEGER DEFAULT 0', 'decline_objective_pending INTEGER DEFAULT 0', 'decline_contested INTEGER DEFAULT 0', 'decline_contest_deadline TEXT', 'settled_fault_at TEXT', 'source TEXT', 'fulfillment_mode TEXT'])
  { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* 已存在 */ } }
initSystemUser(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','买家','buyer','kb'),('seller1','卖家','seller','ks')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('buyer1',0),('seller1',0)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','seller1','P','d',50,10)").run()

const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status?: string } | undefined)?.status
let n = 0
// 建 direct_p2p 单(settleFault 走 direct_p2p 分支=纯库存回补+标记,无 escrow/protocol_params 依赖),并按 SQL 表达式写某 deadline 列。
function mkOrder(st: string, col: string, sqlExpr: string): string {
  const id = `o_${++n}`
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode)
     VALUES (?, 'p1','buyer1','seller1',1,50,50,0,?,'direct_p2p','shipped')`).run(id, st)
  db.prepare(`UPDATE orders SET ${col} = ${sqlExpr} WHERE id = ?`).run(id)
  return id
}

// ── ① 核心 bug:accepted + 空格格式 ship_deadline 同日【未来】+3h(未过)→ 绝不提前判 fault_seller ──
//    (归一化前:JS 直比 now(ISO 'T') > "YYYY-MM-DD …" 会误判已过 → 提前判责;归一化后正确)
{
  const oFut = mkOrder('accepted', 'ship_deadline', "datetime('now','+3 hours')")
  checkTimeouts(db)
  ok('1. 空格格式 ship_deadline 同日 +3h(未过)→ 不提前判责(仍 accepted)', status(oFut) === 'accepted', `status=${status(oFut)}`)
}
// ── ② 空格格式 ship_deadline 已过(-1h)→ 正常自动判责(离开 accepted)──
{
  const oPast = mkOrder('accepted', 'ship_deadline', "datetime('now','-1 hours')")
  checkTimeouts(db)
  ok('2. 空格格式 ship_deadline 已过 → 正常自动判责(不再 accepted)', !!status(oPast) && status(oPast) !== 'accepted', `status=${status(oPast)}`)
}
// ── ③ ISO 格式(escrow 建单口径)未过/已过 —— 归一化对 ISO 同样正确(未 regress)──
{
  const oIsoFut = mkOrder('accepted', 'ship_deadline', "strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 hours')")
  const oIsoPast = mkOrder('accepted', 'ship_deadline', "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')")
  checkTimeouts(db)
  ok('3a. ISO ship_deadline 未过 → 仍 accepted', status(oIsoFut) === 'accepted', `status=${status(oIsoFut)}`)
  ok('3b. ISO ship_deadline 已过 → 自动判责(不再 accepted)', !!status(oIsoPast) && status(oIsoPast) !== 'accepted', `status=${status(oIsoPast)}`)
}
// ── ④ 同类字段:confirm_deadline 空格格式同日未来 → 不提前触发(delivered 保持)──
{
  const oDlv = mkOrder('delivered', 'confirm_deadline', "datetime('now','+3 hours')")
  checkTimeouts(db)
  ok('4. 空格格式 confirm_deadline 同日 +3h(未过)→ 不提前触发(仍 delivered)', status(oDlv) === 'delivered', `status=${status(oDlv)}`)
}

if (fail > 0) { console.error(`\n❌ deadline-compare-normalize FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ deadline-compare-normalize: ${pass} pass — space/ISO deadline 归一化(同日未来 deadline 不再提前判责/触发)`)
