#!/usr/bin/env tsx
/**
 * RFC-021 PR2(重审版)—— order-action 请求提交 + 真实 Passkey /approve(到 approved,【绝不执行】)。
 *   用法:npm run test:order-action-request-p2
 *
 * 阶段契约(Codex P1-a):PR2 只测【提交 → approved 的提交/审批机制】—— Passkey 绑三元组、CAS、过期、去重、地址 sanitize、
 *   提交侧不改 deadline(I3)。approved→【执行】语义(订单状态真变 / executed_at / 幂等 / 不结算)属 PR3 契约,不在此重复断言。
 * P1-a 审批闭环:走【真实 requireHumanPresence + 真实 gate token】,token 的 purpose_data 由【list 响应字段】拼装
 *   —— 不伪造/手拼三元组 token(上轮漏洞根因)。list 缺 params_hash 则拼不出正确 token → approve 必 412。
 * P1-b:过期 CAS 原子(approve-after-expire 必失败,过期请求仍 pending)。
 * P2-a:approved 占锁 —— 同 (order_id,action) 重提被唯一索引/服务端拒(approved 请求仍占锁)。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'oar2-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE orders ADD COLUMN settled_fault_at TEXT') } catch { /* */ }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s'),('seller2','S2','seller','k_s2'),('buyer1','B','buyer','k_b')").run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,accept_deadline,ship_deadline)
  VALUES ('ord_1','buyer1','seller1','prd_x','paid',30,30,30,'escrow','123 SECRET St',datetime('now','+2 days'),datetime('now','+4 days'))`).run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail)
  VALUES ('ord_other','buyer1','seller2','prd_x','paid',30,30,30,'escrow')`).run()

