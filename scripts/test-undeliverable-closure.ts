#!/usr/bin/env tsx
/**
 * PR-B2:undeliverable/拒收收口 —— 状态机 + 卖家举证动作 + 争议窗口 + direct_p2p 收口(声誉 only)。
 * fault-neutral + 证据裁决。escrow 轨【门控关闭】(资金收口由 B3 接)。真 express + 真 transition/settleFault/
 * checkTimeouts/recordViolationReputation/createDispute。
 * 自检锚:D1(不自动判) · D2/D3(证据+快照锚) · D4(direct_p2p 仅声誉零资金零回补) · Guardrail C(X 窗口).
 * Usage: npm run test:undeliverable-closure
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'undeliv-b2-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initSystemUser, transition, settleFault, checkTimeouts } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initReputationSchema, recordViolationReputation } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema, createDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { walletUnits } = await import('../src/ledger.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderChainSchema(db)
for (const c of ["fulfillment_mode TEXT DEFAULT 'shipped'", "source TEXT DEFAULT 'shop'", 'settled_fault_at TEXT', 'has_pending_claim INTEGER DEFAULT 0', 'decline_objective_pending INTEGER DEFAULT 0', 'decline_contested INTEGER DEFAULT 0', 'decline_contest_deadline TEXT'])
  { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c}`) } catch {} }
try { db.exec('ALTER TABLE evidence ADD COLUMN flag_reasons TEXT') } catch {}
initReputationSchema(db); initDisputeSchema(db); initSystemUser(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','买家','buyer','kb'),('seller1','卖家','seller','ks'),('log1','物流','logistics','kl')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('buyer1',0),('seller1',100)").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p1','seller1','P','d',50,100)").run()
// 预置 buyer1 声誉汇总行 —— recordRepEvent 首事件走 INSERT 分支(violations 硬置 0,pre-existing 行为);
//   预置行使后续 violation 走 UPDATE 分支,才能验 isViolation 计数(U5g)。
db.prepare("INSERT INTO reputation_scores (user_id, total_points, transactions_done, disputes_won, disputes_lost, violations, level) VALUES ('buyer1', 0, 0, 0, 0, 0, 'new')").run()
// PR-B1 已 seed undeliverable_closure_enabled=0;本测试大部分用例需开启 →置 1(U1 先测关闭态)。

const status = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status?: string } | undefined)?.status
const dfDeadline = (id: string) => (db.prepare('SELECT delivery_failed_deadline FROM orders WHERE id=?').get(id) as { delivery_failed_deadline?: string } | undefined)?.delivery_failed_deadline
const stockOf = () => (db.prepare("SELECT stock FROM products WHERE id='p1'").get() as { stock: number }).stock
const wu = (u: string) => walletUnits(db, u)
const repEvents = (uid: string) => db.prepare("SELECT event_type, points FROM reputation_events WHERE user_id=? ORDER BY created_at").all(uid) as Array<{ event_type: string; points: number }>
let n = 0
function mkOrder(st: string, rail: string): string {
  const id = `o_${++n}`
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode, shipping_address)
     VALUES (?, 'p1','buyer1','seller1',1,50,50,?,?,?,'shipped','快照地址 123 Main St')`).run(id, rail === 'escrow' ? 50 : 0, st, rail)
  return id
}

let counter = 0
const app = express(); app.use(express.json())
registerOrdersActionRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: (req.headers['x-test-role'] as string) || 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++counter}`,
  transition, notifyTransition: () => {}, settleOrder: () => {}, settleFault, detectFraud: () => [],
  createDispute, checkTimeouts: () => ({ details: [] }), recordViolationReputation, broadcastSystemEvent: () => {},
  consumeGateToken: () => true,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
function call(orderId: string, body: Record<string, unknown>, uid?: string, role?: string): Promise<{ status: number; json: { error_code?: string; error?: string } }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (uid) headers['x-test-uid'] = uid; if (role) headers['x-test-role'] = role
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/orders/${orderId}/action`, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}

// ═══ U1:rollout flag 关闭 → 拒(默认关,分阶段启用)═══
{
  const o = mkOrder('shipped', 'direct_p2p')
  const r = await call(o, { action: 'mark_undeliverable', evidence_description: '承运商退回:地址无法投递(引用快照地址)' }, 'seller1', 'seller')
  ok('U1. flag 关闭 → 403 UNDELIVERABLE_DISABLED(不启用)', r.status === 403 && r.json.error_code === 'UNDELIVERABLE_DISABLED', JSON.stringify(r))
}
// 开启 rollout flag(其余用例)
db.prepare("UPDATE protocol_params SET value='1' WHERE key='undeliverable_closure_enabled'").run()

// ═══ U2:escrow 轨门控(B3 未上)→ 拒 ═══
{
  const o = mkOrder('shipped', 'escrow')
  const r = await call(o, { action: 'mark_undeliverable', evidence_description: '退回证明' }, 'seller1', 'seller')
  ok('U2. escrow 轨 → 409 UNDELIVERABLE_ESCROW_PENDING(资金收口留 B3)', r.status === 409 && r.json.error_code === 'UNDELIVERABLE_ESCROW_PENDING', JSON.stringify(r))
  ok('U2b. escrow 单未进 delivery_failed', status(o) === 'shipped')
}
// ═══ U3:direct_p2p + 证据 → delivery_failed + 争议窗口(ISO,X=120h)═══
{
  const o = mkOrder('shipped', 'direct_p2p')
  const r = await call(o, { action: 'mark_undeliverable', evidence_description: '承运商"无法投递"通知,发至快照地址 123 Main St' }, 'seller1', 'seller')
  const dl = dfDeadline(o)
  ok('U3. direct_p2p 举证 → 200 delivery_failed', r.status === 200 && status(o) === 'delivery_failed', JSON.stringify(r))
  ok('U3b. 置 delivery_failed_deadline(ISO,Guardrail C)', !!dl && dl.includes('T'), `dl=${dl}`)
}
// ═══ U4:无证据 → 转移被 requiresEvidence 拒(D2/D3 举证责任)═══
{
  const o = mkOrder('shipped', 'direct_p2p')
  const r = await call(o, { action: 'mark_undeliverable' }, 'seller1', 'seller')
  ok('U4. 无证据 → 409 UNDELIVERABLE_MARK_FAILED(requiresEvidence 拒),不进 delivery_failed', r.status === 409 && r.json.error_code === 'UNDELIVERABLE_MARK_FAILED' && status(o) === 'shipped', JSON.stringify(r))
}
// ═══ U5:窗口内不争议 → checkTimeouts 落定 fault_buyer→completed;direct_p2p 零资金零回补 + 幂等标记 ═══
{
  const o = mkOrder('shipped', 'direct_p2p')
  await call(o, { action: 'mark_undeliverable', evidence_description: '退回·快照地址' }, 'seller1', 'seller')
  db.prepare("UPDATE orders SET delivery_failed_deadline = datetime('now','-1 hours') WHERE id=?").run(o)   // 窗口已过
  const st0 = stockOf(); const b0 = wu('buyer1'); const s0 = wu('seller1')
  const r5 = checkTimeouts(db)
  ok('U5. 逾期未争议 → fault_buyer 收口至 completed', status(o) === 'completed', `status=${status(o)}`)
  const eq = (a: ReturnType<typeof wu>, b: ReturnType<typeof wu>) => a.balance === b.balance && a.escrowed === b.escrowed && a.staked === b.staked && a.earned === b.earned && (a.fee_staked ?? 0) === (b.fee_staked ?? 0)
  ok('U5b. direct_p2p 零资金移动(D4:买卖双方全钱包字段不变)', eq(wu('buyer1'), b0) && eq(wu('seller1'), s0))
  ok('U5c. direct_p2p 已发出的货【不回补库存】(G7 post-ship + 已出库绝不自动回补)', stockOf() === st0, `before=${st0} after=${stockOf()}`)
  ok('U5d. settled_fault_at 幂等标记落库', !!(db.prepare('SELECT settled_fault_at FROM orders WHERE id=?').get(o) as { settled_fault_at?: string })?.settled_fault_at)
  // U5e:声誉走【真实 cron 布线】—— 从 checkTimeouts detail 经 /→ (fault_\w+)/ 提取(非直接 hand-call),防 detail↔正则契约漂移导致 prod 零记录。
  const det = r5.details.find(d => d.orderId === o); const m = det?.action.match(/→ (fault_\w+)/)
  ok('U5e. checkTimeouts detail 命中 cron 正则 → fault_buyer(prod 布线守卫)', !!m && m[1] === 'fault_buyer', JSON.stringify(det))
  recordViolationReputation(db, o, (m ? m[1] : 'fault_buyer'))
  const ev = repEvents('buyer1')
  ok('U5f. 买家声誉 = undeliverable_buyer_fault(-20),非超时违约(-40)', ev.length === 1 && ev[0].event_type === 'undeliverable_buyer_fault' && ev[0].points === -20, JSON.stringify(ev))
  ok('U5g. 违约计数 +1(isViolation 含 undeliverable_buyer_fault)', (db.prepare("SELECT violations FROM reputation_scores WHERE user_id='buyer1'").get() as { violations: number }).violations === 1)
}
// ═══ U6:回归 —— created→fault_buyer(发货前,delivery_failed_deadline NULL)仍回补 + timeout_violation(-40)═══
{
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode) VALUES ('oPre','p1','buyer1','seller1',1,50,50,0,'fault_buyer','direct_p2p','shipped')").run()
  const st0 = stockOf()
  settleFault(db, 'oPre', 'fault_buyer')
  ok('U6. 发货前 created→fault_buyer 仍回补库存(+1,G7 只挡 post-ship)', stockOf() === st0 + 1, `before=${st0} after=${stockOf()}`)
  recordViolationReputation(db, 'oPre', 'fault_buyer')
  const ev = repEvents('buyer1').filter(e => e.event_type === 'timeout_violation')
  ok('U6b. 发货前 fault_buyer 声誉 = timeout_violation(-40)(delivery_failed_deadline NULL 分流)', ev.length === 1 && ev[0].points === -40, JSON.stringify(ev))
}
// ═══ U7:买家在窗口内争议 → disputed + 建 dispute(复用仲裁,D1 不自动判)═══
{
  const o = mkOrder('shipped', 'direct_p2p')
  await call(o, { action: 'mark_undeliverable', evidence_description: '退回·快照地址' }, 'seller1', 'seller')
  const r = await call(o, { action: 'dispute', evidence_description: '卖家发到错误地址,非我提供的快照地址' }, 'buyer1', 'buyer')
  ok('U7. 买家争议 → 200 disputed', r.status === 200 && status(o) === 'disputed', JSON.stringify(r))
  ok('U7b. 建了 dispute(进仲裁,三方按证据裁决)', !!db.prepare("SELECT id FROM disputes WHERE order_id=? AND status IN ('open','in_review')").get(o))
}
// ═══ U8:窗口未到 → 不提前落定(Guardrail C + #299 归一化)═══
{
  const o = mkOrder('shipped', 'direct_p2p')
  await call(o, { action: 'mark_undeliverable', evidence_description: '退回·快照地址' }, 'seller1', 'seller')   // deadline = now+120h(ISO,未来)
  const dl8 = dfDeadline(o)
  checkTimeouts(db)
  ok('U8. 争议窗口未到(未来 ISO deadline)→ 仍 delivery_failed(不提前判买家)', status(o) === 'delivery_failed' && !!dl8 && new Date(dl8).getTime() > Date.now(), `status=${status(o)} dl=${dl8}`)
}
// ═══ U9:防御 —— escrow 若到 fault_buyer 且 delivery_failed_deadline 已置(B2 不可达)→ settleFault fail-loud,不静默锁死 escrow ═══
{
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, fulfillment_mode, delivery_failed_deadline) VALUES ('oEscUn','p1','buyer1','seller1',1,50,50,50,'fault_buyer','escrow','shipped',datetime('now','-1 hours'))").run()
  let threw = false; try { settleFault(db, 'oEscUn', 'fault_buyer') } catch { threw = true }
  ok('U9. escrow undeliverable settleFault fail-loud(防静默锁死 escrow;资金收口=B3)', threw && status('oEscUn') === 'fault_buyer' && !(db.prepare("SELECT settled_fault_at FROM orders WHERE id='oEscUn'").get() as { settled_fault_at?: string })?.settled_fault_at, `threw=${threw}`)
}

server!.close()
if (fail > 0) { console.error(`\n❌ undeliverable-closure FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ undeliverable-closure (PR-B2): ${pass} pass — 状态机 + 举证动作(flag/rail 门控)+ 争议窗口 + direct_p2p 收口(零资金/零回补/-20 声誉)+ 发货前回归`)
