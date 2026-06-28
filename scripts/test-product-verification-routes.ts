#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 按产品认证 ROUTES 测试(seller 申领/提交/查 + admin 队列/核验)。
 * 验:
 *  - seller POST/PUT 必须【拥有该产品】(非 owner 403);申领→issued+code;提交校验 http(s);GET 列自己逐产品状态。
 *  - admin GET 队列 ROOT-only;非法 status 400。
 *  - admin POST review = ROOT + 真人 Passkey(硬门:核验=放行该产品直付)。无 Passkey 凭证(agent)硬拒;无 token →
 *    HUMAN_PRESENCE;purpose_data 绑 verification_id+decision(签 A 用 B 拒);token 单次;gate 失败也审计;verify→该产品 verified。
 * Usage: npm run test:product-verification-routes
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'pv-routes-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerDirectPayAvailabilityRoutes } = await import('../src/pwa/routes/direct-pay-availability.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')
const { productStoreVerified } = await import('../src/product-verification.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); setSeamDb(db)   // 产品所有权读走 dbOne 异步 seam
db.pragma('foreign_keys = OFF')
db.exec("CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))")
for (const u of ['seller1', 'seller2', 'root1', 'root_nopk']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root','root1')").run()   // root1 有 Passkey;root_nopk 无
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('pA','seller1','A','d',50,10,'active')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES ('pOther','seller2','O','d',50,10,'active')").run()

const cp: Record<string, unknown> = {}
const gp = <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
const { consumeGateToken } = createHumanPresence(db, gp)
let ac = 0
const logAdminAction = (adminId: string, action: string, tt: string | null, tid: string | null, detail?: Record<string, unknown>): void => {
  db.prepare("INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)").run('au_' + (++ac), adminId, action, tt, tid, detail ? JSON.stringify(detail) : null)
}
const app = express(); app.use(express.json())
registerDirectPayAvailabilityRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: (req.headers['x-role'] as string) || 'seller' } },
  getProtocolParam: gp, generateId,
})
registerAdminDirectReceiveDepositsRoutes(app, {
  db,
  requireRootAdmin: (req: Request, res: Response) => { if (req.headers['x-root'] !== '1') { res.status(403).json({ error: 'root only' }); return null } return { id: req.headers['x-uid'] as string, role: 'admin' } },
  consumeGateToken, logAdminAction, getProtocolParam: gp,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
function req(method: string, path: string, body: Record<string, unknown> | null, h: Record<string, string> = {}): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...h }
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null, raw: d }) } catch { resolve({ status: res.statusCode || 0, json: d, raw: d }) } })
    })
    rq.on('error', reject); if (payload) rq.write(payload); rq.end()
  })
}

// ══════ 1. seller request code ══════
ok('1. request requires auth → 401', (await req('POST', '/api/direct-receive/product-verification', { product_id: 'pA' })).status === 401)
ok('1a. non-seller → 403 SELLER_ONLY', (await req('POST', '/api/direct-receive/product-verification', { product_id: 'pA' }, { 'x-uid': 'seller1', 'x-role': 'buyer' })).json?.error_code === 'SELLER_ONLY')
ok('1b. not the product owner → 403 NOT_PRODUCT_OWNER', (await req('POST', '/api/direct-receive/product-verification', { product_id: 'pOther' }, { 'x-uid': 'seller1' })).json?.error_code === 'NOT_PRODUCT_OWNER')
ok('1c. missing product_id → 400', (await req('POST', '/api/direct-receive/product-verification', {}, { 'x-uid': 'seller1' })).json?.error_code === 'MISSING_PRODUCT_ID')
const r1 = await req('POST', '/api/direct-receive/product-verification', { product_id: 'pA', platform: 'Taobao' }, { 'x-uid': 'seller1' })
ok('1d. owner request → 200 issued + code', r1.status === 200 && r1.json?.status === 'issued' && typeof r1.json?.code === 'string', JSON.stringify(r1.json))

// ══════ 2. seller submit link ══════
ok('2. submit invalid url → 400', (await req('PUT', '/api/direct-receive/product-verification', { product_id: 'pA', external_url: 'ftp://x' }, { 'x-uid': 'seller1' })).status === 400)
ok('2a. submit by non-owner → 403', (await req('PUT', '/api/direct-receive/product-verification', { product_id: 'pOther', external_url: 'https://x.com' }, { 'x-uid': 'seller1' })).json?.error_code === 'NOT_PRODUCT_OWNER')
ok('2b. owner submit valid https → 200 submitted', (await req('PUT', '/api/direct-receive/product-verification', { product_id: 'pA', external_url: 'https://shop.example.com/item/1' }, { 'x-uid': 'seller1' })).json?.status === 'submitted')

