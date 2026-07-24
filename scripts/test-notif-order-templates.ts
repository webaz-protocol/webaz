#!/usr/bin/env tsx
/**
 * 通知 i18n 模板迁移(N1 收口)+ N3 fee-prepay 三向通知 —— 引擎 + 静态 parity + HTTP e2e。
 *   ① notifyTransition 落库 template_key + params;direct_p2p 的资金语义 rail-fork
 *     (disputed→completed/cancelled、accepted→fault_seller 绝无"资金已释放/退回"话术)。
 *   ② 引擎能发出的每个 key 在 app-notif-templates-orders.js 有注册;t() 串全有 _EN。
 *   ③ fee-prepay 申请→root admin 收提醒;approve/reject→卖家收结果。
 * Usage: npm run test:notif-order-templates
 */
import { mkdtempSync } from 'fs'; import { readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'notif-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initNotificationSchema, notifyTransition } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { registerFeePrepayRequestRoutes } = await import('../src/pwa/routes/fee-prepay-requests.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initNotificationSchema(db)
const mkUser = (id: string, role = 'buyer', adminType: string | null = null): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key,admin_type) VALUES (?,?,?,?,?)').run(id, 'N_' + id, role, 'k_' + id, adminType)
}
try { db.exec('ALTER TABLE users ADD COLUMN admin_type TEXT') } catch { /* 已存在 */ }
mkUser('b1'); mkUser('s1', 'seller'); mkUser('root1', 'admin', 'root'); mkUser('reg1', 'admin', 'regional')
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','测试品','d',50,5)").run()

let oc = 0
function mkOrder(status: string, rail: string | null = null): string {
  const id = `o_${++oc}`
  db.prepare('INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?,?,?,?,1,50,50,0,?,?)')
    .run(id, 'p', 'b1', 's1', status, rail)
  return id
}
const lastNotif = (userId: string): Record<string, unknown> | undefined =>
  db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(userId) as Record<string, unknown> | undefined

// ── ① 引擎:template_key + params 落库 ──
{
  const o = mkOrder('paid', null)
  notifyTransition(db, o, 'created', 'paid')
  const n = lastNotif('s1')
  const p = JSON.parse(String(n?.params || '{}'))
  ok('1. escrow created→paid → ord_created_paid + params', n?.template_key === 'ord_created_paid'
    && p.buyer === 'N_b1' && p.product === '测试品' && p.amount === 50)
  ok('2. zh fallback title/body still written', String(n?.title).includes('新订单') && String(n?.body).includes('测试品'))
}
{
  const oe = mkOrder('confirmed', null); const od = mkOrder('confirmed', 'direct_p2p')
  notifyTransition(db, oe, 'delivered', 'confirmed'); const ne = lastNotif('s1')
  notifyTransition(db, od, 'delivered', 'confirmed'); const nd = lastNotif('s1')
  ok('3. delivered→confirmed rail-fork keys', ne?.template_key === 'ord_delivered_confirmed' && nd?.template_key === 'ord_delivered_confirmed_dp')
}
{
  const oe = mkOrder('disputed', null); const od = mkOrder('disputed', 'direct_p2p')
  notifyTransition(db, oe, 'disputed', 'cancelled'); const ne = lastNotif('b1')
  notifyTransition(db, od, 'disputed', 'cancelled'); const nd = lastNotif('b1')
  ok('4. disputed→cancelled rail-fork keys', ne?.template_key === 'ord_disputed_cancelled' && nd?.template_key === 'ord_disputed_cancelled_dp')
  ok('5. dp ruling body has NO custody-money claim', !String(nd?.body).includes('WAZ 已退回') && String(nd?.body).includes('非托管'))
  notifyTransition(db, od, 'disputed', 'completed'); const nc = lastNotif('b1')
  ok('6. dp disputed→completed fork (reputation-only wording)', nc?.template_key === 'ord_disputed_completed_dp' && !String(nc?.body).includes('资金已释放'))
}
{
  const od = mkOrder('accepted', 'direct_p2p')
  notifyTransition(db, od, 'accepted', 'fault_seller'); const nd = lastNotif('b1')
  ok('7. dp accepted→fault_seller fork (no "资金退回")', nd?.template_key === 'ord_accepted_fault_seller_dp' && !String(nd?.body).includes('资金退回'))
}

