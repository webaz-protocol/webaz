#!/usr/bin/env tsx
/**
 * RFC-025 PR-5a — submit + Passkey 批准执行建单(钱路集成)。用法:npm run test:order-submit-approve
 *
 * 不桩被测组件:ephemeral app 同时挂【真实 agent-grants】+【真实 orders-create】(沿用
 * test-direct-pay-create 的挂载范式),回环通道打的就是本 app 的真 POST /api/orders ——
 * 批准成功 = 真实订单行 + 真实钱包扣款(total+donation)+ 真实库存 CAS,全部入账核对。
 * requireHumanPresence 注入为"解析 token 为 purpose_data 并调用【服务端真实 validate 闭包】"——
 * 绑定校验逻辑(request_id/draft_id/params_hash 四元组)是被测代码,不是桩。
 *
 * 矩阵:submit(pending/唯一/agent 不可执行)· 批准成功(钱/库存/回链/executed)· drift 硬失败
 * (价格变/地址变/直改库 hash 断)· 上游拒绝回滚 · 结果不明冻结 · 重批幂等 · Passkey 错绑 412 ·
 * 取消草稿拒执行 · 缺 scope/非-grandfathering · 零 PII。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-submit-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { registerOrdersCreateRoutes } = await import('../src/pwa/routes/orders-create.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { toUnits, toDecimal } = await import('../src/money.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
// 复刻 PWA boot 的内联 DDL(server.ts 里不在 helpers 的表/列):从源码提取全部
// CREATE TABLE IF NOT EXISTS 块 + 守卫 ALTER 行并执行 —— 幂等,且随 server.ts 演进零维护。
{
  const src = (await import('node:fs')).readFileSync('src/pwa/server.ts', 'utf8')
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\s*\)\s*(?:STRICT\s*)?(?=`)/g)) {
    try { db.exec(m[0]) } catch { /* 依赖顺序/重复:幂等忽略 */ }
  }
  for (const m of src.matchAll(/'(ALTER TABLE [^']+)'/g)) {
    try { db.exec(m[1]) } catch { /* exists */ }
  }
  for (const m of src.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS[^'`]+?(?='\)|`\))/g)) {
    try { db.exec(m[0]) } catch { /* */ }
  }
}
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* */ }

const FULL_ADDR = 'Jane SECRET / 1 Test St #05-01 / Singapore SG / +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','holden_b','buyer','k_b',?, 'SG')").run(FULL_ADDR)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES ('buyer1',500,0,0,0),('seller1',500,0,0,0)").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES ('prd_s','seller1','Simple Stand','d',30,'WAZ',20,'phone_stand','active')`).run()