// ══════ 3. seller list own ══════
const sl = await req('GET', '/api/direct-receive/product-verifications', null, { 'x-uid': 'seller1' })
ok('3. seller lists own product verifications', sl.status === 200 && Array.isArray(sl.json?.verifications) && sl.json.verifications.some((v: any) => v.product_id === 'pA' && v.status === 'submitted'))

// ══════ 4. admin queue ══════
ok('4. admin queue non-root → 403', (await req('GET', '/api/admin/direct-receive/product-verifications', null, { 'x-uid': 'seller1' })).status === 403)
ok('4a. bad status → 400', (await req('GET', '/api/admin/direct-receive/product-verifications?status=bogus', null, { 'x-root': '1', 'x-uid': 'root1' })).json?.error_code === 'BAD_STATUS')
const q = await req('GET', '/api/admin/direct-receive/product-verifications?status=submitted', null, { 'x-root': '1', 'x-uid': 'root1' })
const vid: string = q.json?.verifications?.find((v: any) => v.product_id === 'pA')?.id
ok('4b. queue lists submitted pA', q.status === 200 && !!vid)

// ══════ 5. admin review — ROOT + Passkey iron-rule (verify = capability-granting) ══════
ok('5. review non-root → 403', (await req('POST', `/api/admin/direct-receive/product-verifications/${vid}/review`, { decision: 'verified' }, { 'x-uid': 'seller1' })).status === 403)
const rpk = await req('POST', `/api/admin/direct-receive/product-verifications/${vid}/review`, { decision: 'verified' }, { 'x-root': '1', 'x-uid': 'root_nopk' })
ok('5a. ROOT w/o Passkey credential (agent) → 403 PASSKEY_REQUIRED_FOR_DIRECT_PAY', rpk.status === 403 && rpk.json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY')
ok('5b. ROOT + Passkey, no token → 403 HUMAN_PRESENCE_REQUIRED', (await req('POST', `/api/admin/direct-receive/product-verifications/${vid}/review`, { decision: 'verified' }, { 'x-root': '1', 'x-uid': 'root1' })).json?.error_code === 'HUMAN_PRESENCE_REQUIRED')
ok('5c. review gate-failures audited', (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.product_verify'").get() as any).n >= 2)
// purpose_data mismatch: token bound to decision 'rejected' but request asks 'verified' → 403
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_bad','root1','direct_pay_product_verify',?,datetime('now','+60 seconds'))").run(JSON.stringify({ verification_id: vid, decision: 'rejected' }))
ok('5d. token bound to different decision → 403', (await req('POST', `/api/admin/direct-receive/product-verifications/${vid}/review`, { decision: 'verified', webauthn_token: 'tk_bad' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)
// valid token bound to exact verification_id + decision → 200 verified
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_ok','root1','direct_pay_product_verify',?,datetime('now','+60 seconds'))").run(JSON.stringify({ verification_id: vid, decision: 'verified' }))
const rv = await req('POST', `/api/admin/direct-receive/product-verifications/${vid}/review`, { decision: 'verified', webauthn_token: 'tk_ok' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('5e. ROOT + valid purpose-bound token → 200 verified', rv.status === 200 && rv.json?.status === 'verified', JSON.stringify(rv.json))
ok('5f. product pA now hard-gate verified', productStoreVerified(db, 'pA') === true)
ok('5g. token single-use (reuse → 403)', (await req('POST', `/api/admin/direct-receive/product-verifications/${vid}/review`, { decision: 'verified', webauthn_token: 'tk_ok' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)

// ══════ 6. de-id: seller GET must NOT leak reviewer/admin id or internal notes (after a reviewed row exists) ══════
// stamp an internal note + reviewer on pA's row directly, then confirm the seller view omits them.
db.prepare("UPDATE product_verifications SET reviewed_by = 'root1', notes = 'INTERNAL: cross-checked against registry' WHERE product_id = 'pA'").run()
const sl2 = await req('GET', '/api/direct-receive/product-verifications', null, { 'x-uid': 'seller1' })
const paRow = (sl2.json?.verifications || []).find((v: any) => v.product_id === 'pA')
ok('6. seller view still shows pA (verified) with seller-safe fields', !!paRow && paRow.status === 'verified' && paRow.code && paRow.reviewed_at)
ok('6a. seller view OMITS reviewed_by (admin identity)', paRow && !('reviewed_by' in paRow))
ok('6b. seller view OMITS notes (internal review notes)', paRow && !('notes' in paRow))
ok('6c. raw payload leaks NO admin id / internal note string', !/root1|INTERNAL|reviewed_by|cross-checked/i.test(sl2.raw))

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} product-verification-routes tests passed`)
