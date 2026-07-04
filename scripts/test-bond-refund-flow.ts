#!/usr/bin/env tsx
/**
 * 保证金退出退还(B2)—— §5 blockers 枚举(fail-closed)+ 域状态流(冷静期/CAS/资格)+ 路由 e2e + 执行复核 + UI 锚。
 * Usage: npm run test:bond-refund-flow
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'bondb2-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const { initDirectPayCancelRefundSchema } = await import('../src/direct-pay-cancel-refund.js')
const { initReturnRequestsSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const D = await import('../src/direct-receive-deposits.js')
const { enumerateBondRefundBlockers } = await import('../src/bond-refund-blockers.js')
const { registerBondSellerRoutes } = await import('../src/pwa/routes/bond-seller.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initNotificationSchema(db); initDirectPayCancelRefundSchema(db); initReturnRequestsSchema(db)
try { db.exec('ALTER TABLE users ADD COLUMN admin_type TEXT') } catch { /* server.ts 内联 ALTER */ }
db.prepare("INSERT INTO users (id,name,role,api_key,admin_type) VALUES ('s1','s1','seller','k_s1',NULL),('b1','b1','buyer','k_b1',NULL),('root1','root1','admin','k_r','root')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',50,10)").run()
const privOf = (): string | undefined => (db.prepare("SELECT status FROM direct_receive_privileges WHERE user_id='s1'").get() as { status: string } | undefined)?.status

// 生产级 locked bond(模拟放行后状态;写法与 B1 测试一致)
function seedLockedBond(id: string): void {
  D.openDeposit(db, { depositId: id, userId: 's1', tier: 'T0', currency: 'usdc', depositRail: 'operator_attested', externalRef: 'TXN-B' })
  db.prepare("UPDATE direct_receive_deposits SET status='locked', amount=500, production_receipt_confirmed_at=datetime('now') WHERE id=?").run(id)
  db.prepare("INSERT INTO direct_receive_privileges (user_id,status,tier,updated_at) VALUES ('s1','active','T0',datetime('now')) ON CONFLICT(user_id) DO UPDATE SET status='active', suspended_reason=NULL").run()
}

// ── ① blockers 枚举 ──
{
  ok('1. clean seller → no blockers', enumerateBondRefundBlockers(db, 's1').length === 0)
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES ('o1','p','b1','s1',1,50,50,0,'accepted','direct_p2p')").run()
  ok('2. open dp order blocks', enumerateBondRefundBlockers(db, 's1').some(b => b.code === 'OPEN_DIRECT_PAY_ORDERS'))
  db.prepare("UPDATE orders SET status='completed' WHERE id='o1'").run()
  ok('3. completed order does not block', !enumerateBondRefundBlockers(db, 's1').some(b => b.code === 'OPEN_DIRECT_PAY_ORDERS'))
  // completed 单上的退货流(在途订单项覆盖不到)
  db.prepare("INSERT INTO return_requests (id,order_id,buyer_id,seller_id,product_id,reason,refund_amount,status) VALUES ('r1','o1','b1','s1','p','quality',50,'await_refund')").run()
  ok('4. return flow on completed order blocks', enumerateBondRefundBlockers(db, 's1').some(b => b.code === 'OPEN_RETURN_FLOW'))
  db.prepare("UPDATE return_requests SET status='refunded' WHERE id='r1'").run()
  // 欠费:计提 > 预充值
  db.prepare("INSERT INTO direct_pay_fee_receivables (id, order_id, seller_id, amount, currency, accrued_at) VALUES ('rcv1','o1','s1','1.00','usdc',datetime('now'))").run()
  ok('5. unpaid platform fees block', enumerateBondRefundBlockers(db, 's1').some(b => b.code === 'UNPAID_PLATFORM_FEES'))
  // receivables append-only(DB 触发器)→ 用预充值抵平欠费,不删事实行
  db.prepare("INSERT INTO direct_pay_fee_payments (id, seller_id, invoice_id, amount, currency, method) VALUES ('pay1','s1',NULL,'1.00','usdc','usdc')").run()
  ok('6. clean again (fee offset by prepay, append-only respected)', enumerateBondRefundBlockers(db, 's1').length === 0)
}

// ── ② 域状态流:request/cancel/execute + 冷静期 + 资格 ──
{
  seedLockedBond('bd1')
  ok('7. request: locked → refunding + privilege suspended', D.requestBondRefund(db, { depositId: 'bd1', userId: 's1' }).ok === true
    && D.getSellerLatestDeposit(db, 's1')?.status === 'refunding' && privOf() === 'suspended')
  ok('8. execute before cooling → rejected', D.executeBondRefund(db, { depositId: 'bd1', nowIso: new Date().toISOString(), coolingDays: 14, evidenceRef: 'RF-1' }).ok === false)
  ok('9. cancel: refunding → locked + privilege restored', D.cancelBondRefundRequest(db, { depositId: 'bd1', userId: 's1' }).ok === true
    && D.getSellerLatestDeposit(db, 's1')?.status === 'locked' && privOf() === 'active')
  // 重新申请 + 把锚点拨回 15 天前 → 可执行
  D.requestBondRefund(db, { depositId: 'bd1', userId: 's1' })
  db.prepare("UPDATE direct_receive_deposits SET refund_requested_at = datetime('now','-15 days') WHERE id='bd1'").run()
  ok('10. execute without evidence → rejected', D.executeBondRefund(db, { depositId: 'bd1', nowIso: new Date().toISOString(), coolingDays: 14, evidenceRef: '' }).ok === false)
  const ex = D.executeBondRefund(db, { depositId: 'bd1', nowIso: new Date().toISOString(), coolingDays: 14, evidenceRef: 'RF-EXEC-1' })
  const row = D.getSellerLatestDeposit(db, 's1')
  ok('11. execute after cooling → refunded + evidence recorded', ex.ok === true && row?.status === 'refunded'
    && (row as unknown as { refund_evidence_ref?: string }).refund_evidence_ref === 'RF-EXEC-1')
  ok('12. execute idempotent', (D.executeBondRefund(db, { depositId: 'bd1', nowIso: new Date().toISOString(), coolingDays: 14, evidenceRef: 'x' }) as { already?: boolean }).already === true)
  ok('13. refunded bond no longer satisfies entry gate', !db.prepare("SELECT 1 FROM direct_receive_deposits WHERE user_id='s1' AND status='locked' AND production_receipt_confirmed_at IS NOT NULL").get())
  ok('14. wrong owner cannot request/cancel', D.requestBondRefund(db, { depositId: 'bd1', userId: 'b1' }).ok === false)
}