// ── ephemeral app:真实 agent-grants + 真实 orders-create;auth = Bearer/x-test-uid 双解析 ──
const auth = (req: Request, res: Response) => {
  const uid = req.headers['x-test-uid'] as string | undefined
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''))
  const row = uid
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined
    : m ? db.prepare('SELECT * FROM users WHERE api_key = ?').get(m[1]) as Record<string, unknown> | undefined : undefined
  if (!row) { res.status(401).json({ error: 'login' }); return null }
  return row
}
const app = express(); app.use(express.json())
const cp: Record<string, unknown> = {}
let loopbackMode: 'real' | 'throw' = 'real'
const realLoopback = async (apiKey: string, body: Record<string, unknown>) => {
  const resp = await fetch(`http://127.0.0.1:${port}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) })
  let json: Record<string, unknown> | null = null
  try { json = await resp.json() as Record<string, unknown> } catch { json = null }
  return { status: resp.status, json }
}
registerAgentGrantsRoutes(app, {
  db, auth, generateId, rateLimitOk: () => true,
  getProtocolParam: <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb),
  // 真实 validate 闭包被调用:token 即 purpose_data JSON(gate 本体由 webauthn 套件另测)
  requireHumanPresence: ((_uid: string, _purpose: string, token: string | undefined, _key: string, validate?: (d: unknown) => boolean) => {
    let data: unknown = null; try { data = token ? JSON.parse(token) : null } catch { data = null }
    return (validate ? validate(data) : true) ? { ok: true } : { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: 'binding mismatch' }
  }) as never,
  createOrderLoopback: async (apiKey, body) => { if (loopbackMode === 'throw') throw new Error('network down'); return realLoopback(apiKey, body) },
})
registerOrdersCreateRoutes(app, {
  db, auth, isTrustedRole: () => false, generateId, generateRecipientCode: () => 'RC12345',
  DONATION_VALID_PCTS: new Set([0, 0.005, 0.01, 0.02, 0.05]), INTERNAL_AUDITOR_ID: 'audit',
  addHours: (d: Date, h: number) => new Date(d.getTime() + h * 3600_000).toISOString(),
  getActiveFlashSale: () => null, applyCouponToOrder: () => ({ ok: false }),
  getProtocolParam: <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb),
  getProductShareChain: () => [], isAllowedSponsor: () => false, resolveInviteCodeRef: () => null,
  checkStockAndMaybeDelist: () => {}, auditSponsorChainCross: () => {},
  appendOrderEvent, transition, notifyTransition: () => {}, shouldAutoAccept: () => false,
  ensureCharityRep: () => {}, broadcastSystemEvent: () => {}, signPassport: async () => 'sig', issuerAddress: () => 'addr',
} as never)
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, humanId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'SA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const PII = /SECRET|Jane|91234567|1 Test St|#05-01/i
const Q = (a: Record<string, unknown>) => (mcp as unknown as { handleQuoteOrder: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleQuoteOrder(a)
const D = (a: Record<string, unknown>) => (mcp as unknown as { handleOrderDraft: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleOrderDraft(a)
const SUB = (a: Record<string, unknown>) => (mcp as unknown as { handleSubmitOrderRequest: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleSubmitOrderRequest(a)
const approve = async (reqId: string, purposeData: Record<string, unknown>) => {
  const resp = await fetch(`http://127.0.0.1:${port}/api/agent-grants/permission-requests/${encodeURIComponent(reqId)}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-uid': 'buyer1' }, body: JSON.stringify({ webauthn_token: JSON.stringify(purposeData) }) })
  return { status: resp.status, json: await resp.json() as Record<string, unknown> }
}
const bal = (uid: string) => (db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id=?').get(uid) as { balance: number; escrowed: number })
const stock = () => (db.prepare("SELECT stock FROM products WHERE id='prd_s'").get() as { stock: number }).stock
const orderCount = () => (db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c
const mkChain = async (qty: number, donation = 0) => {
  const q = await Q({ product_id: 'prd_s', quantity: qty, donation_bps: donation })
  const d = await D({ action: 'create', quote_token: q.quote_token })
  const srq = await SUB({ draft_id: d.draft_id })
  return { q, d, srq }
}

mkGrant('grt_full', 'buyer1', 'gtk_full', ['price_quote', 'draft_order', 'order_submit_request'])
mkGrant('grt_old', 'buyer1', 'gtk_old', ['draft_order', 'order_action_request', 'price_quote'])

try {
  // ══ submit:SUBMIT-only ══
  clearCred()
  ok('S-1 no grant → GRANT_REQUIRED', (await SUB({ draft_id: 'odr_x' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_old', 'gtk_old', ['draft_order', 'order_action_request', 'price_quote'])
  ok('S-2 NON-GRANDFATHERING: pre-PR order:draft snapshot lacks order_submit_request', (await SUB({ draft_id: 'odr_x' })).error_code === 'PERMISSION_REQUIRED')
  useCred('grt_full', 'gtk_full', ['price_quote', 'draft_order', 'order_submit_request'])
  const c1 = await mkChain(2, 100)   // 2×30 + donation 1% —— total 60, donation 0.6, payable 60.6
  ok('S-3 submit → pending request + approval_url + params_hash; NOTHING executed', typeof c1.srq.request_id === 'string' && String(c1.srq.approval_url).includes('#agent-approvals') && orderCount() === 0 && bal('buyer1').balance === 500, JSON.stringify(c1.srq).slice(0, 250))
  ok('S-4 duplicate submit on same draft → DUPLICATE_SUBMIT_REQUEST', (await SUB({ draft_id: c1.d.draft_id })).error_code === 'DUPLICATE_SUBMIT_REQUEST')

  // ══ Passkey 绑定 ══
  { const bad = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, draft_id: c1.d.draft_id, params_hash: 'wrong' })
    ok('P-1 wrong params_hash in Passkey binding → 412 (binding validate closure is REAL server code)', bad.status === 412)
    ok('P-2 nothing executed on binding failure', orderCount() === 0 && bal('buyer1').balance === 500) }

  // ══ 批准成功:真实建单 + 真实扣款 + 真实库存 ══
  { const r = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, draft_id: c1.d.draft_id, params_hash: c1.srq.params_hash })
    ok('A-1 approve → executed + order_id', r.status === 200 && r.json.success === true && typeof r.json.order_id === 'string', JSON.stringify(r.json).slice(0, 250))
    const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(r.json.order_id)) as Record<string, unknown>
    ok('A-2 REAL order row (paid, qty 2, total 60 WAZ, buyer1)', !!ord && ord.status === 'paid' && Number(ord.quantity) === 2 && Number(ord.total_amount) === 60 && ord.buyer_id === 'buyer1', String(JSON.stringify(ord) ?? 'NO_ORDER').slice(0, 200))
    ok('A-3 REAL wallet debit: balance 500→439.4 (60 escrow + 0.6 donation), escrowed 60', Math.abs(bal('buyer1').balance - 439.4) < 1e-6 && Math.abs(bal('buyer1').escrowed - 60) < 1e-6, JSON.stringify(bal('buyer1')))
    ok('A-4 REAL stock CAS: 20→18', stock() === 18)
    const draftRow = db.prepare('SELECT status, order_id FROM order_drafts WHERE id = ?').get(String(c1.d.draft_id)) as { status: string; order_id: string | null }
    ok('A-5 draft → ordered + order_id linked', draftRow.status === 'ordered' && draftRow.order_id === r.json.order_id)
    ok('A-6 request executed_at set', !!(db.prepare('SELECT executed_at FROM agent_permission_requests WHERE id=?').get(String(c1.srq.request_id)) as { executed_at: string | null }).executed_at)
    ok('A-7 approve response carries NO PII (address never echoed)', !PII.test(JSON.stringify(r.json)))
    const again = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, draft_id: c1.d.draft_id, params_hash: c1.srq.params_hash })
    ok('A-8 re-approve → already_executed, NO second order/debit', again.json.already_executed === true && orderCount() === 1 && Math.abs(bal('buyer1').balance - 439.4) < 1e-6) }

  // ══ drift 硬失败(条款绝不静默变更) ══
  { const c2 = await mkChain(1)
    db.prepare("UPDATE products SET price = 35 WHERE id='prd_s'").run()
    const r = await approve(String(c2.srq.request_id), { request_id: c2.srq.request_id, draft_id: c2.d.draft_id, params_hash: c2.srq.params_hash })
    ok('D-1 price changed after draft → DRAFT_DRIFT hard fail, NO order/debit', r.status === 409 && r.json.error_code === 'DRAFT_DRIFT' && orderCount() === 1, JSON.stringify(r.json).slice(0, 200))
    ok('D-2 draft stays draft (retriable after re-quote)', (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(c2.d.draft_id)) as { status: string }).status === 'draft')
    db.prepare("UPDATE products SET price = 30 WHERE id='prd_s'").run() }
  { const c3 = await mkChain(1)
    db.prepare("UPDATE users SET default_address_text = 'NEW ADDR 99 / Somewhere' WHERE id='buyer1'").run()
    const r = await approve(String(c3.srq.request_id), { request_id: c3.srq.request_id, draft_id: c3.d.draft_id, params_hash: c3.srq.params_hash })
    ok('D-3 default address changed after draft → ADDRESS_CHANGED hard fail', r.status === 409 && r.json.error_code === 'ADDRESS_CHANGED' && !PII.test(JSON.stringify(r.json)))
    db.prepare('UPDATE users SET default_address_text = ? WHERE id=?').run(FULL_ADDR, 'buyer1')
    // 直改库篡改快照 → 重算 hash ≠ Passkey 绑定的 → DRAFT_DRIFT
    db.prepare('UPDATE order_drafts SET quantity = 5 WHERE id = ?').run(String(c3.d.draft_id))
    const r2 = await approve(String(c3.srq.request_id), { request_id: c3.srq.request_id, draft_id: c3.d.draft_id, params_hash: c3.srq.params_hash })
    ok('D-4 direct-DB tamper of the draft → params_hash recheck DRAFT_DRIFT', r2.status === 409 && r2.json.error_code === 'DRAFT_DRIFT')
    db.prepare('UPDATE order_drafts SET quantity = 1 WHERE id = ?').run(String(c3.d.draft_id)) }

  // ══ 上游拒绝 → 安全回滚;结果不明 → 冻结 ══
  { const c4 = await mkChain(1)
    db.prepare("UPDATE wallets SET balance = 1 WHERE user_id='buyer1'").run()   // 余额不足 → 上游 200+error
    const r = await approve(String(c4.srq.request_id), { request_id: c4.srq.request_id, draft_id: c4.d.draft_id, params_hash: c4.srq.params_hash })
    ok('U-1 upstream reject (insufficient balance) → rejected + draft rolled back to draft', r.status === 409 && (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(c4.d.draft_id)) as { status: string }).status === 'draft' && orderCount() === 1, JSON.stringify(r.json).slice(0, 200))
    db.prepare("UPDATE wallets SET balance = 439.4 WHERE user_id='buyer1'").run()
    loopbackMode = 'throw'
    const r2 = await approve(String(c4.srq.request_id), { request_id: c4.srq.request_id, draft_id: c4.d.draft_id, params_hash: c4.srq.params_hash })
    ok('U-2 ambiguous loopback (throw) → ORDER_CREATE_AMBIGUOUS + draft FROZEN at ordering (no auto-retry duplicates)', r2.json.error_code === 'ORDER_CREATE_AMBIGUOUS' && (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(c4.d.draft_id)) as { status: string }).status === 'ordering')
    loopbackMode = 'real'
    const r3 = await approve(String(c4.srq.request_id), { request_id: c4.srq.request_id, draft_id: c4.d.draft_id, params_hash: c4.srq.params_hash })
    ok('U-3 frozen draft refuses re-execution (human must reconcile)', r3.json.error_code === 'ORDER_CREATE_AMBIGUOUS' && orderCount() === 1) }

  // ══ 取消草稿 → 批准拒 ══
  { const c5 = await mkChain(1)
    await D({ action: 'cancel', draft_id: c5.d.draft_id })
    const r = await approve(String(c5.srq.request_id), { request_id: c5.srq.request_id, draft_id: c5.d.draft_id, params_hash: c5.srq.params_hash })
    ok('C-1 cancelled draft → DRAFT_NOT_AVAILABLE (approval cannot resurrect it)', r.json.error_code === 'DRAFT_NOT_AVAILABLE' && orderCount() === 1) }

  // ══ 提交面守卫:executor 对 agent-bearer 不可达(源守卫,镜像 RFC-021 I1) ══
  const SRC = (await import('node:fs')).readFileSync('src/pwa/order-submit-request.ts', 'utf8')
  ok('G-1 submit domain does NOT import the executor (I1; prose mentions allowed)', !/from '[^']*order-submit-exec/.test(SRC))
  const MCPSRC = (await import('node:fs')).readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('G-2 MCP layer never imports the executor', !/order-submit-exec/.test(MCPSRC))
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ order-submit-approve FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order-submit-approve: 钱路全链 — submit-only · Passkey 四元组绑定 · 真实建单/扣款/库存 · drift 三重硬失败 · 回滚/冻结 · 重批幂等 · I1\n  ✅ pass ${pass}`)
