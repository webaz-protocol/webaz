#!/usr/bin/env tsx
/**
 * Deadline 比较归一化回归(review #298/#299 finding)。
 *
 * findActiveDeadlineTransition 此前用 JS 字符串直比 `now(ISO 'T') > deadline`。deadline 有两种存储格式:
 * escrow 建单走 addHours→ISO('…T…Z'),直付路径(ship_deadline @ orders-action)走 datetime('now',…)→空格格式。
 * 对【空格格式】deadline 在同一日历日,字符串比较会因 'T'(0x54) > ' '(0x20) 误判为已过 →
 * 最多提前 ~24h 自动判责(如 direct_p2p 卖家被提前判 fault_seller 未发货)。改为 datetime()<datetime() 归一化后,
 * 空格/ISO 两种格式都按真实时间判定。本测试直接跑【真实 checkTimeouts】(此前无回归覆盖)。
 *
 * 【为何用 date('now')||' 23:59:59' 而非 +3h】:bug 只在 now 与 deadline 同一 UTC 日历日时暴露。用 +3h 会在
 * 21:00–24:00 UTC 跨过午夜 → 不同日历日 → 连旧 buggy 代码都不会提前触发 → 测试对 bug 失去保护(~12.5% 时段假绿)。
 * 用"今天 23:59:59"保证与 now 同日且未来(除当日最后 1 秒),旧代码在此【必】提前触发,归一化后必不触发。
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
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','seller1','P','d',50,100)").run()

const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status?: string } | undefined)?.status
const noopSettle = (): void => { /* comparator 测试:成交结算无关,仅需 confirmed 分支不被 !settleConfirmed 门挡住 */ }
const SAME_DAY_FUTURE = "date('now') || ' 23:59:59'"   // 与 now 同一 UTC 日、未来(除当日最后 1 秒);空格格式
let n = 0
// 建 direct_p2p 单(settleFault 走 direct_p2p 分支=纯库存回补+标记,无 escrow/protocol_params 依赖),并按 SQL 表达式写某 deadline 列。
function mkOrder(st: string, col: string, sqlExpr: string): string {
  const id = `o_${++n}`
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode)
     VALUES (?, 'p1','buyer1','seller1',1,50,50,0,?,'direct_p2p','shipped')`).run(id, st)
  db.prepare(`UPDATE orders SET ${col} = ${sqlExpr} WHERE id = ?`).run(id)
  return id
}

// ── ① 核心 bug:accepted + 空格格式 ship_deadline 同日【未来】(23:59:59,未过)→ 绝不提前判 fault_seller ──
//    归一化前旧代码在此【必】提前触发(status→completed);归一化后 status 保持 accepted。
{
  const oFut = mkOrder('accepted', 'ship_deadline', SAME_DAY_FUTURE)
  checkTimeouts(db)
  ok('1. 空格格式 ship_deadline 同日未来(未过)→ 不提前判责(仍 accepted)', status(oFut) === 'accepted', `status=${status(oFut)}`)
}
// ── ② 空格格式 ship_deadline 已过(-1h)→ 正常自动判责 fault_seller → completed(强断言具体终态)──
{
  const oPast = mkOrder('accepted', 'ship_deadline', "datetime('now','-1 hours')")
  checkTimeouts(db)
  ok('2. 空格格式 ship_deadline 已过 → 自动判责结算至 completed', status(oPast) === 'completed', `status=${status(oPast)}`)
}
// ── ③ ISO 格式(escrow 建单口径)未过/已过 —— 归一化对 ISO 同样正确(未 regress)──
{
  const oIsoFut = mkOrder('accepted', 'ship_deadline', "strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 hours')")
  const oIsoPast = mkOrder('accepted', 'ship_deadline', "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')")
  checkTimeouts(db)
  ok('3a. ISO ship_deadline 未过 → 仍 accepted(无 regress)', status(oIsoFut) === 'accepted', `status=${status(oIsoFut)}`)
  ok('3b. ISO ship_deadline 已过 → 自动判责至 completed', status(oIsoPast) === 'completed', `status=${status(oIsoPast)}`)
}
// ── ④ 另一字段 confirm_deadline:空格格式同日未来 → 不提前触发。注入 settler 使 confirmed 分支【可达】(否则 !settleConfirmed 门挡住=空测)。──
{
  const oDlvFut = mkOrder('delivered', 'confirm_deadline', SAME_DAY_FUTURE)
  checkTimeouts(db, { settleConfirmed: noopSettle })
  ok('4. 空格格式 confirm_deadline 同日未来(未过)+ settler → 不提前触发(仍 delivered)', status(oDlvFut) === 'delivered', `status=${status(oDlvFut)}`)
}
// ── ⑤ confirm_deadline 已过 + settler → 正常自动确认 → completed(证明触发路径本身工作,非恒不触发)──
{
  const oDlvPast = mkOrder('delivered', 'confirm_deadline', "datetime('now','-1 hours')")
  checkTimeouts(db, { settleConfirmed: noopSettle })
  ok('5. 空格格式 confirm_deadline 已过 + settler → 自动确认至 completed', status(oDlvPast) === 'completed', `status=${status(oDlvPast)}`)
}

if (fail > 0) { console.error(`\n❌ deadline-compare-normalize FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ deadline-compare-normalize: ${pass} pass — space/ISO deadline 归一化(同日未来 deadline 不提前判责/确认;已过正常触发)`)