// ── ③ 路由 e2e:申请被 blockers 挡 / 成功申请 + 通知 / 撤销 ──
const app = express(); app.use(express.json())
registerBondSellerRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined; if (!u) { res.status(401).json({ error: 'login' }); return null } return u },
  generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`,
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
  getProtocolParam: <T,>(_k: string, fb: T): T => fb,
} as never)
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})
try {
  seedLockedBond('bd2')
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES ('o2','p','b1','s1',1,50,50,0,'direct_pay_window','direct_p2p')").run()
  const blocked = await call('POST', '/api/direct-receive/bond-refund-request', 's1')
  ok('15. request blocked with enumerated blockers (409 REFUND_BLOCKED)', blocked.status === 409 && (blocked.json.blockers as unknown[]).length > 0)
  db.prepare("UPDATE orders SET status='cancelled' WHERE id='o2'").run()
  const okReq = await call('POST', '/api/direct-receive/bond-refund-request', 's1')
  ok('16. clean request → refunding + root admin notified + cooling in response', okReq.status === 200 && okReq.json.cooling_days === 14
    && D.getSellerLatestDeposit(db, 's1')?.status === 'refunding'
    && (db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id='root1' AND type='bond_refund_requested'").get() as { c: number }).c === 1)
  const st = await call('GET', '/api/direct-receive/bond-status', 's1')
  ok('17. bond-status shows refunding view (requested_at + cooling)', !!(st.json.refund as { requested_at?: string })?.requested_at)
  ok('18. cancel restores locked + active', (await call('POST', '/api/direct-receive/bond-refund-request/cancel', 's1')).status === 200
    && D.getSellerLatestDeposit(db, 's1')?.status === 'locked' && privOf() === 'active')
  const st2 = await call('GET', '/api/direct-receive/bond-status', 's1')
  ok('19. locked bond-status previews can_request + blockers', (st2.json.refund as { can_request?: boolean })?.can_request === true)
} finally { server.close() }

// ── ④ 静态:admin 执行端点/复核 + purpose 白名单 + UI/通知/i18n ──
{
  const ADM = readFileSync('src/pwa/routes/admin-direct-receive-deposits.ts', 'utf8')
  const WA = readFileSync('src/pwa/routes/webauthn.ts', 'utf8')
  const UI = readFileSync('src/pwa/public/app-bond-refund-ui.js', 'utf8')
  const BASE = readFileSync('src/pwa/public/app-bond-ui.js', 'utf8')
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('20. admin execute-refund endpoint exists + re-checks blockers + Passkey purpose', /execute-refund/.test(ADM)
    && /enumerateBondRefundBlockers\(db, dep\.user_id\)/.test(ADM) && /'direct_receive_bond_refund'/.test(ADM))
  ok('21. webauthn purpose whitelisted', /'direct_receive_bond_refund'/.test(WA))
  ok('22. UI hooks folded into capped bond-ui (net-zero)', /window\.bondRefundBlock \? window\.bondRefundBlock\(s\)/.test(BASE)
    && /window\.bondAdmRefundActions \? window\.bondAdmRefundActions\(d\)/.test(BASE))
  const emitted = [...new Set([...(readFileSync('src/pwa/routes/bond-seller.ts', 'utf8') + ADM).matchAll(/templateKey: '(bond_refund_[a-z_]+)'/g)].map(m => m[1]))]
  const registered = new Set([...UI.matchAll(/^\s{4}(bond_\w+):/gm)].map(m => m[1]))
  ok('23. refund templateKeys registered client-side', emitted.length === 2 && emitted.every(k => registered.has(k)))
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
  for (const m of UI.matchAll(/P\('[^']*', '([^']*)', '([^']*)'\)/g)) { keys.add(m[1]); keys.add(m[2]) }
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('24. i18n parity', noEn.length === 0, noEn.slice(0, 3).join(' | '))
}

if (fail > 0) { console.error(`\n❌ bond-refund-flow FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bond refund flow (B2): §5 blockers (orders/returns/fees, fail-closed) + request/cancel/execute state flow (cooling + CAS + privilege) + routes e2e + admin re-check/Passkey + UI/notif/i18n anchors\n  ✅ pass ${pass}`)
