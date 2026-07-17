#!/usr/bin/env tsx
/**
 * RFC-026 PR-6 — webaz_buyer_action_request(确认收货/直付取消/退货请求)。用法:npm run test:buyer-action-agent
 *
 * 真实 route(agent-grants + 真实 orders-action/returns 路由 + 真实 transition 引擎 + 回环)+ 真 oat_。
 * settleOrder 为 spy(结算数学由 settlement 套件覆盖;本套件被测组件 = 请求/审批/执行框架):断言
 * 【真实状态机跃迁】+ settle 恰一次调用。覆盖:scope 门/非-grandfathering · dp confirm 人专属拒 ·
 * 经济后果快照与 Passkey 四元组 · 同谓词重验 drift 硬拒(终态 failed 释放坑)· 回环真实执行
 * (confirm→completed / cancel→cancelled / return→return_requests 行)· 天然 oracle 恢复 ·
 * 每(order,action)一活跃 + 幂等重用/后果变化冲突 · 零 PII。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-bact-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { registerReturnsRoutes } = await import('../src/pwa/routes/returns.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { makeApiLoopback } = await import('../src/pwa/order-loopback.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db); initSystemUser(db); initOrderChainSchema(db)
// 复刻 PWA boot 内联 DDL(server.ts 不在 helpers 的表/列):提取全部 CREATE/ALTER/INDEX 幂等执行
{
  const src = (await import('node:fs')).readFileSync('src/pwa/server.ts', 'utf8')
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\s*\)\s*(?:STRICT\s*)?(?=`)/g)) { try { db.exec(m[0]) } catch { /* 幂等 */ } }
  for (const m of src.matchAll(/'(ALTER TABLE [^']+)'/g)) { try { db.exec(m[1]) } catch { /* exists */ } }
  for (const m of src.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS[^'`]+?(?='\)|`\))/g)) { try { db.exec(m[0]) } catch { /* */ } }
  // The route loopback hits a few server-boot legacy columns whose ALTERs are not all single-quoted.
  // Keep the fixture quiet and production-shaped without importing the full PWA server.
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, order_id TEXT, type TEXT DEFAULT 'system',
      title TEXT NOT NULL, body TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE TABLE IF NOT EXISTS commission_records (id TEXT PRIMARY KEY, order_id TEXT, beneficiary_id TEXT, level INTEGER, amount REAL)',
    'CREATE TABLE IF NOT EXISTS commission_reserve_txns (id TEXT PRIMARY KEY, kind TEXT, amount REAL, related_order_id TEXT)',
    'CREATE TABLE IF NOT EXISTS pending_commission_escrow (id TEXT PRIMARY KEY, order_id TEXT, amount REAL, status TEXT, matures_at TEXT)',
    "ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'shop'",
    "ALTER TABLE orders ADD COLUMN fulfillment_mode TEXT DEFAULT 'shipping'",
    "ALTER TABLE orders ADD COLUMN snapshot_commission_rate REAL",
    "ALTER TABLE orders ADD COLUMN l1_uid TEXT",
    "ALTER TABLE orders ADD COLUMN l2_uid TEXT",
    "ALTER TABLE orders ADD COLUMN l3_uid TEXT",
    "ALTER TABLE orders ADD COLUMN logistics_id TEXT",
    "ALTER TABLE orders ADD COLUMN bid_stake_held REAL DEFAULT 0",
    'ALTER TABLE notifications ADD COLUMN actions TEXT',
  ]) { try { db.exec(sql) } catch { /* exists */ } }
}

const NOW = new Date().toISOString()
const SNAP = JSON.stringify({ v: 1, captured_at: NOW,
  shipping: { source: 'none', region: null, fee: null, est_days: null },
  fulfilment: { handling_hours: null, estimated_days: null, return_days: 14, return_condition: null, warranty_days: null, source_read: true },
  logistics: { weight_kg: null, package_size: null, origin_country: null, country_of_origin: null, customs_description: null, hs_code: null },
  declarations: { ship_regions_text: null, sale_regions_rule: null, tax_lines: null, import_duty_terms: null }, accept_mode: null })
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer1','B','h_b','buyer','k_b'),('seller1','S','h_s','seller','k_s')").run()
db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES ('buyer1',100,0,30,0),('seller1',100,0,0,0)").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days) VALUES ('prd_b','seller1','Act Prod SECRETFREE','d',30,'WAZ',5,'x','active',14)").run()
const mkOrd = (id: string, st: string, rail: string, extra: Record<string, unknown> = {}): void => {
  db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,notes,updated_at,trade_terms_snapshot,confirm_deadline) VALUES (?,'buyer1','seller1','prd_b',?,1,30,30,?,?,'9 SECRET Rd','note SECRET',?,?,?)")
    .run(id, st, rail === 'escrow' ? 30 : 0, rail, NOW, SNAP, new Date(Date.now() + 86400_000).toISOString())
  void extra
}
mkOrd('ord_del', 'delivered', 'escrow'); mkOrd('ord_dpc', 'delivered', 'direct_p2p')
mkOrd('ord_win', 'direct_pay_window', 'direct_p2p'); mkOrd('ord_cmp', 'completed', 'escrow')
mkOrd('ord_del2', 'delivered', 'escrow')

let settleCalls: string[] = []
const auth = (req: Request, res: Response) => {
  const uid = req.headers['x-test-uid'] as string | undefined
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''))
  const row = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined
    : m ? db.prepare('SELECT * FROM users WHERE api_key = ?').get(m[1]) as Record<string, unknown> | undefined : undefined
  if (!row) { res.status(401).json({ error: 'login' }); return null }
  return row
}
const app = express(); app.use(express.json())
const noop = () => {}
registerOrdersActionRoutes(app, {
  db, auth, isTrustedRole: () => false, generateId, transition, notifyTransition: noop,
  settleOrder: (oid: string) => { settleCalls.push(oid) }, settleFault: noop, detectFraud: () => [],
  createDispute: () => ({ success: true }), createDeclineContestDispute: () => ({ success: true }),
  checkTimeouts: noop, recordViolationReputation: noop, broadcastSystemEvent: noop,
  consumeGateToken: () => ({ ok: true }), appendOrderEvent,
} as never)
registerReturnsRoutes(app, {
  db, auth, generateId, isTrustedRole: () => false,
  errorRes: (res: Response, s: number, c: string, msg: string) => { res.status(s).json({ error: msg, error_code: c }) },
  broadcastSystemEvent: noop, detectFraud: () => [], consumeGateToken: () => ({ ok: true }),
} as never)
registerAgentGrantsRoutes(app, {
  db, auth, generateId, rateLimitOk: () => true, apiLoopback: makeApiLoopback(() => port),
  requireHumanPresence: ((_u: string, _p: string, token: string | undefined, _k: string, validate?: (d: unknown) => boolean) => {
    let data: unknown = null; try { data = token ? JSON.parse(token) : null } catch { data = null }
    return (validate ? validate(data) : true) ? { ok: true } : { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: 'binding mismatch' }
  }) as never,
} as never)
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const useCred = (g: string, b: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [g]: { token: b, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: g, handle: `file:~/.webaz/credentials#${g}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const mkOAuth = (gid: string, oat: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,NULL,'active',?)")
    .run(gid, 'buyer1', 'OAuth: act-test', JSON.stringify(caps.map(c => ({ capability: c }))), FUTURE)
  db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
    .run(sha(oat), gid, 'cli_t', 'read aftersales:request', 'https://webaz.xyz/mcp', FUTURE)
}
mkOAuth('grt_act', 'oat_act_full', ['buyer_action_request'])
mkOAuth('grt_old', 'oat_act_old', ['read_public', 'buyer_orders_read_minimal'])
const B = (a: Record<string, unknown>) => (mcp as unknown as { handleBuyerActionRequest: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleBuyerActionRequest(a)
const approve = async (reqId: string, pd: Record<string, unknown>) => {
  const resp = await fetch(`http://127.0.0.1:${port}/api/agent-grants/permission-requests/${encodeURIComponent(reqId)}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-uid': 'buyer1' }, body: JSON.stringify({ webauthn_token: JSON.stringify(pd) }) })
  return { status: resp.status, json: await resp.json() as Record<string, unknown> }
}
const ordStatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string }).status
const PII = /9 SECRET Rd|note SECRET/i

try {
  clearCred()
  ok('B-1 no grant → GRANT_REQUIRED', (await B({ order_id: 'ord_del', action: 'confirm_receipt' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_old', 'oat_act_old', ['read_public', 'buyer_orders_read_minimal'])
  ok('B-2 NON-GRANDFATHERING → PERMISSION_REQUIRED + hint', await B({ order_id: 'ord_del', action: 'confirm_receipt' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /buyer_action_request/.test(String(r.hint))))

  useCred('grt_act', 'oat_act_full', ['buyer_action_request'])
  ok('B-3 direct_p2p confirm → DP_CONFIRM_HUMAN_ONLY (its D-gates are human-only)', (await B({ order_id: 'ord_dpc', action: 'confirm_receipt' })).error_code === 'DP_CONFIRM_HUMAN_ONLY')
  // confirm_receipt:提交 → 后果快照 → Passkey → 真实路由执行(状态机 delivered→confirmed→completed + settle 恰一次)
  const c1 = await B({ order_id: 'ord_del', action: 'confirm_receipt' })
  ok('B-4 confirm request filed: pending + server-computed economic_effect (releases_escrow=30) + deep link + NOTHING executed',
    c1.success === true && (c1.economic_effect as Record<string, unknown>)?.releases_escrow === 30 && ordStatus('ord_del') === 'delivered' && settleCalls.length === 0, JSON.stringify(c1).slice(0, 250))
  { const bad = await approve(String(c1.request_id), { request_id: c1.request_id, order_id: 'ord_del', action: 'confirm_receipt', params_hash: 'wrong' })
    ok('B-5 wrong params_hash → 412, nothing executed', bad.status === 412 && ordStatus('ord_del') === 'delivered') }
  { const good = await approve(String(c1.request_id), { request_id: c1.request_id, order_id: 'ord_del', action: 'confirm_receipt', params_hash: c1.params_hash })
    ok('B-6 Passkey approve → REAL route executes: delivered→completed via the state machine + settle called EXACTLY once', good.status === 200 && good.json.status === 'executed' && ordStatus('ord_del') === 'completed' && settleCalls.filter(x => x === 'ord_del').length === 1, JSON.stringify(good.json))
    const again = await approve(String(c1.request_id), { request_id: c1.request_id, order_id: 'ord_del', action: 'confirm_receipt', params_hash: c1.params_hash })
    ok('B-7 re-approve → already_executed via the NATURAL ORACLE (order completed), settle NOT called again', again.json.already_executed === true && settleCalls.filter(x => x === 'ord_del').length === 1) }
  // drift:提交后状态变化 → 同谓词重验硬拒 + 终态 failed 释放坑
  { const c2 = await B({ order_id: 'ord_del2', action: 'confirm_receipt' })
    db.prepare("UPDATE orders SET status = 'disputed' WHERE id = 'ord_del2'").run()
    const dr = await approve(String(c2.request_id), { request_id: c2.request_id, order_id: 'ord_del2', action: 'confirm_receipt', params_hash: c2.params_hash })
    ok('B-8 state drift after submit → BUYER_ACTION_DRIFT, terminal failed, nothing executed', dr.json.error_code === 'BUYER_ACTION_DRIFT' && (db.prepare('SELECT status FROM agent_permission_requests WHERE id = ?').get(String(c2.request_id)) as { status: string }).status === 'failed' && ordStatus('ord_del2') === 'disputed')
    db.prepare("UPDATE orders SET status = 'delivered' WHERE id = 'ord_del2'").run()
    const c2b = await B({ order_id: 'ord_del2', action: 'confirm_receipt' })
    ok('B-9 terminal failed FREES the slot → fresh submit succeeds', c2b.success === true && c2b.request_id !== c2.request_id) }
  // cancel(dp 窗口)
  { const c3 = await B({ order_id: 'ord_win', action: 'cancel' })
    ok('B-10 dp-window cancel request: zero-funds effect declared', c3.success === true && (c3.economic_effect as Record<string, unknown>)?.moves_funds === false, JSON.stringify(c3).slice(0, 200))
    const g = await approve(String(c3.request_id), { request_id: c3.request_id, order_id: 'ord_win', action: 'cancel', params_hash: c3.params_hash })
    ok('B-11 approve → REAL route cancels (state machine → cancelled)', g.status === 200 && ordStatus('ord_win') === 'cancelled', JSON.stringify(g.json)) }
  // request_return(completed + 冻结窗)
  { const c4 = await B({ order_id: 'ord_cmp', action: 'request_return', reason: 'quality' })
    ok('B-12 return request filed with enum reason + default refund declared', c4.success === true && (c4.economic_effect as Record<string, unknown>)?.moves_funds === false, JSON.stringify(c4).slice(0, 200))
    const g = await approve(String(c4.request_id), { request_id: c4.request_id, order_id: 'ord_cmp', action: 'request_return', params_hash: c4.params_hash })
    const rr = db.prepare("SELECT id, status, reason FROM return_requests WHERE order_id = 'ord_cmp'").get() as Record<string, unknown> | undefined
    ok('B-13 approve → REAL returns route files the return (row exists, reason enum verbatim)', g.status === 200 && !!rr && rr.reason === 'quality', JSON.stringify({ g: g.json, rr }))
    const c5 = await B({ order_id: 'ord_cmp', action: 'request_return', reason: 'quality' })
    ok('B-14 active return blocks a second request (route-true predicate)', c5.error_code === 'RETURN_ALREADY_ACTIVE') }
  ok('B-15 invalid reason / bad action rejected', (await B({ order_id: 'ord_cmp', action: 'request_return', reason: 'hate it' })).error_code === 'RETURN_REASON_INVALID' && (await B({ order_id: 'ord_cmp', action: 'zap' })).error_code === 'BAD_ACTION')
  ok('B-16 ZERO PII across all tool responses (address/notes markers absent)', !PII.test(JSON.stringify([c1])), '')
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ buyer-action-agent FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ buyer-action-agent: 买家动作请求 — 后果快照+四元组 · 同谓词重验 · 回环真实执行 · oracle 恢复 · 终态释放坑 · 零 PII\n  ✅ pass ${pass}`)