// ── ② 静态:key 覆盖 + i18n parity + dp 变体无资金话术 ──
{
  const ENG = readFileSync('src/layer2-business/L2-6-notifications/notification-engine.ts', 'utf8')
  // 客户端注册表 = orders + lifecycle + usdc-escrow 三个文件(后两者为 ratchet 禁续写 orders 文件时的新增)
  const TPL = readFileSync('src/pwa/public/app-notif-templates-orders.js', 'utf8')
    + readFileSync('src/pwa/public/app-notif-templates-lifecycle.js', 'utf8')
    + readFileSync('src/pwa/public/app-notif-templates-usdc-escrow.js', 'utf8')
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  const engineKeys = [...ENG.matchAll(/'(ord_[a-z_]+)'/g)].map(m => m[1])
  const registryKeys = new Set([...TPL.matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]))
  const missing = [...new Set(engineKeys)].filter(k => !registryKeys.has(k))
  ok('8. every engine ord_* key registered client-side', engineKeys.length >= 26 && missing.length === 0, `missing: ${missing.join(',')}`)
  const tplStrings = [...TPL.matchAll(/P\('[^']*', '([^']*)', '([^']*)'\)/g)].flatMap(m => [m[1], m[2]])
  const noEn = tplStrings.filter(zh => !I18N.includes(`'${zh}':`))
  ok('9. i18n parity: every template zh string has _EN', tplStrings.length >= 52 && noEn.length === 0, `missing _EN: ${noEn.slice(0, 3).join(' | ')}`)
  const dpBodies = [...TPL.matchAll(/(\w+_dp|ord_accepted_payment_query|ord_payment_query_\w+): P\('[^']*', '[^']*', '([^']*)'\)/g)].map(m => m[2])
  ok('10. dp template variants never claim platform money movement', dpBodies.length >= 7 && dpBodies.every(b => !/WAZ 已退回|资金已释放|资金退回|查看钱包|收益已入账/.test(b)))
  const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
  ok('11. notif templates registered via Object.assign (load-order safe)', /Object\.assign\(window\.NOTIF_TEMPLATES,/.test(TPL)
    && HTML.indexOf('app-notif-templates.js') < HTML.indexOf('app-notif-templates-orders.js')
    && HTML.indexOf('app-notif-templates-orders.js') < HTML.indexOf('app-notif-templates-lifecycle.js')
    && HTML.indexOf('app-notif-templates-lifecycle.js') < HTML.indexOf('app-notif-templates-usdc-escrow.js'))
}

// ── ③ N3:fee-prepay 三向通知(HTTP e2e)。fee 表已在 initDatabase();admin_audit_log 为 runtime-helper 表。──
db.prepare("CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))").run()
db.prepare('CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT, counter INTEGER DEFAULT 0)').run()
db.prepare("INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter) VALUES ('c_root','root1','pk',0)").run()
db.prepare("INSERT INTO platform_receive_accounts (id,method,currency,instruction,status) VALUES ('pacc1','PayNow','SGD','UEN 1','active')").run()
const app = express(); app.use(express.json())
const authStub = (req: Request, res: Response): Record<string, unknown> | null => {
  const uid = req.headers['x-test-uid'] as string | undefined
  if (!uid) { res.status(401).json({ error: 'login' }); return null }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'login' }); return null }
  return u
}
registerFeePrepayRequestRoutes(app, { db, auth: authStub, generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}` })
registerAdminDirectReceiveDepositsRoutes(app, {
  db,
  requireRootAdmin: (req: Request, res: Response) => { const u = authStub(req, res); if (!u) return null; if (u.admin_type !== 'root') { res.status(403).json({ error: 'root only' }); return null } return u },
  consumeGateToken: (_u: string, token: string | undefined, _purpose: string, validate: (d: unknown) => boolean) => {
    try { const d = JSON.parse(String(token || '{}')); return validate(d) ? { ok: true } : { ok: false, reason: 'mismatch' } } catch { return { ok: false, reason: 'bad token' } }
  },
  logAdminAction: () => {},
  getProtocolParam: <T,>(_k: string, f: T): T => f,
} as never)
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})

try {
  const sub = await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 25_000_000, platform_account_id: 'pacc1', evidence_ref: 'TXN-1' })
  const reqId = String((sub.json.request as Record<string, unknown>)?.id)
  const rootN = lastNotif('root1')
  ok('12. submit → root admin notified (template + params)', sub.status === 200 && rootN?.template_key === 'dp_fee_prepay_requested'
    && JSON.parse(String(rootN?.params)).amount === 25 && JSON.parse(String(rootN?.params)).seller === 'N_s1', JSON.stringify(sub.json))
  ok('13. regional admin NOT notified (approve is ROOT-gated)', lastNotif('reg1') === undefined)
  // approve → seller notified
  const ap = await call('POST', `/api/admin/direct-receive/fee-prepay-requests/${reqId}/approve`, 'root1',
    { method: 'usdc', webauthn_token: JSON.stringify({ request_id: reqId, seller_id: 's1', amount_units: 25_000_000, method: 'usdc' }) })
  const sellerN = lastNotif('s1')
  ok('14. approve → seller notified dp_fee_prepay_approved', ap.status === 200 && sellerN?.template_key === 'dp_fee_prepay_approved'
    && JSON.parse(String(sellerN?.params)).amount === 25, JSON.stringify(ap.json))
  // second request → reject → seller notified with note
  const sub2 = await call('POST', '/api/direct-receive/fee-prepay-request', 's1', { amount_units: 10_000_000, platform_account_id: 'pacc1', evidence_ref: 'TXN-2' })
  const reqId2 = String((sub2.json.request as Record<string, unknown>)?.id)
  const rj = await call('POST', `/api/admin/direct-receive/fee-prepay-requests/${reqId2}/reject`, 'root1',
    { note: '凭据不符', webauthn_token: JSON.stringify({ request_id: reqId2 }) })
  const sellerN2 = lastNotif('s1')
  ok('15. reject → seller notified dp_fee_prepay_rejected (+note param)', rj.status === 200 && sellerN2?.template_key === 'dp_fee_prepay_rejected'
    && String(JSON.parse(String(sellerN2?.params)).note).includes('凭据不符'), JSON.stringify(rj.json))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ notif-order-templates FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ notif order templates (N1 收口) + N3 fee-prepay notifications: engine template_key/params + dp rail-forks (no custody-money claims) + client registry coverage + i18n parity + submit/approve/reject 3-way alerts\n  ✅ pass ${pass}`)
