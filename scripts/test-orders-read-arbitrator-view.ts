#!/usr/bin/env tsx
/**
 * GET /api/orders/:id + /chain + 列表 授权与投影:白名单仲裁员(role 可能是 buyer,非 legacy 'arbitrator')
 * 可查看【存在争议记录】的订单(含已裁定 —— 裁定后订单离开 disputed,复盘/已结 tab 仍需可见);无争议记录不可枚举。
 *  1-4 基线:当事方 200 / 仲裁员查争议单 200 / 外人 403 / 无争议记录(paid)403。
 *  5-6 直付收款目标:第三方(仲裁员)整段剥离(instruction+整个 account_snapshot),卖家(收款方)保留。
 *  7-8 legacy role-only 旁路已移除(disputed/paid 均 403)。
 *  9   已裁定(refunded_full,dispute 行仍在)→ 仲裁员 200(审计:只放行 disputed 会让已结 tab"查看订单"全 403)。
 *  10  /chain 与详情同谓词:白名单仲裁员可验链,role-only 403(审计:chain 曾留 legacy 旁路,双向断裂)。
 *  11  列表 /api/orders 对 logistics 第三方剥离收款目标(审计:列表曾漏 strip,同 P1-1 类)。
 * Usage: npm run test:orders-read-arbitrator-view
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'ord-arb-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, getOrderStatus } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initArbitratorReviewSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const D = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { grantArbitrator } = await import('../src/pwa/arbitrator-lifecycle.js')
const { initMutualCancelSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.js')
const { initDirectPayCancelRefundSchema } = await import('../src/direct-pay-cancel-refund.js')
const { registerOrdersReadRoutes } = await import('../src/pwa/routes/orders-read.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initArbitratorReviewSchema(db); initWebauthnSchema(db); initOrderChainSchema(db)
D.initDisputeSchema(db); D.initEvidenceRequestSchema(db); initMutualCancelSchema(db); initDirectPayCancelRefundSchema(db)
const mkUser = (id: string, role = 'buyer'): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('cred_' + id, id, Buffer.from([1]))
}
mkUser('buyer1'); mkUser('seller1', 'seller'); mkUser('arb'); mkUser('outsider'); mkUser('roleArb', 'arbitrator'); mkUser('logi', 'logistics')  // roleArb = legacy role only, NOT whitelisted
grantArbitrator(db, { userId: 'arb', grantedBy: 'admin1' })   // active whitelist, role stays buyer
try { db.exec('ALTER TABLE products ADD COLUMN return_days INTEGER') } catch { /* 真实库已有 */ }
try { db.exec('ALTER TABLE products ADD COLUMN images TEXT') } catch { /* 真实库已有 */ }
for (const col of ['direct_pay_instruction_snapshot TEXT', 'direct_pay_account_snapshot TEXT']) { try { db.exec('ALTER TABLE orders ADD COLUMN ' + col) } catch { /* 已有 */ } }
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,images) VALUES ('p','seller1','P','d',50,9,'[]')").run()

let oc = 0
function mkOrder(status: string): string {
  const id = `o_${++oc}`
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p','buyer1','seller1',1,50,50,0,?,'direct_p2p')").run(id, status)
  db.prepare("INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,evidence_ids,notes) VALUES (?,?,?,?,'buyer1','buyer','[]','x')").run(`h_${id}`, id, 'accepted', status)
  // 直付收款目标快照(卖家自填)——P1-1:第三方 reader 绝不该看到
  db.prepare("UPDATE orders SET direct_pay_instruction_snapshot=?, direct_pay_account_snapshot=? WHERE id=?").run('PayNow +65-9999-8888', JSON.stringify({ method: 'paynow', currency: 'SGD', label: 'my paynow', qr_ref: 'qr_SECRET_ref' }), id)
  if (status === 'disputed') { const r = D.createDispute(db, id, 'buyer1', '争议', []); if (!r.success) throw new Error(r.error) }
  return id
}
const disputedOrder = mkOrder('disputed')
const paidOrder = mkOrder('paid')
// 已裁定订单:曾进 disputed(dispute 行存在),裁定后状态离开 disputed —— 仲裁员复盘必须仍可见
const ruledOrder = mkOrder('disputed')
db.prepare("UPDATE orders SET status='refunded_full' WHERE id=?").run(ruledOrder)
// logistics 被指派的在途直付单(列表投影用例:第三方不得见收款目标)
const shippedOrder = mkOrder('shipped')
db.prepare("UPDATE orders SET logistics_id='logi' WHERE id=?").run(shippedOrder)

const noop = () => ({})
const app = express(); app.use(express.json())
registerOrdersReadRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } const u = db.prepare('SELECT role FROM users WHERE id=?').get(uid) as { role: string } | undefined; return { id: uid, role: u?.role || 'buyer', api_key: 'k_' + uid } },
  getOrderStatus, getOrderChain: noop, verifyOrderChain: noop, getOrderDispute: D.getOrderDispute,
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const req = (path: string, uid?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = {}; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.end()
})
const get = (orderId: string, uid?: string) => req(`/api/orders/${orderId}`, uid)

