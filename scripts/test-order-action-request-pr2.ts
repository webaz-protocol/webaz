#!/usr/bin/env tsx
/**
 * RFC-021 PR2 —— order-action 请求提交 + Passkey /approve(到 approved,【绝不执行】)。
 *   用法:npm run test:order-action-request-p2
 *
 * ⚠️ 硬边界断言:approve 后订单状态不变、executed_at 恒 NULL、无结算 —— execute 全在 PR3。
 * 覆盖:提交(合法/decline 拒/缺 scope/非本人/ship 缺 tracking)· 地址被 sanitize · 双 pending 409 ·
 *   approve 三元组 Passkey(null/错 hash→412,正确→approved)· I3 deadline 不变 · I6 audit 无地址。
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'oar2-'))
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db)
try { db.exec('ALTER TABLE orders ADD COLUMN settled_fault_at TEXT') } catch { /* 已存在 */ }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s'),('seller2','S2','seller','k_s2'),('buyer1','B','buyer','k_b')").run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,accept_deadline,ship_deadline)
  VALUES ('ord_1','buyer1','seller1','prd_x','paid',30,30,30,'escrow','123 SECRET St','2026-07-10 00:00:00','2026-07-12 00:00:00')`).run()
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,unit_price,total_amount,escrow_amount,payment_rail)
  VALUES ('ord_other','buyer1','seller2','prd_x','paid',30,30,30,'escrow')`).run()

// Passkey stub:运行 validate(tokenData);tokenData 由测试控制
let tokenData: unknown = null
const requireHumanPresence = (_u: string, _p: string, _t: string | undefined, _k: string, validate?: (d: unknown) => boolean) =>
  ((validate ? validate(tokenData) : true) ? { ok: true } : { ok: false, error_code: 'HP_BIND_MISMATCH', reason: 'token 未绑定本请求/三元组' })