// 真实 human-presence(getProtocolParam 缺 → fallback 1 → 强制 Passkey)
const { requireHumanPresence } = createHumanPresence(db, (_k, fb) => fb)
// 真实 gate token 铸造(模拟 WebAuthn 仪式产物;purpose_data 由测试从 list 响应拼装,不伪造 validate)
let tokSeq = 0
const mintToken = (userId: string, purposeData: Record<string, unknown>): string => {
  const id = `tok_${++tokSeq}`
  db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,datetime('now','+60 seconds'))").run(id, userId, 'agent_permission_approve', JSON.stringify(purposeData))
  return id
}
const auth = (req: express.Request, res: express.Response) => { const uid = req.headers['x-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'no human' }); return null } return { id: uid } }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`, rateLimitOk: () => true, requireHumanPresence } as never)
const mkGrant = (bearer: string, caps: string[], human = 'seller1') => db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
  .run(`grt_${bearer}`, human, 'FA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
mkGrant('gtk_fa', ['order_action_request']); mkGrant('gtk_read', ['read_public'])
const server = app.listen(0); const port = (server.address() as AddressInfo).port
const rq = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const bearer = (b: string) => ({ authorization: 'Bearer ' + b })
const reqRow = (id: string) => db.prepare('SELECT status, action_params, executed_at, execution_result FROM agent_permission_requests WHERE id=?').get(id) as { status: string; action_params: string; executed_at: string | null; execution_result: string | null }
const orderRow = (id: string) => db.prepare('SELECT status, accept_deadline, ship_deadline, settled_fault_at FROM orders WHERE id=?').get(id) as { status: string; accept_deadline: string; ship_deadline: string; settled_fault_at: string | null }
// 从 list 取某 request 的 order_action 字段(如前端所见)
const listFields = async (id: string) => {
  const l = await rq('GET', '/api/agent-grants/permission-requests', undefined, { 'x-uid': 'seller1' })
  const item = (l.body.requests as Array<Record<string, unknown>>).find(x => x.id === id)!
  return item
}

try {
  const before = orderRow('ord_1')

  // ══ A. 提交 ══
  ok('A1 缺 scope → 403 PERMISSION_REQUIRED', (await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_read'))).body.error_code === 'PERMISSION_REQUIRED')
  ok('A2 decline → 400 DECLINE_NOT_DELEGATED', (await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'decline' }, bearer('gtk_fa'))).body.error_code === 'DECLINE_NOT_DELEGATED')
  ok('A3 非本人订单 → 403 NOT_ORDER_SELLER', (await rq('POST', '/api/agent/orders/ord_other/action-request', { action: 'accept' }, bearer('gtk_fa'))).body.error_code === 'NOT_ORDER_SELLER')
  ok('A4 ship 缺 tracking → 400 SHIP_TRACKING_REQUIRED', (await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'ship', action_params: { evidence_ref: 'ev1' } }, bearer('gtk_fa'))).body.error_code === 'SHIP_TRACKING_REQUIRED')
  const acc = await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_fa'))
  const accId = String(acc.body.request_id)
  ok('A5 合法 accept → 200 + pending', acc.status === 200 && reqRow(accId).status === 'pending')

  // 地址 sanitize:ship 注入 shipping_address 不入库
  const shipInj = await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'ship', action_params: { tracking: 'SF1234567', evidence_ref: 'ev9', shipping_address: '123 SECRET St' } }, bearer('gtk_fa'))
  const sp = JSON.parse(reqRow(String(shipInj.body.request_id)).action_params) as Record<string, unknown>
  ok('A6 action_params 只留 tracking+evidence_ref(地址被 sanitize)', Object.keys(sp).sort().join(',') === 'evidence_ref,tracking' && !JSON.stringify(sp).includes('SECRET'))

  // ══ B. 双 pending ══
  ok('B1 同 (ord_1,accept) 再提交 → 409 DUPLICATE_ACTION_REQUEST', (await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_fa'))).body.error_code === 'DUPLICATE_ACTION_REQUEST')

  // ══ P1-a:list 返回 order_action 字段(前端据此绑 token)══
  const lf = await listFields(accId)
  ok('P1a-1 list 含 kind/order_id/order_action/params_hash', lf.kind === 'order_action' && lf.order_id === 'ord_1' && lf.order_action === 'accept' && typeof lf.params_hash === 'string' && String(lf.params_hash).length === 64)
  ok('P1a-2 list 不含任何买家地址/PII', !JSON.stringify(lf).includes('SECRET'))

  // ══ P1-a:真实 token approve(purpose_data 从 list 拼装,不伪造)══
  //   错 params_hash → 412(证明必须用 list 的真值)
  const badTok = mintToken('seller1', { request_id: accId, order_id: lf.order_id, action: lf.order_action, params_hash: 'WRONGHASH' })
  ok('P1a-3 错 params_hash 的真实 token → 412', (await rq('POST', `/api/agent-grants/permission-requests/${accId}/approve`, { webauthn_token: badTok }, { 'x-uid': 'seller1' })).status === 412)
  //   正确 purpose_data(全取自 list)→ approve 成功
  const okTok = mintToken('seller1', { request_id: accId, order_id: lf.order_id, action: lf.order_action, params_hash: lf.params_hash })
  const okApprove = await rq('POST', `/api/agent-grants/permission-requests/${accId}/approve`, { webauthn_token: okTok }, { 'x-uid': 'seller1' })
  ok('P1a-4 list 字段拼装的真实 token → 200 success(审批闭环通;approve→执行 结果属 PR3 契约)', okApprove.status === 200 && okApprove.body.success === true)
  ok('P1a-5 请求进 approved(占锁生效)', reqRow(accId).status === 'approved')

  // ══ 提交侧不改 deadline(I3;approved→执行 语义在 PR3 契约,不在此断言)══
  const after = orderRow('ord_1')
  ok('I3 accept/ship_deadline 未被改写', after.accept_deadline === before.accept_deadline && after.ship_deadline === before.ship_deadline)

  // ══ P2-a:approved 占锁 —— 同 (ord_1,accept) 重提被拒(approved 请求仍占唯一索引)══
  ok('P2a approved 占锁:同 (ord_1,accept) 重提 → 409 DUPLICATE(唯一索引含 approved)', (await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_fa'))).body.error_code === 'DUPLICATE_ACTION_REQUEST')

  // ══ P1-b:approve-after-expire 必失败(过期在 CAS 里判)══
  //   新单(ship)→ 手动置 expires_at 过去 → 真实 token → CAS 0 行 → 409
  db.prepare("UPDATE agent_permission_requests SET status='pending' WHERE id=?").run(accId)   // 复位不影响:另用新 order
  db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail) VALUES ('ord_exp','buyer1','seller1','prd_x','accepted',30,30,30,'escrow')`).run()
  const shipReq = await rq('POST', '/api/agent/orders/ord_exp/action-request', { action: 'ship', action_params: { tracking: 'SF7654321', evidence_ref: 'evx' } }, bearer('gtk_fa'))
  const shipId = String(shipReq.body.request_id)
  db.prepare("UPDATE agent_permission_requests SET expires_at=datetime('now','-1 hour') WHERE id=?").run(shipId)   // 令其过期
  const expTok = mintToken('seller1', { request_id: shipId, order_id: 'ord_exp', action: 'ship', params_hash: String(shipReq.body.params_hash) })
  ok('P1b-2 approve-after-expire → 409(CAS expires_at 守卫)', (await rq('POST', `/api/agent-grants/permission-requests/${shipId}/approve`, { webauthn_token: expTok }, { 'x-uid': 'seller1' })).status === 409)
  ok('P1b-3 过期请求仍 pending(未被 approve)', (db.prepare('SELECT status FROM agent_permission_requests WHERE id=?').get(shipId) as { status: string }).status === 'pending')

  // ══ P1-a 前端锚点(真实前端 wiring,非伪造)══
  const uiOrder = readFileSync('src/pwa/public/app-agent-approvals-order.js', 'utf8')
  ok('UI-1 app-agent-approvals-order.js 定义 aaOrderWhat 渲染 order_id/order_action', /window\.aaOrderWhat/.test(uiOrder) && /r\.order_id/.test(uiOrder) && /r\.order_action/.test(uiOrder))
  const uiAppr = readFileSync('src/pwa/public/app-agent-approvals.js', 'utf8')
  ok('UI-2 aaApprove 绑三元组(order_id/action/params_hash from data-*)', /order_id:.*dataset\.aaOrderId/.test(uiAppr) && /action:.*dataset\.aaAction/.test(uiAppr) && /params_hash:.*dataset\.aaHash/.test(uiAppr))
  ok('UI-3 aaCard 落 data-aa-hash(供 aaApprove 取 params_hash)', /data-aa-hash=/.test(uiAppr) && /r\.kind === 'order_action'/.test(uiAppr))

  server.close()
  if (fail === 0) console.log(`\n✅ RFC-021 PR2(阶段契约=提交→approved 机制):真实 Passkey 审批闭环(list→真实 token→approve,不伪造)+ P1-b 过期 CAS(仍 pending)+ P2-a approved 占锁 + 地址 sanitize + 提交侧 I3(approved→执行 语义属 PR3)\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR2 FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally { server.close?.(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ } }
