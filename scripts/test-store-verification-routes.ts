#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 店铺认证(逐品豁免)ROUTES 测试。
 * 验:seller 申领/提交/查(脱敏:无 reviewed_by/notes,含 exempt 位);admin 队列 ROOT-only;
 *   admin review = ROOT + 真人 Passkey,purpose_data 绑 verification_id+decision+per_product_exempt(改豁免位→拒);
 *   勾选豁免 verify → sellerExemptFromPerProduct true;token 单次;gate 失败也审计。
 * Usage: npm run test:store-verification-routes
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'sv-routes-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerDirectPayAvailabilityRoutes } = await import('../src/pwa/routes/direct-pay-availability.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')
const { sellerExemptFromPerProduct } = await import('../src/store-verification.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); setSeamDb(db)
db.pragma('foreign_keys = OFF')
db.exec("CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))")
for (const u of ['seller1', 'root1', 'root_nopk']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root','root1')").run()

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

// ── 1. seller request/submit/get ──
ok('1. request requires auth → 401', (await req('POST', '/api/direct-receive/store-verification', {})).status === 401)
ok('1a. non-seller → 403 SELLER_ONLY', (await req('POST', '/api/direct-receive/store-verification', {}, { 'x-uid': 'seller1', 'x-role': 'buyer' })).json?.error_code === 'SELLER_ONLY')
const r1 = await req('POST', '/api/direct-receive/store-verification', { platform: 'Taobao' }, { 'x-uid': 'seller1' })
ok('1b. seller request → 200 issued + code', r1.status === 200 && r1.json?.status === 'issued' && typeof r1.json?.code === 'string')
ok('1c. submit bad url → 400', (await req('PUT', '/api/direct-receive/store-verification', { external_url: 'nope' }, { 'x-uid': 'seller1' })).status === 400)
ok('1d. submit valid → 200 submitted', (await req('PUT', '/api/direct-receive/store-verification', { external_url: 'https://store.example.com/s1' }, { 'x-uid': 'seller1' })).json?.status === 'submitted')
const sg = await req('GET', '/api/direct-receive/store-verification', null, { 'x-uid': 'seller1' })
ok('1e. seller GET → DTO with status + exempt flag, no reviewed_by/notes', sg.json?.verification?.status === 'submitted' && sg.json?.exempt === false && !/reviewed_by|notes/i.test(sg.raw))

// ── 2. admin queue ──
ok('2. queue non-root → 403', (await req('GET', '/api/admin/direct-receive/store-verifications', null, { 'x-uid': 'seller1' })).status === 403)
ok('2a. bad status → 400', (await req('GET', '/api/admin/direct-receive/store-verifications?status=bogus', null, { 'x-root': '1', 'x-uid': 'root1' })).json?.error_code === 'BAD_STATUS')
const q = await req('GET', '/api/admin/direct-receive/store-verifications?status=submitted', null, { 'x-root': '1', 'x-uid': 'root1' })
const vid: string = q.json?.verifications?.find((v: any) => v.user_id === 'seller1')?.id
ok('2b. queue lists submitted seller1 store', q.status === 200 && !!vid)

// ── 3. admin review — ROOT + Passkey; exempt bound in purpose_data ──
ok('3. non-root → 403', (await req('POST', `/api/admin/direct-receive/store-verifications/${vid}/review`, { decision: 'verified', per_product_exempt: true }, { 'x-uid': 'seller1' })).status === 403)
ok('3a. ROOT w/o Passkey credential (agent) → 403 PASSKEY_REQUIRED', (await req('POST', `/api/admin/direct-receive/store-verifications/${vid}/review`, { decision: 'verified', per_product_exempt: true }, { 'x-root': '1', 'x-uid': 'root_nopk' })).json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY')
ok('3b. ROOT + Passkey, no token → 403 HUMAN_PRESENCE_REQUIRED', (await req('POST', `/api/admin/direct-receive/store-verifications/${vid}/review`, { decision: 'verified', per_product_exempt: true }, { 'x-root': '1', 'x-uid': 'root1' })).json?.error_code === 'HUMAN_PRESENCE_REQUIRED')
ok('3c. gate failures audited', (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.store_verify'").get() as any).n >= 2)
// token bound to exempt=false but request exempt=true → 403 (per_product_exempt is part of the signed terms)
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_bad','root1','direct_pay_store_verify',?,datetime('now','+60 seconds'))").run(JSON.stringify({ verification_id: vid, decision: 'verified', per_product_exempt: false }))
ok('3d. token bound to exempt=false vs request exempt=true → 403', (await req('POST', `/api/admin/direct-receive/store-verifications/${vid}/review`, { decision: 'verified', per_product_exempt: true, webauthn_token: 'tk_bad' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)
// valid token bound to exempt=true → 200 verified + exempt
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_ok','root1','direct_pay_store_verify',?,datetime('now','+60 seconds'))").run(JSON.stringify({ verification_id: vid, decision: 'verified', per_product_exempt: true }))
const rv = await req('POST', `/api/admin/direct-receive/store-verifications/${vid}/review`, { decision: 'verified', per_product_exempt: true, webauthn_token: 'tk_ok' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('3e. ROOT + valid token + exempt → 200 verified + per_product_exempt', rv.status === 200 && rv.json?.status === 'verified' && rv.json?.per_product_exempt === true, JSON.stringify(rv.json))
ok('3f. seller1 now exempt from per-product', sellerExemptFromPerProduct(db, 'seller1') === true)
ok('3g. token single-use (reuse → 403)', (await req('POST', `/api/admin/direct-receive/store-verifications/${vid}/review`, { decision: 'verified', per_product_exempt: true, webauthn_token: 'tk_ok' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} store-verification-routes tests passed`)