try {
  const buyerView = await get(disputedOrder, 'buyer1')
  ok('1. order party (buyer) → 200', buyerView.status === 200 && buyerView.json?.order?.id === disputedOrder, JSON.stringify(buyerView).slice(0, 200))
  const arbView = await get(disputedOrder, 'arb')
  ok('2. whitelist arbitrator views DISPUTED order → 200 (not 无权查看)', arbView.status === 200 && arbView.json?.order?.id === disputedOrder, JSON.stringify(arbView).slice(0, 200))
  const outsiderView = await get(disputedOrder, 'outsider')
  ok('3. non-party non-arbitrator → 403 无权查看此订单', outsiderView.status === 403 && /无权查看/.test(outsiderView.json?.error || ''))
  const arbPaid = await get(paidOrder, 'arb')
  ok('4. whitelist arbitrator views order with NO dispute record (paid) → 403 (no enumeration)', arbPaid.status === 403 && /无权查看/.test(arbPaid.json?.error || ''))

  // P1-1:仲裁员(非买家/卖家第三方)读 disputed direct_p2p 单 → 收款目标必须【整段】剥离(strip 删除整个 account_snapshot,
  //   断言按 helper 的完整承诺来 —— 只查 qr_ref 会放过"留 method/label 明细"的部分回归)
  const arbOrder = arbView.json?.order || {}
  ok('5. P1-1 arbitrator view strips ENTIRE payment target (no instruction_snapshot, no account_snapshot at all)', !arbOrder.direct_pay_instruction_snapshot && !arbOrder.direct_pay_account_snapshot, JSON.stringify({ instr: arbOrder.direct_pay_instruction_snapshot, acct: arbOrder.direct_pay_account_snapshot }))
  // 卖家=收款方,看【自己的】单不剥离(证明 strip 不越界)
  const sellerView = await get(disputedOrder, 'seller1')
  let selAcct: any = null; try { selAcct = sellerView.json?.order?.direct_pay_account_snapshot ? JSON.parse(sellerView.json.order.direct_pay_account_snapshot) : null } catch {}
  ok('6. seller (payee) still sees own payment target (strip not over-broad)', sellerView.status === 200 && !!sellerView.json?.order?.direct_pay_instruction_snapshot && selAcct?.qr_ref === 'qr_SECRET_ref')

  // P1-2:legacy role='arbitrator'(非 active whitelist)旁路已移除 → disputed 与 paid 均 403(能力源唯一=active whitelist)
  ok('7. P1-2 role-only arbitrator (not whitelisted) → DISPUTED 403 (legacy role bypass removed)', (await get(disputedOrder, 'roleArb')).status === 403)
  ok('8. P1-2 role-only arbitrator → PAID 403 (no read of arbitrary-status orders)', (await get(paidOrder, 'roleArb')).status === 403)

  // 审计发现 2:裁定落地后订单离开 disputed,但 dispute 行仍在 → 仲裁员复盘/已结 tab"查看订单"必须仍 200
  const ruledView = await get(ruledOrder, 'arb')
  ok('9. RULED order (refunded_full, dispute record exists) → whitelist arbitrator still 200 (post-ruling review works)', ruledView.status === 200 && ruledView.json?.order?.id === ruledOrder, JSON.stringify(ruledView).slice(0, 160))
  ok('9b. outsider still 403 on ruled order (widening is arbitrator-only)', (await get(ruledOrder, 'outsider')).status === 403)

  // 审计发现 1:/chain 与详情同谓词 —— 白名单仲裁员可验签名链;role-only 旁路移除
  ok('10a. /chain: whitelist arbitrator on disputed order → 200 (chain badge/verify works for adjudication)', (await req(`/api/orders/${disputedOrder}/chain`, 'arb')).status === 200)
  ok('10b. /chain: role-only arbitrator → 403 (legacy bypass removed from chain too)', (await req(`/api/orders/${disputedOrder}/chain`, 'roleArb')).status === 403)
  ok('10c. /chain: whitelist arbitrator on NO-dispute order → 403', (await req(`/api/orders/${paidOrder}/chain`, 'arb')).status === 403)
  ok('10d. /chain: party (buyer) still 200', (await req(`/api/orders/${disputedOrder}/chain`, 'buyer1')).status === 200)

  // 审计发现 3:列表 /api/orders 对 logistics 第三方剥离收款目标(与详情同款 strip)
  const logiList = await req('/api/orders', 'logi')
  const logiRow = Array.isArray(logiList.json) ? logiList.json.find((o: any) => o.id === shippedOrder) : null
  ok('11. list strips payment target for assigned logistics third party', logiList.status === 200 && !!logiRow && !logiRow.direct_pay_instruction_snapshot && !logiRow.direct_pay_account_snapshot, JSON.stringify(logiRow || logiList.json).slice(0, 200))
  const sellerList = await req('/api/orders', 'seller1')
  const sellerRow = Array.isArray(sellerList.json) ? sellerList.json.find((o: any) => o.id === shippedOrder) : null
  ok('11b. list keeps payee (seller) target intact', !!sellerRow && !!sellerRow.direct_pay_instruction_snapshot)

  // 审计项 F:duplicate_amount_alert 仅卖家视角下发(同买家·同金额在途多单对账告警;买家无此字段,少一分敞口)
  const accA = mkOrder('accepted'); mkOrder('accepted')   // 两笔同买卖家·同金额 accepted 单
  const sellerDetail = await get(accA, 'seller1')
  ok('12. seller detail carries duplicate_amount_alert ≥1 on same-amount in-flight orders', sellerDetail.status === 200 && Number(sellerDetail.json?.order?.duplicate_amount_alert) >= 1, JSON.stringify(sellerDetail.json?.order?.duplicate_amount_alert))
  const buyerDetail = await get(accA, 'buyer1')
  ok('12b. buyer detail does NOT carry duplicate_amount_alert', buyerDetail.status === 200 && buyerDetail.json?.order?.duplicate_amount_alert === undefined, JSON.stringify({ s: buyerDetail.status, v: buyerDetail.json?.order?.duplicate_amount_alert }))
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ orders-read-arbitrator-view FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ orders-read-arbitrator-view: whitelist arbitrator can view the DISPUTED order (via active whitelist, not legacy role); outsiders + non-disputed orders stay 403\n  ✅ pass ${pass}`)
