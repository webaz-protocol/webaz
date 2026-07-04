#!/usr/bin/env tsx
/**
 * 争议协商收口·买家侧(contract v19)—— dispute_withdraw_confirm 路由权威门 + 全原子结算。真 express + 真 transition。
 *   限【delivered 来源履约争议 + 争议发起人本人 + 裁定前】;dp 轨 = RISK(D1/D2 + Passkey 门);
 *   同一 tx:争议 dismissed(无责)+ disputed→confirmed→completed + settleOrder,任一步失败整体回滚。
 * Usage: npm run test:dispute-withdraw-confirm
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dwc-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { registerOrdersActionRoutes } = await import('../src/pwa/routes/orders-action.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { recordDisclosureAck, STAGE } = await import('../src/direct-pay-disclosures.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initOrderChainSchema(db); initSystemUser(db); initDisputeSchema(db); initNotificationSchema(db)
try { db.exec("ALTER TABLE evidence ADD COLUMN flag_reasons TEXT") } catch {}  // runtime-helper column (bare initDatabase lacks it)
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)')   // dp RISK 门查 Passkey 绑定
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_b1','buyer1')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','b','buyer','kb'),('seller1','s','seller','ks')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price) VALUES ('p1','seller1','T','d',50)").run()

let oc = 0, dc = 0
function mkOrder(status: string, rail = 'escrow'): string {
  const id = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p1','buyer1','seller1',1,50,50,0,?,?)").run(id, status, rail)
  return id
}
const st = (id: string): string => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string }).status
const dspRow = (id: string): { status: string; verdict_reason: string | null } | undefined =>
  db.prepare('SELECT status, verdict_reason FROM disputes WHERE id=?').get(id) as { status: string; verdict_reason: string | null } | undefined
const mkDisputeRow = (orderId: string, initiator = 'buyer1', status = 'open'): string => {
  const id = `dsp_${++dc}`
  db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status) VALUES (?,?,?,'seller1','未收到货',?)").run(id, orderId, initiator, status)
  return id
}
// delivered 来源履约争议:真 transition 写 order_state_history(权威来源判定读这张表)
const escalateFromDelivered = (orderId: string): void => {
  const r = transition(db, orderId, 'disputed', 'buyer1', ['ev_x'], '未收到货')
  if (!r.success) throw new Error(`escalate failed: ${r.error}`)
}

const settled: string[] = []
let settleThrows = false
const app = express(); app.use(express.json())
let counter = 0; let gateOk = true
registerOrdersActionRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null }; return { id: uid, role: (req.headers['x-test-role'] as string) || 'buyer' } },
  isTrustedRole: () => false, generateId: (p: string) => `${p}_${++counter}`, transition, notifyTransition: () => {},
  settleOrder: (orderId: string) => { if (settleThrows) throw new Error('settle boom'); settled.push(orderId) },
  settleFault: () => {}, detectFraud: () => [],
  createDispute: () => ({ success: true }), checkTimeouts: () => ({ details: [] }), recordViolationReputation: () => {},
  broadcastSystemEvent: () => {}, consumeGateToken: () => (gateOk ? { ok: true } : { ok: false, reason: 'no token' }),
} as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const call = (orderId: string, body: Record<string, unknown>, uid = 'buyer1', role = 'buyer'): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify({ action: 'dispute_withdraw_confirm', ...body })
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/orders/${orderId}/action`, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-test-uid': uid, 'x-test-role': role } }, res => { let dt = ''; res.on('data', c => dt += c); res.on('end', () => resolve({ status: res.statusCode || 0, json: dt ? JSON.parse(dt) : {} })) })
  rq.on('error', reject); rq.write(payload); rq.end()
})

try {
  // ── ① 权威门矩阵 ──
  ok('1a. seller cannot withdraw-confirm (403 NOT_ORDER_BUYER)',
    (await call(mkOrder('disputed'), {}, 'seller1', 'seller')).json.error_code === 'NOT_ORDER_BUYER')
  ok('1b. non-disputed order rejected (409 ORDER_NOT_DISPUTED)',
    (await call(mkOrder('delivered'), {})).json.error_code === 'ORDER_NOT_DISPUTED')
  {
    const o = mkOrder('disputed'); mkDisputeRow(o, 'buyer1', 'resolved')
    ok('1c. ruled/absent dispute rejected (409 DISPUTE_ALREADY_RULED)', (await call(o, {})).json.error_code === 'DISPUTE_ALREADY_RULED')
  }
  {
    const o = mkOrder('disputed'); mkDisputeRow(o, 'seller1')
    ok('1d. non-initiator buyer rejected (403 NOT_DISPUTE_INITIATOR)', (await call(o, {})).json.error_code === 'NOT_DISPUTE_INITIATOR')
  }
  {
    // payment_query 来源:history 最近一次进 disputed 是 from payment_query → 拒(货款争议走 pq_withdraw)
    const o = mkOrder('payment_query', 'direct_p2p'); const r = transition(db, o, 'disputed', 'buyer1', ['ev_pq'], '已付款举证')
    if (!r.success) throw new Error(r.error)
    mkDisputeRow(o)
    ok('1e. payment_query-origin dispute rejected (409 NOT_FULFILMENT_DISPUTE)', (await call(o, {})).json.error_code === 'NOT_FULFILMENT_DISPUTE')
  }
  {
    // 无 history(直插 disputed)= 来源不可证 → fail-closed 拒
    const o = mkOrder('disputed'); mkDisputeRow(o)
    ok('1f. unprovable origin fail-closed (409 NOT_FULFILMENT_DISPUTE)', (await call(o, {})).json.error_code === 'NOT_FULFILMENT_DISPUTE')
  }

  // ── ② escrow 履约争议:撤诉并确认收货 = 争议 dismissed + 完成结算(全链) ──
  {
    const o = mkOrder('delivered'); escalateFromDelivered(o); const d = mkDisputeRow(o)
    const r = await call(o, { notes: '在代收点找到了' })
    ok('2a. escrow happy path → 200 completed', r.status === 200 && r.json.success === true && st(o) === 'completed', JSON.stringify(r.json))
    ok('2b. dispute dismissed with withdraw reason', dspRow(d)?.status === 'dismissed' && /买家撤诉并确认收货/.test(dspRow(d)?.verdict_reason || ''))
    ok('2c. settleOrder called exactly once for this order', settled.filter(x => x === o).length === 1)
    const hist = db.prepare("SELECT from_status||'→'||to_status e FROM order_state_history WHERE order_id=? ORDER BY rowid").all(o) as { e: string }[]
    ok('2d. history: disputed→confirmed→completed (buyer edge + sys settle edge)',
      hist.some(h => h.e === 'disputed→confirmed') && hist.some(h => h.e === 'confirmed→completed'))
    ok('2e. seller notified (dispute_withdrawn_confirmed)',
      !!db.prepare("SELECT 1 FROM notifications WHERE user_id='seller1' AND order_id=? AND type='dispute_withdrawn_confirmed'").get(o))
  }

  // ── ③ dp 轨 = RISK:D1/D2 缺 ack 先拒;补 ack + gate 通过 → 完成 ──
  {
    const o = mkOrder('delivered', 'direct_p2p'); escalateFromDelivered(o); mkDisputeRow(o)
    ok('3a. dp without disclosure acks → 409 DISCLOSURE_NOT_ACKED', (await call(o, {})).json.error_code === 'DISCLOSURE_NOT_ACKED')
    recordDisclosureAck(db, { orderId: o, buyerId: 'buyer1', stage: STAGE.PRE_SELECT, ackId: 'a1_' + o })
    recordDisclosureAck(db, { orderId: o, buyerId: 'buyer1', stage: STAGE.PRE_CONFIRM, ackId: 'a2_' + o })
    gateOk = false
    ok('3b. dp without Passkey gate token → 403 HUMAN_PRESENCE_REQUIRED', (await call(o, {})).json.error_code === 'HUMAN_PRESENCE_REQUIRED')
    gateOk = true
    const r = await call(o, { webauthn_token: 'tok' })
    ok('3c. dp happy path → 200 completed + settle (fee accrual chain)', r.status === 200 && st(o) === 'completed' && settled.includes(o), JSON.stringify(r.json))
  }

  // ── ④ 全原子:settle 失败 → 整体回滚(订单仍 disputed、争议仍 open,可重试) ──
  {
    const o = mkOrder('delivered'); escalateFromDelivered(o); const d = mkDisputeRow(o)
    settleThrows = true
    const r = await call(o, {})
    ok('4a. settle failure → 409 DISPUTE_CLOSE_SETTLE_FAILED', r.status === 409 && r.json.error_code === 'DISPUTE_CLOSE_SETTLE_FAILED')
    ok('4b. order rolled back to disputed', st(o) === 'disputed')
    ok('4c. dispute rolled back to open (retryable)', dspRow(d)?.status === 'open')
    settleThrows = false
    ok('4d. retry succeeds after settle recovers', (await call(o, {})).status === 200 && st(o) === 'completed' && dspRow(d)?.status === 'dismissed')
  }

  // ── ⑤ 静态接线:状态机边 + DTO 谓词 + UI 卡 + i18n ──
  {
    const TR = readFileSync('src/layer0-foundation/L0-2-state-machine/transitions.ts', 'utf8')
    ok('5a. disputed→confirmed edge is buyer-only', /'disputed→confirmed':[\s\S]{0,600}?allowedRoles: \['buyer'\]/.test(TR))
    const RD = readFileSync('src/pwa/routes/orders-read.ts', 'utf8')
    ok('5b. DTO predicate mirrors route gate (delivered origin + initiator + buyer)',
      /can_confirm_receipt_close_dispute[\s\S]{0,400}?=== 'delivered'[\s\S]{0,200}?initiator_id === user\.id/.test(RD))
    const UI = readFileSync('src/pwa/public/app-dispute-close-ui.js', 'utf8')
    ok('5c. UI card gated on DTO flag + dp Passkey purpose_data action matches route', /can_confirm_receipt_close_dispute/.test(UI)
      && /requestPasskeyGate\('direct_pay_order_action', \{ order_id: oid, action: 'dispute_withdraw_confirm' \}\)/.test(UI))
    const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
    ok('5d. module loaded after mutual-cancel (wrapper needs original)', HTML.indexOf('app-dispute-close-ui.js') > HTML.indexOf('app-mutual-cancel.js') && HTML.indexOf('app-dispute-close-ui.js') > 0)
    const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
    const keys = new Set<string>()
    for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
    const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
    ok('5e. i18n parity', keys.size >= 9 && noEn.length === 0, noEn.slice(0, 3).join(' | '))
  }
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ dispute-withdraw-confirm FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ dispute withdraw-confirm (buyer-side consensual closure): guard matrix (buyer/initiator/origin/ruled) + escrow & dp happy paths (dp RISK gates) + atomic rollback/retry + wiring anchors\n  ✅ pass ${pass}`)
