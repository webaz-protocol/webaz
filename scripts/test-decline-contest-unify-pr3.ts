#!/usr/bin/env tsx
/**
 * 统一仲裁台 PR3 —— 裁决闭环(唯一 domain resolver + 三入口收敛 + 旧端点 410 + completed 终态 + 失败全回滚)。
 *   用法:npm run test:decline-contest-unify-p3
 *
 * 断言矩阵:
 *   A. uphold(维持无责):order→completed;买家 escrow 全退;卖家质押退回(balance+);库存+1;dispute resolved+ruling_type;事件链含 declined_nofault。
 *   B. reject(驳回判违约):order→completed;卖家质押【未退回】(罚没);settled。
 *   C. 重复/并发裁决:第二次 throw ALREADY_RULED;settled_fault_at 与卖家余额【均不再变】(不双结算)。
 *   D. COI:当事人(买家)裁决 → throw。
 *   E. assignment:案已分配他人 → 另一仲裁员 throw NOT_ASSIGNED。
 *   F. admin fallback 门槛:仲裁窗口未过 → FALLBACK_TOO_EARLY;过后可裁,且【不占用 assigned_arbitrators】+ audit 有 override。
 *   G. 四段式超时:窗口内不动;过窗口发一次升级通知(去重);过 +48h 自动判违约 + auto_resolved_by_timeout。
 *   H. 路由:ruling-order —— decline_contest 拒 refund_buyer(400 BAD_DECISION)、收两选;旧端点 410。
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dcp3-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initDisputeSchema, createDeclineContestDispute, checkDisputeTimeouts, getDisputeDetails } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { resolveDeclineContestDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/decline-contest-resolve.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initReputationSchema } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { registerDisputesWriteRoutes } = await import('../src/pwa/routes/disputes-write.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initDisputeSchema(db); initNotificationSchema(db); initOrderChainSchema(db); initReputationSchema(db)
db.exec('CREATE TABLE IF NOT EXISTS arbitrator_whitelist (user_id TEXT PRIMARY KEY, status TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS protocol_params (key TEXT PRIMARY KEY, value TEXT)')   // 空表 → settleFault 用默认率(fault_penalty 0.30 / protocol_fee 0.02)
for (const c of ['decline_objective_pending INTEGER', 'decline_contested INTEGER', 'decline_reason_code TEXT', 'decline_contest_deadline TEXT', 'declined_at TEXT', 'settled_fault_at TEXT', 'stake_backing REAL', 'bid_stake_held REAL']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch { /* */ } }

db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('sys_protocol','sys','system','k_sys'),('seller1','S','seller','k_s'),('buyer1','B','buyer','k_b'),('arb1','A1','buyer','k_a1'),('arb2','A2','buyer','k_a2'),('adm1','ADM','admin','k_adm')").run()
db.prepare("INSERT INTO arbitrator_whitelist (user_id,status) VALUES ('arb1','active'),('arb2','active')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,status,stock) VALUES ('prd_x','seller1','P','d',30,'active',0)").run()