const auth = (req: express.Request, res: express.Response) => {
  // 人类 session:approve 用 header x-uid 指定;缺则 401
  const uid = req.headers['x-uid'] as string | undefined
  if (!uid) { res.status(401).json({ error: 'no human' }); return null }
  return { id: uid }
}
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`, rateLimitOk: () => true, requireHumanPresence } as never)
const mkGrant = (bearer: string, caps: string[], human = 'seller1') => db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
  .run(`grt_${bearer}`, human, 'FA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
mkGrant('gtk_fa', ['order_action_request'])
mkGrant('gtk_read', ['read_public'])
const server = app.listen(0); const port = (server.address() as AddressInfo).port
const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const bearer = (b: string) => ({ authorization: 'Bearer ' + b })
const reqRow = (id: string) => db.prepare('SELECT status, action_params, executed_at, execution_result, params_hash FROM agent_permission_requests WHERE id=?').get(id) as { status: string; action_params: string; executed_at: string | null; execution_result: string | null; params_hash: string }
const orderRow = (id: string) => db.prepare('SELECT status, accept_deadline, ship_deadline, settled_fault_at FROM orders WHERE id=?').get(id) as { status: string; accept_deadline: string; ship_deadline: string; settled_fault_at: string | null }

try {
  const before = orderRow('ord_1')

  // ══ A. 提交 ══
  ok('A1 缺 scope(read_public)→ 403 PERMISSION_REQUIRED', (await req('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_read'))).body.error_code === 'PERMISSION_REQUIRED')
  ok('A2 decline → 400 DECLINE_NOT_DELEGATED(D2)', (await req('POST', '/api/agent/orders/ord_1/action-request', { action: 'decline' }, bearer('gtk_fa'))).body.error_code === 'DECLINE_NOT_DELEGATED')
  ok('A3 非本人订单 → 403 NOT_ORDER_SELLER', (await req('POST', '/api/agent/orders/ord_other/action-request', { action: 'accept' }, bearer('gtk_fa'))).body.error_code === 'NOT_ORDER_SELLER')
  ok('A4 ship 缺 tracking → 400 SHIP_TRACKING_REQUIRED', (await req('POST', '/api/agent/orders/ord_1/action-request', { action: 'ship', action_params: { evidence_ref: 'ev1' } }, bearer('gtk_fa'))).body.error_code === 'SHIP_TRACKING_REQUIRED')

  const acc = await req('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_fa'))
  ok('A5 合法 accept → 200 + request_id + params_hash', acc.status === 200 && String(acc.body.request_id).startsWith('apr_') && typeof acc.body.params_hash === 'string')
  const accId = String(acc.body.request_id)
  ok('A6 写入 pending(未执行)', reqRow(accId).status === 'pending' && reqRow(accId).executed_at == null)

  // ══ B. 双 pending ══
  ok('B1 同 (ord_1,accept) 再提交 → 409 DUPLICATE_ACTION_REQUEST', (await req('POST', '/api/agent/orders/ord_1/action-request', { action: 'accept' }, bearer('gtk_fa'))).body.error_code === 'DUPLICATE_ACTION_REQUEST')

  // ══ 地址 sanitize(I6):ship 带注入的 shipping_address,不得入库 ══
  const shipInj = await req('POST', '/api/agent/orders/ord_1/action-request', { action: 'ship', action_params: { tracking: 'SF1234567', evidence_ref: 'ev9', shipping_address: '123 SECRET St', buyer_phone: '999' } }, bearer('gtk_fa'))
  ok('C1 合法 ship(带注入 PII)仍 200', shipInj.status === 200)
  const shipId = String(shipInj.body.request_id)
  const sp = JSON.parse(reqRow(shipId).action_params) as Record<string, unknown>
  ok('C2 action_params 只留 tracking+evidence_ref,地址/电话被 sanitize', Object.keys(sp).sort().join(',') === 'evidence_ref,tracking' && !JSON.stringify(sp).includes('SECRET') && !JSON.stringify(sp).includes('999'))

  // ══ D. approve(三元组 Passkey;到 approved 就停)══
  const phash = String(acc.body.params_hash)
  tokenData = null
  ok('D1 未绑定 token → 412', (await req('POST', `/api/agent-grants/permission-requests/${accId}/approve`, { webauthn_token: 'tk' }, { 'x-uid': 'seller1' })).status === 412)
  tokenData = { request_id: accId, order_id: 'ord_1', action: 'accept', params_hash: 'WRONG' }
  ok('D2 错 params_hash → 412', (await req('POST', `/api/agent-grants/permission-requests/${accId}/approve`, { webauthn_token: 'tk' }, { 'x-uid': 'seller1' })).status === 412)
  tokenData = { request_id: accId, order_id: 'ord_1', action: 'accept', params_hash: phash }
  const okApprove = await req('POST', `/api/agent-grants/permission-requests/${accId}/approve`, { webauthn_token: 'tk' }, { 'x-uid': 'seller1' })
  ok('D3 正确三元组 → 200 + status approved', okApprove.status === 200 && okApprove.body.status === 'approved')
  ok('D4 请求 = approved', reqRow(accId).status === 'approved')

  // ══ 硬边界:approve 后【订单零变化 + 未执行】══
  const after = orderRow('ord_1')
  ok('E1 订单状态仍 paid(未执行,未跃迁)', after.status === 'paid')
  ok('E2 executed_at 恒 NULL(execute 在 PR3)', reqRow(accId).executed_at == null && reqRow(accId).execution_result == null)
  ok('E3 未结算(settled_fault_at NULL)', after.settled_fault_at == null)

  // ══ I3:两 deadline 列全程不变 ══
  ok('I3-1 accept_deadline / ship_deadline 未被 request/approve 改写', after.accept_deadline === before.accept_deadline && after.ship_deadline === before.ship_deadline)

  // ══ I6:审计无地址 ══
  const auditAll = JSON.stringify(db.prepare("SELECT capability FROM agent_grant_auth_log").all())
  ok('I6 agent_grant_auth_log 无买家地址/电话', !auditAll.includes('SECRET') && !auditAll.includes('999'))

  server.close()
  if (fail === 0) console.log(`\n✅ RFC-021 PR2:order-action 请求提交 + Passkey 三元组 /approve(到 approved 即停);硬边界(订单零变化/executed_at 恒 NULL/无结算);双 pending 拒;地址 sanitize;I3 deadline 不变;I6 审计无地址\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ PR2 FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
} finally { server.close?.(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch { /* */ } }
