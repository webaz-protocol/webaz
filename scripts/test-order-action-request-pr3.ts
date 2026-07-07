#!/usr/bin/env tsx
/**
 * RFC-021 PR3 —— 执行 landing。approved 的 order_action 真正执行 accept/ship;api_key 路由与 Passkey-approve
 *   共调同一守卫内置执行器 executeSellerOrderAction;execute 对 agent-bearer 不可达(I1)。钱路相邻。
 *   用法:npm run test:order-action-request-p3
 *
 * 覆盖:E2E(agent 提交→真实 token approve→执行→订单状态真变 + executed_at + execution_result)·
 *   双路径守卫一致(核心守卫逐一相同;I4 仅 strict)· I1(agent 不可达执行器)· I5(重放/幂等 executed_at CAS)·
 *   I4(strict 侧占位/非法 tracking 执行被拒、订单不 transition、请求保持 approved)· 守卫(非本人/错状态/过 SLA)·
 *   I3(执行前后 deadline 不变)· 硬边界回归(decline 不可 delegate、无 settleFault)。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'oar3-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { executeSellerOrderAction, validateTrackingContent } = await import('../src/pwa/order-action-exec.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = '2026-07-08T00:00:00Z'; const FUTURE = '2026-07-20 00:00:00'; const PAST = '2000-01-01 00:00:00'

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db); initOrderChainSchema(db)
try { db.exec('ALTER TABLE orders ADD COLUMN settled_fault_at TEXT') } catch { /* */ }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s'),('seller2','S2','seller','k_s2'),('buyer1','B','buyer','k_b')").run()
let ordSeq = 0
const seedOrder = (status: string, over: Record<string, string> = {}): string => {
  const id = `ord_${++ordSeq}`
  db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,accept_deadline,ship_deadline)
    VALUES (?,?,?,?,?,30,30,30,'escrow',?,?)`).run(id, 'buyer1', over.seller || 'seller1', 'prd_x', status, over.accept_deadline || FUTURE, over.ship_deadline || FUTURE)
  return id
}
const orderRow = (id: string) => db.prepare('SELECT status, accept_deadline, ship_deadline, settled_fault_at FROM orders WHERE id=?').get(id) as { status: string; accept_deadline: string; ship_deadline: string; settled_fault_at: string | null }
const reqRow = (id: string) => db.prepare('SELECT status, executed_at, execution_result FROM agent_permission_requests WHERE id=?').get(id) as { status: string; executed_at: string | null; execution_result: string | null }

const { requireHumanPresence } = createHumanPresence(db, (_k, fb) => fb)
let tokSeq = 0
const mintToken = (userId: string, pd: Record<string, unknown>): string => { const id = `tok_${++tokSeq}`; db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,datetime('now','+60 seconds'))").run(id, userId, 'agent_permission_approve', JSON.stringify(pd)); return id }
const auth = (req: express.Request, res: express.Response) => { const uid = req.headers['x-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'no human' }); return null } return { id: uid } }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`, rateLimitOk: () => true, requireHumanPresence } as never)
const mkGrant = (bearer: string, caps: string[]) => db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)").run(`grt_${bearer}`, 'seller1', 'FA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
mkGrant('gtk_fa', ['order_action_request'])
const server = app.listen(0); const port = (server.address() as AddressInfo).port
const rq = async (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json', ...h }, ...(b != null ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> } }
const bearer = (b: string) => ({ authorization: 'Bearer ' + b })
// 端到端:agent 提交 → list 取三元组 → 真实 token → approve(=执行)
const e2e = async (orderId: string, action: string, actionParams?: Record<string, unknown>) => {
  const sub = await rq('POST', `/api/agent/orders/${orderId}/action-request`, { action, action_params: actionParams }, bearer('gtk_fa'))
  if (sub.status !== 200) return { sub, approve: null as null | { status: number; body: Record<string, unknown> } }
  const reqId = String(sub.body.request_id)
  const list = await rq('GET', '/api/agent-grants/permission-requests', undefined, { 'x-uid': 'seller1' })
  const item = (list.body.requests as Array<Record<string, unknown>>).find(x => x.id === reqId)!
  const tok = mintToken('seller1', { request_id: reqId, order_id: item.order_id, action: item.order_action, params_hash: item.params_hash })
  const approve = await rq('POST', `/api/agent-grants/permission-requests/${reqId}/approve`, { webauthn_token: tok }, { 'x-uid': 'seller1' })
  return { sub, approve, reqId }
}

try {
  // ══ E2E accept ══
  { const oid = seedOrder('paid')
    const { approve, reqId } = await e2e(oid, 'accept')
    ok('E2E-1 accept approve → 200 executed + order_status accepted', approve!.status === 200 && approve!.body.status === 'executed' && approve!.body.order_status === 'accepted')
    ok('E2E-2 订单状态【真变】paid→accepted', orderRow(oid).status === 'accepted')
    ok('E2E-3 executed_at 写入 + execution_result 记录', reqRow(reqId!).executed_at != null && String(reqRow(reqId!).execution_result).includes('"ok":true'))
    ok('E2E-4 未结算(accept 不动钱,I8)', orderRow(oid).settled_fault_at == null)
  }
  // ══ E2E ship(strict tracking 合法)══
  { const oid = seedOrder('accepted')
    const { approve } = await e2e(oid, 'ship', { tracking: 'SF12345678', evidence_ref: 'ev1' })
    ok('E2E-5 ship 合法单号 approve → executed + shipped', approve!.status === 200 && orderRow(oid).status === 'shipped')
    ok('E2E-6 未结算(ship 不动钱)', orderRow(oid).settled_fault_at == null)
  }

  // ══ I4:strict 侧占位/非法 tracking 执行被拒 ══
  { const oid = seedOrder('accepted')
    const { approve, reqId } = await e2e(oid, 'ship', { tracking: '00000000', evidence_ref: 'ev' })   // 全0 占位(提交侧仅查 presence,过)
    ok('I4-1 占位单号 00000000 执行侧被拒 → 4xx INVALID_TRACKING', approve!.status === 400 && approve!.body.error_code === 'INVALID_TRACKING')
    ok('I4-2 订单未 transition(仍 accepted)', orderRow(oid).status === 'accepted')
    ok('I4-3 请求保持 approved 可重试(executed_at NULL)', reqRow(reqId!).status === 'approved' && reqRow(reqId!).executed_at == null)
  }
  ok('I4-4 validateTrackingContent:合法/短/非法字符/占位', validateTrackingContent('SF12345678').ok && !validateTrackingContent('SF12').ok && !validateTrackingContent('SF 123 456').ok && !validateTrackingContent('aaaaaaaa').ok && !validateTrackingContent('N/A').ok)

  // ══ I5:重放(已执行)幂等 ══
  { const oid = seedOrder('paid')
    const { reqId } = await e2e(oid, 'accept')   // 执行成功
    const eAt = reqRow(reqId!).executed_at
    const list = await rq('GET', '/api/agent-grants/permission-requests', undefined, { 'x-uid': 'seller1' })   // 已 approved+executed 不在 pending list;直接 mint 重放
    const phash = sha(JSON.stringify({ order_id: oid, action: 'accept', params: {} }))
    const tok = mintToken('seller1', { request_id: reqId, order_id: oid, action: 'accept', params_hash: phash })
    const replay = await rq('POST', `/api/agent-grants/permission-requests/${reqId}/approve`, { webauthn_token: tok }, { 'x-uid': 'seller1' })
    ok('I5-1 已执行请求重放 → already_executed(不重复执行)', replay.status === 200 && replay.body.already_executed === true)
    ok('I5-2 executed_at 未变(只执行一次)', reqRow(reqId!).executed_at === eAt)
    ok('I5-3 订单状态未被二次改动(仍 accepted)', orderRow(oid).status === 'accepted')
    void list
  }

  // ══ 双路径守卫一致(直调执行器:核心守卫与 strictTracking 无关;I4 仅 strict)══
  { // 非本人:两 strict 值都拒
    const oid = seedOrder('paid')
    const ak = executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller2', nowIso: NOW, strictTracking: false, generateId: (p) => `${p}_a`, path: 'api_key' })
    const ap = executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller2', nowIso: NOW, strictTracking: true, generateId: (p) => `${p}_b`, path: 'approve' })
    ok('GUARD-1 非本人:两路径一致 NOT_ORDER_SELLER', ak.error_code === 'NOT_ORDER_SELLER' && ap.error_code === 'NOT_ORDER_SELLER' && orderRow(oid).status === 'paid')
  }
  { // 错状态:accept on shipped
    const oid = seedOrder('shipped')
    const ak = executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller1', nowIso: NOW, strictTracking: false, generateId: (p) => `${p}_a`, path: 'api_key' })
    const ap = executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller1', nowIso: NOW, strictTracking: true, generateId: (p) => `${p}_b`, path: 'approve' })
    ok('GUARD-2 错状态:两路径一致 WRONG_STATUS', ak.error_code === 'WRONG_STATUS' && ap.error_code === 'WRONG_STATUS')
  }
  { // 过 SLA:accept_deadline 过去
    const oid = seedOrder('paid', { accept_deadline: PAST })
    const ak = executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller1', nowIso: NOW, strictTracking: false, generateId: (p) => `${p}_a`, path: 'api_key' })
    const ap = executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller1', nowIso: NOW, strictTracking: true, generateId: (p) => `${p}_b`, path: 'approve' })
    ok('GUARD-3 过 SLA:两路径一致 SLA_EXPIRED', ak.error_code === 'SLA_EXPIRED' && ap.error_code === 'SLA_EXPIRED')
  }
  { // I4 仅 strict:占位单号 → strict 拒、非 strict 放行(evidence 走 description)
    const oidA = seedOrder('accepted'); const oidB = seedOrder('accepted')
    const nonStrict = executeSellerOrderAction(db, { orderId: oidA, action: 'ship', actorId: 'seller1', nowIso: NOW, strictTracking: false, evidenceDescription: '自发货,单号后补', generateId: (p) => `${p}_a`, path: 'api_key' })
    const strict = executeSellerOrderAction(db, { orderId: oidB, action: 'ship', actorId: 'seller1', nowIso: NOW, strictTracking: true, tracking: '00000000', generateId: (p) => `${p}_b`, path: 'approve' })
    ok('GUARD-4 I4 仅 strict:非 strict 无单号发货放行、strict 占位单号被拒', nonStrict.ok === true && orderRow(oidA).status === 'shipped' && strict.error_code === 'INVALID_TRACKING' && orderRow(oidB).status === 'accepted')
  }
  { // I3:执行前后 deadline 两列不变
    const oid = seedOrder('paid'); const b = orderRow(oid)
    executeSellerOrderAction(db, { orderId: oid, action: 'accept', actorId: 'seller1', nowIso: NOW, strictTracking: false, generateId: (p) => `${p}_a`, path: 'api_key' })
    const a = orderRow(oid)
    ok('I3 执行前后 accept/ship_deadline 不变', a.accept_deadline === b.accept_deadline && a.ship_deadline === b.ship_deadline && a.status === 'accepted')
  }

  // ══ I1:agent-bearer 不可达执行器 ══
  ok('I1-1 order-action-request.ts(agent-submit 域)不 import 执行器', !/from '\.\/order-action-exec/.test(readFileSync('src/pwa/order-action-request.ts', 'utf8')))
  ok('I1-2 执行器仅被 api_key 路由 + approve handler import', /executeSellerOrderAction/.test(readFileSync('src/pwa/routes/orders-action.ts', 'utf8')) && /approveAndExecuteOrderAction/.test(readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')))
  { // agent 提交 request 后【不执行】(submit≠execute);且 agent-bearer 打 /approve → 401(无人类 session)
    const oid = seedOrder('paid')
    const sub = await rq('POST', `/api/agent/orders/${oid}/action-request`, { action: 'accept' }, bearer('gtk_fa'))
    ok('I1-3 agent 提交后订单零变化(submit≠execute)', sub.status === 200 && orderRow(oid).status === 'paid')
    const agentApprove = await rq('POST', `/api/agent-grants/permission-requests/${String(sub.body.request_id)}/approve`, { webauthn_token: 'x' }, bearer('gtk_fa'))
    ok('I1-4 agent-bearer 打 /approve → 401(需人类 session,execute 不可达)', agentApprove.status === 401 && orderRow(oid).status === 'paid')
  }

  // ══ 硬边界回归 ══
  ok('HB-1 decline 仍不可 delegate', (await rq('POST', '/api/agent/orders/ord_1/action-request', { action: 'decline' }, bearer('gtk_fa'))).body.error_code === 'DECLINE_NOT_DELEGATED')
  { const execSrc = readFileSync('src/pwa/order-action-exec.ts', 'utf8')
    const imports = execSrc.split('\n').filter(l => l.trimStart().startsWith('import'))
    ok('HB-2 执行器不 import money/ledger/结算,不调 settleFault/settleDeclinedNoFault/applyWalletDelta(I8)',
      !imports.some(l => /money\.js|ledger\.js|settleFault|settleDeclinedNoFault|settleOrder/.test(l)) && !/settleFault\(|settleDeclinedNoFault\(|applyWalletDelta\(|settleOrder\(/.test(execSrc)) }

  server.close()
  if (fail === 0) console.log(`\n✅ RFC-021 PR3:执行 landing —— 真实 e2e(agent→approve→执行,订单真变+executed_at)· 双路径守卫一致(核心一致,I4 仅 strict)· I1 agent 不可达 · I5 幂等 · I4 执行侧重校 · I3 deadline 不变 · 硬边界(无 settleFault)\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR3 FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally { server.close?.(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ } }
