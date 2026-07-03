#!/usr/bin/env tsx
/**
 * GET /api/orders/:id 授权:白名单仲裁员(role 可能是 buyer,非 legacy 'arbitrator')必须能查看【争议中】的关联订单以裁定。
 *  ① order 当事方(buyer)→ 200。
 *  ② 白名单仲裁员(active,非当事方)查【disputed】订单 → 200(修复点:不再"无权查看此订单")。
 *  ③ 普通外人(非当事方 + 非仲裁员)→ 403 无权查看。
 *  ④ 白名单仲裁员查【非争议(paid)】订单 → 403(能力仅限争议单,非全量枚举)。
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
const { registerOrdersReadRoutes } = await import('../src/pwa/routes/orders-read.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initArbitratorReviewSchema(db); initWebauthnSchema(db); initOrderChainSchema(db)
D.initDisputeSchema(db); D.initEvidenceRequestSchema(db); initMutualCancelSchema(db)
const mkUser = (id: string, role = 'buyer'): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('cred_' + id, id, Buffer.from([1]))
}
mkUser('buyer1'); mkUser('seller1', 'seller'); mkUser('arb'); mkUser('outsider'); mkUser('roleArb', 'arbitrator')  // roleArb = legacy role only, NOT whitelisted
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

const noop = () => ({})
const app = express(); app.use(express.json())
registerOrdersReadRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } const u = db.prepare('SELECT role FROM users WHERE id=?').get(uid) as { role: string } | undefined; return { id: uid, role: u?.role || 'buyer', api_key: 'k_' + uid } },
  getOrderStatus, getOrderChain: noop, verifyOrderChain: noop, getOrderDispute: D.getOrderDispute,
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const get = (orderId: string, uid?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = {}; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: `/api/orders/${orderId}`, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.end()
})

try {
  const buyerView = await get(disputedOrder, 'buyer1')
  ok('1. order party (buyer) → 200', buyerView.status === 200 && buyerView.json?.order?.id === disputedOrder, JSON.stringify(buyerView).slice(0, 200))
  const arbView = await get(disputedOrder, 'arb')
  ok('2. whitelist arbitrator views DISPUTED order → 200 (not 无权查看)', arbView.status === 200 && arbView.json?.order?.id === disputedOrder, JSON.stringify(arbView).slice(0, 200))
  const outsiderView = await get(disputedOrder, 'outsider')
  ok('3. non-party non-arbitrator → 403 无权查看此订单', outsiderView.status === 403 && /无权查看/.test(outsiderView.json?.error || ''))
  const arbPaid = await get(paidOrder, 'arb')
  ok('4. whitelist arbitrator views NON-disputed (paid) order → 403 (scoped to disputes)', arbPaid.status === 403 && /无权查看/.test(arbPaid.json?.error || ''))

  // P1-1:仲裁员(非买家/卖家第三方)读 disputed direct_p2p 单 → 收款目标必须被剥离(instruction + qr_ref)
  const arbOrder = arbView.json?.order || {}
  let arbAcct: any = null; try { arbAcct = arbOrder.direct_pay_account_snapshot ? JSON.parse(arbOrder.direct_pay_account_snapshot) : null } catch {}
  ok('5. P1-1 arbitrator view strips direct-pay payment target (no instruction_snapshot, no qr_ref)', !arbOrder.direct_pay_instruction_snapshot && !(arbAcct && arbAcct.qr_ref), JSON.stringify({ instr: arbOrder.direct_pay_instruction_snapshot, acct: arbOrder.direct_pay_account_snapshot }))
  // 卖家=收款方,看【自己的】单不剥离(证明 strip 不越界)
  const sellerView = await get(disputedOrder, 'seller1')
  let selAcct: any = null; try { selAcct = sellerView.json?.order?.direct_pay_account_snapshot ? JSON.parse(sellerView.json.order.direct_pay_account_snapshot) : null } catch {}
  ok('6. seller (payee) still sees own payment target (strip not over-broad)', sellerView.status === 200 && !!sellerView.json?.order?.direct_pay_instruction_snapshot && selAcct?.qr_ref === 'qr_SECRET_ref')

  // P1-2:legacy role='arbitrator'(非 active whitelist)旁路已移除 → disputed 与 paid 均 403(能力源唯一=active whitelist)
  ok('7. P1-2 role-only arbitrator (not whitelisted) → DISPUTED 403 (legacy role bypass removed)', (await get(disputedOrder, 'roleArb')).status === 403)
  ok('8. P1-2 role-only arbitrator → PAID 403 (no read of arbitrary-status orders)', (await get(paidOrder, 'roleArb')).status === 403)
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ orders-read-arbitrator-view FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ orders-read-arbitrator-view: whitelist arbitrator can view the DISPUTED order (via active whitelist, not legacy role); outsiders + non-disputed orders stay 403\n  ✅ pass ${pass}`)