let seq = 0
// 每案独立 order + 钱包(escrow=30 / seller staked=10 / stake_backing=10);返回 { orderId, disputeId }
const setup = (opts: { arbFuture?: boolean } = {}): { orderId: string; disputeId: string } => {
  const orderId = `ord_${++seq}`
  const ad = opts.arbFuture ? new Date(Date.now() + 3600_000).toISOString() : '2000-01-01T00:00:00Z'
  db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,
      decline_objective_pending,decline_contested,settled_fault_at,decline_reason_code,declined_at,decline_contest_deadline,stake_backing,bid_stake_held)
      VALUES (?,?,?,?,'fault_seller',30,30,30,'escrow',1,1,NULL,'force_majeure','2000-01-01T00:00:00Z','2000-01-02T00:00:00Z',10,0)`).run(orderId, 'buyer1', 'seller1', 'prd_x')
  db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed) VALUES ('buyer1',0,0,30) ON CONFLICT(user_id) DO UPDATE SET balance=0,staked=0,escrowed=30").run()
  db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed) VALUES ('seller1',0,10,0) ON CONFLICT(user_id) DO UPDATE SET balance=0,staked=10,escrowed=0").run()
  db.prepare('UPDATE products SET stock=0 WHERE id=?').run('prd_x')
  const dc = createDeclineContestDispute(db, orderId)
  // 覆盖 arbitrate_deadline 到我们要的值(建行默认 +120h)
  db.prepare('UPDATE disputes SET arbitrate_deadline=? WHERE id=?').run(ad, dc.disputeId)
  return { orderId, disputeId: dc.disputeId! }
}
const wallet = (uid: string) => db.prepare('SELECT balance,staked,escrowed FROM wallets WHERE user_id=?').get(uid) as { balance: number; staked: number; escrowed: number }
const orderRow = (id: string) => db.prepare('SELECT status,settled_fault_at,decline_contested FROM orders WHERE id=?').get(id) as { status: string; settled_fault_at: string | null; decline_contested: number }
const disputeRow = (id: string) => db.prepare('SELECT status,ruling_type,assigned_arbitrators,audit_log FROM disputes WHERE id=?').get(id) as { status: string; ruling_type: string | null; assigned_arbitrators: string | null; audit_log: string | null }

try {
  // ══ A. uphold ══
  { const { orderId, disputeId } = setup()
    resolveDeclineContestDispute(db, disputeId, 'arb1', 'decline_no_fault_upheld', '客观无责', 'arbitrator')
    const o = orderRow(orderId), d = disputeRow(disputeId), sw = wallet('seller1'), bw = wallet('buyer1')
    ok('A1 order → completed', o.status === 'completed')
    ok('A2 已结算(settled_fault_at 置位)', !!o.settled_fault_at)
    ok('A3 买家 escrow 全退(balance=30, escrowed=0)', bw.balance === 30 && bw.escrowed === 0)
    ok('A4 卖家质押退回(staked=0, balance=10)', sw.staked === 0 && sw.balance === 10)
    ok('A5 库存 +1', (db.prepare("SELECT stock FROM products WHERE id='prd_x'").get() as { stock: number }).stock === 1)
    ok('A6 dispute resolved + ruling_type=decline_no_fault_upheld', d.status === 'resolved' && d.ruling_type === 'decline_no_fault_upheld')
    const evs = db.prepare('SELECT to_status FROM order_events WHERE order_id=?').all(orderId) as { to_status: string }[]
    ok('A7 事件链含 declined_nofault 中间态 + completed', evs.some(e => e.to_status === 'declined_nofault') && evs.some(e => e.to_status === 'completed'))
  }

  // ══ B. reject ══
  { const { orderId, disputeId } = setup()
    resolveDeclineContestDispute(db, disputeId, 'arb1', 'decline_fault_confirmed', '驳回', 'arbitrator')
    const o = orderRow(orderId), sw = wallet('seller1')
    ok('B1 order → completed', o.status === 'completed')
    ok('B2 已结算', !!o.settled_fault_at)
    ok('B3 卖家质押【未退回】(balance 未增 = 罚没,区别于 uphold)', sw.balance === 0)
  }

  // ══ C. 重复/并发裁决 ══
  { const { orderId, disputeId } = setup()
    resolveDeclineContestDispute(db, disputeId, 'arb1', 'decline_no_fault_upheld', '首次', 'arbitrator')
    const settledAt = orderRow(orderId).settled_fault_at, sbal = wallet('seller1').balance
    let threw = ''
    try { resolveDeclineContestDispute(db, disputeId, 'arb2', 'decline_fault_confirmed', '第二次', 'arbitrator') } catch (e) { threw = (e as { code?: string }).code || 'err' }
    ok('C1 第二次裁决 throw ALREADY_RULED', threw === 'ALREADY_RULED')
    ok('C2 settled_fault_at 不再变(无双结算)', orderRow(orderId).settled_fault_at === settledAt)
    ok('C3 卖家余额不再变(钱只动一次)', wallet('seller1').balance === sbal)
  }

  // ══ D. COI ══
  { const { disputeId } = setup()
    let threw = ''
    try { resolveDeclineContestDispute(db, disputeId, 'buyer1', 'decline_no_fault_upheld', 'COI', 'arbitrator') } catch (e) { threw = (e as { code?: string }).code || 'err' }
    ok('D1 当事人(买家)裁决 → COI throw', threw === 'ARBITRATOR_CONFLICT_OF_INTEREST')
  }

  // ══ E. assignment ══
  { const { disputeId } = setup()
    db.prepare("UPDATE disputes SET assigned_arbitrators='[\"arb2\"]' WHERE id=?").run(disputeId)
    let threw = ''
    try { resolveDeclineContestDispute(db, disputeId, 'arb1', 'decline_no_fault_upheld', 'x', 'arbitrator') } catch (e) { threw = (e as { code?: string }).code || 'err' }
    ok('E1 案已分配他人 → 另一仲裁员 NOT_ASSIGNED', threw === 'NOT_ASSIGNED_ARBITRATOR')
  }

  // ══ F. admin fallback 门槛 ══
  { const { disputeId } = setup({ arbFuture: true })   // 仲裁窗口未过
    let threw = ''
    try { resolveDeclineContestDispute(db, disputeId, 'adm1', 'decline_fault_confirmed', '太早', 'admin_fallback') } catch (e) { threw = (e as { code?: string }).code || 'err' }
    ok('F1 仲裁窗口未过 → admin FALLBACK_TOO_EARLY', threw === 'FALLBACK_TOO_EARLY')
  }
  { const { orderId, disputeId } = setup()   // 仲裁窗口已过(默认 ad=2000)
    resolveDeclineContestDispute(db, disputeId, 'adm1', 'decline_fault_confirmed', 'admin 兜底', 'admin_fallback')
    const d = disputeRow(disputeId)
    ok('F2 窗口过后 admin 可裁 → order completed', orderRow(orderId).status === 'completed')
    ok('F3 admin override 不占用 assigned_arbitrators', (d.assigned_arbitrators || '[]') === '[]')
    ok('F4 audit_log 记录 resolved_by_admin_override', (d.audit_log || '').includes('resolved_by_admin_override'))
  }

  // ══ G. 四段式超时(via checkDisputeTimeouts)══
  { // 窗口内:不动
    const { orderId, disputeId } = setup({ arbFuture: true })
    checkDisputeTimeouts(db)
    ok('G1 仲裁窗口内 cron 不动(dispute 仍 open)', disputeRow(disputeId).status === 'open' && !orderRow(orderId).settled_fault_at)
  }
  { // 过窗口 ≤+48h:升级通知一次(去重)
    const { orderId, disputeId } = setup()
    db.prepare("UPDATE disputes SET arbitrate_deadline=? WHERE id=?").run(new Date(Date.now() - 3600_000).toISOString(), disputeId)  // 1h 前过窗口,未到 +48h
    checkDisputeTimeouts(db); checkDisputeTimeouts(db)   // 跑两次验去重
    ok('G2 过窗口未到 +48h:不自动结算(等人裁)', disputeRow(disputeId).status === 'open' && !orderRow(orderId).settled_fault_at)
    ok('G3 升级通知去重(每收件人仅一条)', (db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id=? AND type='arb:decline_contest_escalated' AND user_id='arb1'").get(orderId) as { n: number }).n === 1)
  }
  { // 过 +48h:硬兜底判违约
    const { orderId, disputeId } = setup()
    db.prepare("UPDATE disputes SET arbitrate_deadline=? WHERE id=?").run(new Date(Date.now() - 49 * 3600_000).toISOString(), disputeId)  // 49h 前 → 过 +48h
    checkDisputeTimeouts(db)
    const o = orderRow(orderId), d = disputeRow(disputeId)
    ok('G4 过 +48h:自动判卖家违约 → order completed', o.status === 'completed')
    ok('G5 ruling_type=decline_fault_confirmed + auto_resolved_by_timeout', d.ruling_type === 'decline_fault_confirmed' && (d.audit_log || '').includes('auto_resolved_by_timeout'))
  }

  // ══ H. 路由:ruling-order + 旧端点 410 ══
  { const errorRes = (res: express.Response, s: number, code: string, msg: string) => { res.status(s).json({ error: msg, error_code: code }) }
    const app = express(); app.use(express.json())
    registerDisputesWriteRoutes(app, {
      db, auth: () => ({ id: 'arb1' }), generateId: (p: string) => `${p}_t`, detectFraud: () => [], errorRes,
      isEligibleArbitrator: () => ({ ok: true }), requireHumanPresence: () => ({ ok: true }),
      getDisputeDetails, logAdminAction: () => {}, arbitrateDispute: () => ({ success: true }),
    } as never)
    const server = app.listen(0); const port = (server.address() as AddressInfo).port
    const post = async (path: string, body: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> } }

    const { disputeId } = setup()
    const bad = await post(`/api/disputes/${disputeId}/arbitrate`, { ruling: 'refund_buyer', reason: '通用裁决', webauthn_token: 'x' })
    ok('H1 decline_contest 提交通用 ruling(refund_buyer)→ 400 BAD_DECISION(不被通用校验静默接受)', bad.status === 400 && bad.body.error_code === 'BAD_DECISION')

    const s2 = setup()
    const good = await post(`/api/disputes/${s2.disputeId}/arbitrate`, { ruling: 'decline_no_fault_upheld', reason: '维持', webauthn_token: 'x' })
    ok('H2 decline_contest 提交两选名 → 成功裁决 + order completed', good.body.success === true && good.body.order_status === 'completed' && orderRow(s2.orderId).status === 'completed')

    const gone = await post(`/api/admin/decline-contests/${s2.orderId}/resolve`, { decision: 'uphold', reason: 'x' })
    ok('H3 旧订单级端点 → 410 ENDPOINT_GONE(旁路已封)', gone.status === 410 && gone.body.error_code === 'ENDPOINT_GONE')
    server.close()
  }

  if (fail === 0) console.log(`\n✅ decline_contest 裁决闭环(PR3):唯一 resolver + 三入口 + 旧端点 410 + completed 终态 + 单事务防双结算 + 四段式超时\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR3 FAILED\n  ✅ pass ${pass}  ❌ fail ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally {
  try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ }
}
