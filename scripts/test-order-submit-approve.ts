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
  { const dup = await SUB({ draft_id: c1.d.draft_id })
    ok('S-4 duplicate submit on same draft → REUSES existing request (id echoed, duplicate flagged, no 2nd row)', dup.request_id === c1.srq.request_id && (dup.idempotency as Record<string, unknown>)?.duplicate === true && (db.prepare("SELECT COUNT(*) c FROM agent_permission_requests WHERE kind='order_submit'").get() as { c: number }).c === 1, JSON.stringify(dup).slice(0, 200)) }

  // ══ Passkey 绑定 ══
  { const bad = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, order_id: c1.d.draft_id, action: 'order_submit', params_hash: 'wrong' })
    ok('P-1 wrong params_hash in Passkey binding → 412 (binding validate closure is REAL server code)', bad.status === 412)
    ok('P-2 nothing executed on binding failure', orderCount() === 0 && bal('buyer1').balance === 500)
    const badAct = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, order_id: c1.d.draft_id, action: 'accept', params_hash: c1.srq.params_hash })
    ok('P-3 wrong action in binding → 412 (quad = EXACT PWA aaApprove shape: request_id/order_id/action/params_hash)', badAct.status === 412) }

  // ══ 批准成功:真实建单 + 真实扣款 + 真实库存 ══
  { const r = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, order_id: c1.d.draft_id, action: 'order_submit', params_hash: c1.srq.params_hash })
    ok('A-1 approve → executed + order_id', r.status === 200 && r.json.success === true && typeof r.json.order_id === 'string', JSON.stringify(r.json).slice(0, 250))
    const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(r.json.order_id)) as Record<string, unknown>
    ok('A-2 REAL order row (paid, qty 2, total 60 WAZ, buyer1)', !!ord && ord.status === 'paid' && Number(ord.quantity) === 2 && Number(ord.total_amount) === 60 && ord.buyer_id === 'buyer1', String(JSON.stringify(ord) ?? 'NO_ORDER').slice(0, 200))
    ok('A-3 REAL wallet debit: balance 500→439.4 (60 escrow + 0.6 donation), escrowed 60', Math.abs(bal('buyer1').balance - 439.4) < 1e-6 && Math.abs(bal('buyer1').escrowed - 60) < 1e-6, JSON.stringify(bal('buyer1')))
    ok('A-4 REAL stock CAS: 20→18', stock() === 18)
    const draftRow = db.prepare('SELECT status, order_id FROM order_drafts WHERE id = ?').get(String(c1.d.draft_id)) as { status: string; order_id: string | null }
    ok('A-5 draft → ordered + order_id linked', draftRow.status === 'ordered' && draftRow.order_id === r.json.order_id)
    ok('A-6 request executed_at set', !!(db.prepare('SELECT executed_at FROM agent_permission_requests WHERE id=?').get(String(c1.srq.request_id)) as { executed_at: string | null }).executed_at)
    ok('A-7 approve response carries NO PII (address never echoed)', !PII.test(JSON.stringify(r.json)))
    const again = await approve(String(c1.srq.request_id), { request_id: c1.srq.request_id, order_id: c1.d.draft_id, action: 'order_submit', params_hash: c1.srq.params_hash })
    ok('A-8 re-approve → already_executed, NO second order/debit', again.json.already_executed === true && orderCount() === 1 && Math.abs(bal('buyer1').balance - 439.4) < 1e-6) }

  // ══ drift 硬失败(条款绝不静默变更) ══
  { const c2 = await mkChain(1)
    db.prepare("UPDATE products SET price = 35 WHERE id='prd_s'").run()
    const r = await approve(String(c2.srq.request_id), { request_id: c2.srq.request_id, order_id: c2.d.draft_id, action: 'order_submit', params_hash: c2.srq.params_hash })
    ok('D-1 price changed after draft → DRAFT_DRIFT hard fail, NO order/debit', r.status === 409 && r.json.error_code === 'DRAFT_DRIFT' && orderCount() === 1, JSON.stringify(r.json).slice(0, 200))
    ok('D-2 draft stays draft (retriable after re-quote)', (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(c2.d.draft_id)) as { status: string }).status === 'draft')
    db.prepare("UPDATE products SET price = 30 WHERE id='prd_s'").run()
    // BLOCKER-2 回归:卖家漂移(价格不变)也必须拒 —— 商品换主后批准会把钱给错人
    const cS = await mkChain(1)
    db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller2','S2','seller','k_s2')").run()
    db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES ('seller2',500,0,0,0)").run()
    db.prepare("UPDATE products SET seller_id = 'seller2' WHERE id='prd_s'").run()
    const rS = await approve(String(cS.srq.request_id), { request_id: cS.srq.request_id, order_id: cS.d.draft_id, action: 'order_submit', params_hash: cS.srq.params_hash })
    ok('D-2b SELLER changed after draft (price identical) → DRAFT_DRIFT, no order', rS.status === 409 && rS.json.error_code === 'DRAFT_DRIFT' && orderCount() === 1, JSON.stringify(rS.json).slice(0, 200))
    db.prepare("UPDATE products SET seller_id = 'seller1' WHERE id='prd_s'").run() }
  { const c3 = await mkChain(1)
    db.prepare("UPDATE users SET default_address_text = 'NEW ADDR 99 / Somewhere' WHERE id='buyer1'").run()
    const r = await approve(String(c3.srq.request_id), { request_id: c3.srq.request_id, order_id: c3.d.draft_id, action: 'order_submit', params_hash: c3.srq.params_hash })
    ok('D-3 default address changed after draft → ADDRESS_CHANGED hard fail', r.status === 409 && r.json.error_code === 'ADDRESS_CHANGED' && !PII.test(JSON.stringify(r.json)))
    db.prepare('UPDATE users SET default_address_text = ? WHERE id=?').run(FULL_ADDR, 'buyer1')
    ok('D-3b clean failure sends the request TERMINAL (failed) — frees the per-draft/per-intent slots', (db.prepare('SELECT status FROM agent_permission_requests WHERE id=?').get(String(c3.srq.request_id)) as { status: string }).status === 'failed')
    // 直改库篡改快照 → 重算 hash ≠ Passkey 绑定的 → DRAFT_DRIFT(新链:上一请求已终态)
    const c3b = await mkChain(1)
    db.prepare('UPDATE order_drafts SET quantity = 5 WHERE id = ?').run(String(c3b.d.draft_id))
    const r2 = await approve(String(c3b.srq.request_id), { request_id: c3b.srq.request_id, order_id: c3b.d.draft_id, action: 'order_submit', params_hash: c3b.srq.params_hash })
    ok('D-4 direct-DB tamper of the draft → params_hash recheck DRAFT_DRIFT', r2.status === 409 && r2.json.error_code === 'DRAFT_DRIFT')
    db.prepare('UPDATE order_drafts SET quantity = 1 WHERE id = ?').run(String(c3b.d.draft_id)) }

  // ══ 上游拒绝 → 安全回滚;结果不明 → 冻结 ══
  { const c4 = await mkChain(1)
    db.prepare("UPDATE wallets SET balance = 1 WHERE user_id='buyer1'").run()   // 余额不足 → 上游 200+error
    const r = await approve(String(c4.srq.request_id), { request_id: c4.srq.request_id, order_id: c4.d.draft_id, action: 'order_submit', params_hash: c4.srq.params_hash })
    ok('U-1 upstream reject (insufficient balance) → rejected + draft rolled back to draft', r.status === 409 && (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(c4.d.draft_id)) as { status: string }).status === 'draft' && orderCount() === 1, JSON.stringify(r.json).slice(0, 200))
    db.prepare("UPDATE wallets SET balance = 439.4 WHERE user_id='buyer1'").run()
    // 干净失败已终态 → 重试 = 重新提交同一(已回滚)草稿,得到【新】请求(旧的不再占坑)
    const srq2 = await SUB({ draft_id: c4.d.draft_id })
    ok('U-1b retry after clean reject = FRESH request (old one terminal, slot freed)', typeof srq2.request_id === 'string' && srq2.request_id !== c4.srq.request_id && !(srq2.idempotency as Record<string, unknown>)?.duplicate, JSON.stringify(srq2).slice(0, 200))
    loopbackMode = 'throw'
    const r2 = await approve(String(srq2.request_id), { request_id: srq2.request_id, order_id: c4.d.draft_id, action: 'order_submit', params_hash: srq2.params_hash })
    ok('U-2 ambiguous loopback (throw) → ORDER_CREATE_AMBIGUOUS + draft FROZEN at ordering (no auto-retry duplicates)', r2.json.error_code === 'ORDER_CREATE_AMBIGUOUS' && (db.prepare('SELECT status FROM order_drafts WHERE id=?').get(String(c4.d.draft_id)) as { status: string }).status === 'ordering')
    loopbackMode = 'real'
    const r3 = await approve(String(srq2.request_id), { request_id: srq2.request_id, order_id: c4.d.draft_id, action: 'order_submit', params_hash: srq2.params_hash })
    ok('U-3 frozen draft refuses re-execution (human must reconcile)', r3.json.error_code === 'ORDER_CREATE_AMBIGUOUS' && orderCount() === 1)
    ok('U-4 ambiguous keeps the request ACTIVE (occupies the intent slot until reconciled — equivalent purchases stay blocked)', (db.prepare('SELECT status FROM agent_permission_requests WHERE id=?').get(String(srq2.request_id)) as { status: string }).status === 'approved') }

  // ══ 取消草稿 → 批准拒 ══
  { const c5 = await mkChain(1, 100)   // 捐赠≠0 → 与 U 组冻结中的意图不同(冻结占坑是特性)
    await D({ action: 'cancel', draft_id: c5.d.draft_id })
    const r = await approve(String(c5.srq.request_id), { request_id: c5.srq.request_id, order_id: c5.d.draft_id, action: 'order_submit', params_hash: c5.srq.params_hash })
    ok('C-1 cancelled draft → DRAFT_NOT_AVAILABLE (approval cannot resurrect it)', r.json.error_code === 'DRAFT_NOT_AVAILABLE' && orderCount() === 1) }

  // ══ RFC-026 PR-1:购买意图级幂等(生产双订单事故回归) ══
  { db.prepare("UPDATE wallets SET balance = 500 WHERE user_id='buyer1'").run()
    // I-1 同一意图跨 draft:重新报价+新草稿(事故向量:超时重试)→ 重用第一条请求,绝不第二张审批卡
    const a1 = await mkChain(3)
    const q2 = await Q({ product_id: 'prd_s', quantity: 3 })
    const d2 = await D({ action: 'create', quote_token: q2.quote_token })
    const s2 = await SUB({ draft_id: d2.draft_id })
    ok('I-1 SAME intent via a NEW quote+draft → REUSES the existing request (the production double-order vector)', s2.request_id === a1.srq.request_id && (s2.idempotency as Record<string, unknown>)?.duplicate === true, JSON.stringify(s2).slice(0, 200))
    ok('I-2 exactly ONE pending order_submit for the intent', (db.prepare("SELECT COUNT(*) c FROM agent_permission_requests WHERE kind='order_submit' AND status='pending'").get() as { c: number }).c === 1)
    // I-3 改数量 = 新意图(合法不同购买),各自成行
    const b1 = await mkChain(4)
    ok('I-3 quantity=4 is a DIFFERENT intent → its own pending request', typeof b1.srq.request_id === 'string' && b1.srq.request_id !== a1.srq.request_id, JSON.stringify(b1.srq).slice(0, 150))
    // I-4 并发双批准同一请求 → 恰一单;输家拿 already_executed / ambiguous,绝不第二单
    const before = orderCount(); const balBefore = bal('buyer1').balance
    const hit = () => approve(String(a1.srq.request_id), { request_id: a1.srq.request_id, order_id: a1.d.draft_id, action: 'order_submit', params_hash: a1.srq.params_hash })
    const [ra, rb] = await Promise.all([hit(), hit()])
    const succ = [ra, rb].filter(r => r.json.success === true && typeof r.json.order_id === 'string' && !r.json.already_executed)
    const safe2 = [ra, rb].filter(r => r.json.already_executed === true || r.json.error_code === 'ORDER_CREATE_AMBIGUOUS')
    ok('I-4 CONCURRENT double approve → exactly ONE order + ONE debit; loser converges to already_executed/ambiguous', orderCount() === before + 1 && succ.length === 1 && succ.length + safe2.length === 2 && Math.abs(balBefore - bal('buyer1').balance - 90) < 1e-6, JSON.stringify({ ra: ra.json, rb: rb.json }).slice(0, 300))
    const firstOrder = String(succ[0].json.order_id)
    ok('I-5 executed order carries the draft_id backlink (orders.draft_id)', (db.prepare('SELECT draft_id FROM orders WHERE id=?').get(firstOrder) as { draft_id: string | null })?.draft_id === String(a1.d.draft_id))
    // I-6 DB 级兜底:同 draft 第二笔订单,直写库也插不进(UNIQUE ux_orders_draft)
    try {
      db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, draft_id) VALUES ('ord_dup_probe','prd_s','buyer1','seller1',1,30,30,30,'created',?)").run(String(a1.d.draft_id))
      ok('I-6 DB-level UNIQUE(orders.draft_id) blocks a 2nd order for the SAME draft even via direct write', false, 'direct INSERT unexpectedly succeeded')
    } catch (e) { ok('I-6 DB-level UNIQUE(orders.draft_id) blocks a 2nd order for the SAME draft even via direct write', /UNIQUE/i.test((e as Error).message), (e as Error).message) }
    // I-7 执行完成 → 意图坑释放 = 明确再次购买合法(新请求→新订单)
    const s3 = await SUB({ draft_id: d2.draft_id })
    ok('I-7 after execution the intent slot FREES → explicit re-buy = FRESH request', typeof s3.request_id === 'string' && s3.request_id !== a1.srq.request_id && !(s3.idempotency as Record<string, unknown>)?.duplicate, JSON.stringify(s3).slice(0, 200))
    const r5 = await approve(String(s3.request_id), { request_id: s3.request_id, order_id: d2.draft_id, action: 'order_submit', params_hash: s3.params_hash })
    ok('I-8 re-buy approval creates a SECOND real order (buying twice = two explicit human approvals)', r5.json.success === true && typeof r5.json.order_id === 'string' && r5.json.order_id !== firstOrder && orderCount() === before + 2, JSON.stringify(r5.json).slice(0, 150))
    // I-9 并发双提交同一 draft → 收敛到同一请求行
    const q9 = await Q({ product_id: 'prd_s', quantity: 5 })
    const d9 = await D({ action: 'create', quote_token: q9.quote_token })
    const [x1, x2] = await Promise.all([SUB({ draft_id: d9.draft_id }), SUB({ draft_id: d9.draft_id })])
    ok('I-9 CONCURRENT double submit on one draft → both get the SAME request id, one row total', x1.request_id === x2.request_id && (db.prepare("SELECT COUNT(*) c FROM agent_permission_requests WHERE kind='order_submit' AND order_id=? AND status IN ('pending','approved')").get(String(d9.draft_id)) as { c: number }).c === 1, JSON.stringify({ x1, x2 }).slice(0, 200)) }

  // ══ oat_ OAuth bearer 真实链路(#385 教训:测试禁止只用 gtk_ 模拟 OAuth) ══
  { db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES ('grt_oauth','buyer1','OAuth: e2e',?,NULL,'active',?)")
      .run(JSON.stringify(['price_quote', 'draft_order', 'order_submit_request'].map(c => ({ capability: c }))), new Date(Date.now() + 3600_000).toISOString())
    db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
      .run(sha('oat_e2e_submit_bearer'), 'grt_oauth', 'cli_e2e', 'read order:draft', 'https://webaz.xyz/mcp', new Date(Date.now() + 3600_000).toISOString())
    useCred('grt_oauth', 'oat_e2e_submit_bearer', ['price_quote', 'draft_order', 'order_submit_request'])
    const co = await mkChain(6)
    ok('O-1 full quote→draft→submit chain over a REAL oat_ bearer (oauth_access_tokens introspection path)', typeof co.srq.request_id === 'string' && String(co.srq.approval_url).includes('#agent-approvals'), JSON.stringify(co.srq).slice(0, 200))
    useCred('grt_full', 'gtk_full', ['price_quote', 'draft_order', 'order_submit_request']) }

  // ══ 提交面守卫:executor 对 agent-bearer 不可达(源守卫,镜像 RFC-021 I1) ══
  const SRC = (await import('node:fs')).readFileSync('src/pwa/order-submit-request.ts', 'utf8')
  ok('G-1 submit domain does NOT import the executor (I1; prose mentions allowed)', !/from '[^']*order-submit-exec/.test(SRC))
  const MCPSRC = (await import('node:fs')).readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('G-2 MCP layer never imports the executor', !/order-submit-exec/.test(MCPSRC))
  // Codex MEDIUM:PII 声明按证据收窄 —— 扫全部持久面(请求行/审计行/执行结果),完整地址不得出现
  const persisted = JSON.stringify({
    reqs: db.prepare('SELECT * FROM agent_permission_requests').all(),
    audit: db.prepare('SELECT * FROM agent_grant_auth_log').all(),
    drafts: db.prepare('SELECT * FROM order_drafts').all(),
  })
  ok('G-3 NO full-address PII in permission requests / grant audit rows / drafts (execution_result incl.)', !PII.test(persisted))
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ order-submit-approve FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order-submit-approve: 钱路全链 — submit-only · Passkey 四元组绑定 · 真实建单/扣款/库存 · drift 三重硬失败 · 回滚/冻结 · 重批幂等 · I1\n  ✅ pass ${pass}`)
