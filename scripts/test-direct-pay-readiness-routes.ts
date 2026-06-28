#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — readiness ROUTES 测试(seller 脱敏 self / admin ROOT+Passkey 完整)。
 * 验:GET /api/direct-receive/readiness = 卖家自助脱敏(无 raw blocker / KYB·制裁·AML 字样);
 *   POST /api/admin/direct-receive/readiness = ROOT + 真人 Passkey,返回完整 blockers/facts;非 root / 无 token 被拒。
 * Usage: npm run test:direct-pay-readiness-routes
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-rdy-routes-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerDirectPayAvailabilityRoutes } = await import('../src/pwa/routes/direct-pay-availability.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
db.exec("CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))")
for (const u of ['seller1', 'root1']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root','root1')").run()
// seed seller1 compliance facts (these MUST NOT leak to the seller endpoint)
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kyb1','seller1','approved')").run()
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc1','seller1','clear')").run()
db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status) VALUES ('af1','seller1','structuring','high','open')").run()

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
  auth: (req: Request, res: Response) => { const uid = req.headers['x-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'seller' } },
  getProtocolParam: gp,
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

// ══════ seller endpoint: de-identified self view ══════
ok('seller readiness requires auth → 401', (await req('GET', '/api/direct-receive/readiness', null)).status === 401)
const sr = await req('GET', '/api/direct-receive/readiness', null, { 'x-uid': 'seller1' })
ok('seller readiness → 200 { directPayReady, items[] }', sr.status === 200 && typeof sr.json?.directPayReady === 'boolean' && Array.isArray(sr.json?.items))
ok('seller readiness directPayReady=false on main', sr.json?.directPayReady === false)
ok('seller readiness leaks NO KYB/sanctions/AML/KYC terms (even though seller1 has all 3 facts)', !/KYB|SANCTION|AML|KYC/i.test(sr.raw))
ok('seller readiness leaks NO raw launch blocker codes', !/DIRECT_PAY_(NOT_ENABLED|RAIL_|REGION_NOT|PER_TX|NO_LEGAL|SELLER_)/.test(sr.raw))
ok('seller readiness only the 6 de-id codes', (sr.json?.items || []).every((i: any) => ['PLATFORM_OPEN', 'PAYMENT_INSTRUCTION', 'PASSKEY', 'BASE_BOND', 'COMPLIANCE_REVIEW', 'NOT_SUSPENDED'].includes(i.code)))

// ══════ admin endpoint: ROOT + Passkey, full facts ══════
ok('admin readiness non-root → 403', (await req('POST', '/api/admin/direct-receive/readiness', { seller_id: 'seller1' }, { 'x-uid': 'seller1' })).status === 403)
const aNoTok = await req('POST', '/api/admin/direct-receive/readiness', { seller_id: 'seller1' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('admin readiness root w/o Passkey token → 403 HUMAN_PRESENCE_REQUIRED', aNoTok.status === 403 && aNoTok.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(aNoTok.json))
ok('admin readiness gate-failure audited', (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.admin_readiness'").get() as any).n >= 1)
// valid purpose-bound token → 200 full readiness (blockers + facts, full detail allowed for ROOT)
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tkr','root1','direct_pay_admin_readiness',?,datetime('now','+60 seconds'))").run(JSON.stringify({ seller_id: 'seller1' }))
const aOk = await req('POST', '/api/admin/direct-receive/readiness', { seller_id: 'seller1', webauthn_token: 'tkr' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('admin readiness root + token → 200 { ready, blockers[], facts }', aOk.status === 200 && aOk.json?.ready === false && Array.isArray(aOk.json?.blockers) && !!aOk.json?.facts, JSON.stringify(aOk.json).slice(0, 120))
ok('admin readiness DOES expose full detail (seller compliance facts present for ROOT)', aOk.json?.facts?.kybPassed === true && aOk.json?.facts?.sanctionsClear === true && aOk.json?.facts?.amlClear === false)
ok('admin readiness includes seller-specific blockers (AML present for ROOT)', (aOk.json?.blockers || []).includes('DIRECT_PAY_SELLER_AML_REVIEW_REQUIRED'))
// token single-use
ok('admin readiness token single-use (reuse → 403)', (await req('POST', '/api/admin/direct-receive/readiness', { seller_id: 'seller1', webauthn_token: 'tkr' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-readiness-routes tests passed`)
