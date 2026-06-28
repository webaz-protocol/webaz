#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — PR-6F 合规 ingress scaffold 测试。
 * 验:recordKybReview / recordSanctionsScreening / recordAmlFlagIngress 受控 append-only 写入 + 与 Phase 6 reader/breaker
 *   对齐 + allowlist fail-closed + 原子 PII-free 审计 + 无资金副作用;route ROOT + 真人 Passkey 门(三入口)。
 *   不接真实 vendor、不外呼、不做真实 STR。
 * Usage: npm run test:direct-pay-compliance-ingress
 */
import Database from 'better-sqlite3'
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { recordKybReview, recordSanctionsScreening, recordAmlFlagIngress } = await import('../src/direct-pay-compliance-ingress.js')
const { sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear } = await import('../src/direct-pay-controls.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
db.exec("CREATE TABLE direct_receive_kyb_reviews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, expires_at TEXT, reason TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))")
db.exec("CREATE TABLE sanctions_screening (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'clear', source TEXT, reason TEXT, screened_at TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')), expires_at TEXT)")
db.exec("CREATE TABLE aml_flags (id TEXT PRIMARY KEY, subject_user_id TEXT NOT NULL, related_order_id TEXT, rule TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'low', detail TEXT, status TEXT NOT NULL DEFAULT 'open', disposition TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now')))")
db.exec("CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))")
db.exec("CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)")
db.exec("CREATE TABLE webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)")
// 副作用断言表(ingress 绝不应触碰)
db.exec("CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL)")
db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, seller_id TEXT)")
db.exec("CREATE TABLE direct_pay_fee_stakes (id TEXT PRIMARY KEY, order_id TEXT)")

const auditN = (): number => (db.prepare("SELECT COUNT(*) n FROM admin_audit_log").get() as { n: number }).n
const sideEffectN = (): number => ['wallets', 'orders', 'direct_pay_fee_stakes'].reduce((s, t) => s + (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 0)
const PAST = "2000-01-01 00:00:00"

// ══════ Part A: helpers ══════
// 1. KYB approved → reader true
ok('1. recordKybReview(approved) → ok + sellerDirectPayKybPassed true', (() => { const r = recordKybReview(db, { userId: 'u_k1', reviewerId: 'rv', status: 'approved' }); return r.ok && sellerDirectPayKybPassed(db, 'u_k1') === true })())
// 2. KYB rejected / pending → not pass
ok('2a. recordKybReview(rejected) → reader false', (() => { recordKybReview(db, { userId: 'u_k2', reviewerId: 'rv', status: 'rejected' }); return sellerDirectPayKybPassed(db, 'u_k2') === false })())
ok('2b. recordKybReview(pending) → reader false', (() => { recordKybReview(db, { userId: 'u_k3', reviewerId: 'rv', status: 'pending' }); return sellerDirectPayKybPassed(db, 'u_k3') === false })())
// 3. sanctions clear → reader true
ok('3. recordSanctionsScreening(clear) → ok + sellerDirectPaySanctionsClear true', (() => { const r = recordSanctionsScreening(db, { userId: 'u_s1', reviewerId: 'rv', status: 'clear' }); return r.ok && sellerDirectPaySanctionsClear(db, 'u_s1') === true })())
// 4. sanctions flagged / blocked → not pass
ok('4a. recordSanctionsScreening(flagged) → reader false', (() => { recordSanctionsScreening(db, { userId: 'u_s2', reviewerId: 'rv', status: 'flagged' }); return sellerDirectPaySanctionsClear(db, 'u_s2') === false })())
ok('4b. recordSanctionsScreening(blocked) → reader false', (() => { recordSanctionsScreening(db, { userId: 'u_s3', reviewerId: 'rv', status: 'blocked' }); return sellerDirectPaySanctionsClear(db, 'u_s3') === false })())
// 5. sanctions clear but EXPIRED → fail-closed
ok('5. recordSanctionsScreening(clear, expired) → reader false (fail-closed)', (() => { const r = recordSanctionsScreening(db, { userId: 'u_s4', reviewerId: 'rv', status: 'clear', expiresAt: PAST }); return r.ok && sellerDirectPaySanctionsClear(db, 'u_s4') === false })())
// KYB expired likewise
ok('5b. recordKybReview(approved, expired) → reader false (fail-closed)', (() => { const r = recordKybReview(db, { userId: 'u_k4', reviewerId: 'rv', status: 'approved', expiresAt: PAST }); return r.ok && sellerDirectPayKybPassed(db, 'u_k4') === false })())
// 6. AML high/open ingress → breaker false
ok('6. recordAmlFlagIngress(structuring/high/open) → ok + sellerDirectPayAmlClear false', (() => { const r = recordAmlFlagIngress(db, { userId: 'u_a1', reviewerId: 'rv', rule: 'structuring', severity: 'high', status: 'open' }); return r.ok && sellerDirectPayAmlClear(db, 'u_a1') === false })())
// 7. invalid enums → rejected AND not written
const beforeInvalid = { kyb: (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews").get() as any).n, sc: (db.prepare("SELECT COUNT(*) n FROM sanctions_screening").get() as any).n, aml: (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n, aud: auditN() }
ok('7a. KYB invalid status → INVALID_STATUS', recordKybReview(db, { userId: 'x', reviewerId: 'rv', status: 'banana' }).error === 'INVALID_STATUS')
ok('7b. sanctions invalid status → INVALID_STATUS', recordSanctionsScreening(db, { userId: 'x', reviewerId: 'rv', status: 'hit' }).error === 'INVALID_STATUS')
ok('7c. AML invalid rule → INVALID_RULE', recordAmlFlagIngress(db, { userId: 'x', reviewerId: 'rv', rule: 'wat', severity: 'high', status: 'open' }).error === 'INVALID_RULE')
ok('7d. AML invalid severity → INVALID_SEVERITY', recordAmlFlagIngress(db, { userId: 'x', reviewerId: 'rv', rule: 'crypto', severity: 'critical', status: 'open' }).error === 'INVALID_SEVERITY')
ok('7e. AML invalid status → INVALID_STATUS', recordAmlFlagIngress(db, { userId: 'x', reviewerId: 'rv', rule: 'crypto', severity: 'high', status: 'weird' }).error === 'INVALID_STATUS')
ok('7f. invalid calls wrote NOTHING (tables + audit unchanged)', (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews").get() as any).n === beforeInvalid.kyb && (db.prepare("SELECT COUNT(*) n FROM sanctions_screening").get() as any).n === beforeInvalid.sc && (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n === beforeInvalid.aml && auditN() === beforeInvalid.aud)
// 8. every success wrote exactly one audit row (8 successful writes so far: k1,k2,k3,k4,s1,s2,s3,s4,a1 = 9)
ok('8. each success wrote one admin_audit_log row', auditN() === 9, `audit=${auditN()}`)
// 8b. audit PII-free: provider_ref stored as HASH, raw never appears
recordKybReview(db, { userId: 'u_pii', reviewerId: 'rv', status: 'approved', providerRef: 'VENDOR-SECRET-123' })
const piiAudit = db.prepare("SELECT detail FROM admin_audit_log WHERE target_id='u_pii'").get() as { detail: string }
ok('8b. audit detail has provider_ref_hash, NOT the raw provider ref', /"provider_ref_hash":"[0-9a-f]{16}"/.test(piiAudit.detail) && !/VENDOR-SECRET-123/.test(piiAudit.detail), piiAudit.detail)
// 9. no wallet/order/stake side effects
ok('9. ingress produced ZERO wallet/order/stake rows', sideEffectN() === 0)
// append-only: a later rejected KYB does NOT remove the earlier approved; reader flips false (blocked clause)
recordKybReview(db, { userId: 'u_k1', reviewerId: 'rv', status: 'revoked' })
ok('append-only: revoked appended (history kept) → reader now false; earlier approved row still present',
  sellerDirectPayKybPassed(db, 'u_k1') === false && (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews WHERE user_id='u_k1'").get() as any).n === 2)

// ══════ Part B: routes (ROOT + 真人 Passkey 门;三入口) ══════
const { consumeGateToken } = createHumanPresence(db, <T,>(_k: string, fb: T): T => fb)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root','root1')").run()  // root1 有 Passkey
let ac = 0
const logAdminAction = (adminId: string, action: string, tt: string | null, tid: string | null, detail?: Record<string, unknown>): void => {
  db.prepare("INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)").run('au_' + (++ac), adminId, action, tt, tid, detail ? JSON.stringify(detail) : null)
}
const app = express(); app.use(express.json())
registerAdminDirectReceiveDepositsRoutes(app, {
  db,
  requireRootAdmin: (req: Request, res: Response) => { if (req.headers['x-root'] !== '1') { res.status(403).json({ error: 'root only' }); return null } return { id: req.headers['x-uid'] as string, role: 'admin' } },
  consumeGateToken, logAdminAction,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
function call(path: string, body: Record<string, unknown>, h: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...h }
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } })
    })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}
const ROOT = { 'x-root': '1', 'x-uid': 'root1' }
const KYB = '/api/admin/direct-receive/kyb-reviews', SANC = '/api/admin/direct-receive/sanctions-screenings', AML = '/api/admin/direct-receive/aml-flags'

// 10a. 非 ROOT → 403(三入口)
ok('10a. kyb ingress non-root → 403', (await call(KYB, { user_id: 'r1', status: 'approved' })).status === 403)
ok('10b. sanctions ingress non-root → 403', (await call(SANC, { user_id: 'r1', status: 'clear' })).status === 403)
ok('10c. aml ingress non-root → 403', (await call(AML, { user_id: 'r1', rule: 'crypto', severity: 'high', status: 'open' })).status === 403)
// 10d. ROOT 但无 Passkey token → 403 HUMAN_PRESENCE_REQUIRED,无写入
const before10d = auditN()
const r10d = await call(SANC, { user_id: 'r_sanc', status: 'blocked' }, ROOT)
ok('10d. root + Passkey but no token → 403 HUMAN_PRESENCE_REQUIRED', r10d.status === 403 && r10d.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r10d))
ok('10e. gate-fail audited, NO sanctions row for r_sanc', auditN() === before10d + 1 && (db.prepare("SELECT COUNT(*) n FROM sanctions_screening WHERE user_id='r_sanc'").get() as any).n === 0)
// 10f. ROOT + Passkey + 有效 purpose-bound token → 200(逐入口端到端)
const mkTok = (id: string, purpose: string, data: Record<string, unknown>): void => { db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,datetime('now','+60 seconds'))").run(id, 'root1', purpose, JSON.stringify(data)) }
mkTok('tk', 'direct_pay_kyb_ingress', { user_id: 'r_kyb', status: 'approved' })
const r10f = await call(KYB, { user_id: 'r_kyb', status: 'approved', webauthn_token: 'tk' }, ROOT)
ok('10f. kyb ingress root+token → 200 + reader true (end-to-end)', r10f.status === 200 && r10f.json?.ok === true && sellerDirectPayKybPassed(db, 'r_kyb') === true, JSON.stringify(r10f))
mkTok('ts', 'direct_pay_sanctions_ingress', { user_id: 'r_sc', status: 'clear' })
const r10g = await call(SANC, { user_id: 'r_sc', status: 'clear', webauthn_token: 'ts' }, ROOT)
ok('10g. sanctions ingress root+token → 200 + reader true', r10g.status === 200 && sellerDirectPaySanctionsClear(db, 'r_sc') === true, JSON.stringify(r10g))
mkTok('ta', 'direct_pay_aml_ingress', { user_id: 'r_aml', rule: 'velocity', severity: 'high', status: 'open' })
const r10h = await call(AML, { user_id: 'r_aml', rule: 'velocity', severity: 'high', status: 'open', webauthn_token: 'ta' }, ROOT)
ok('10h. aml ingress root+token → 200 + breaker false', r10h.status === 200 && sellerDirectPayAmlClear(db, 'r_aml') === false, JSON.stringify(r10h))
// 10i. invalid enum through route → 400 (helper fail-closed)
mkTok('tx', 'direct_pay_kyb_ingress', { user_id: 'r_bad', status: 'banana' })
const r10i = await call(KYB, { user_id: 'r_bad', status: 'banana', webauthn_token: 'tx' }, ROOT)
ok('10i. invalid status via route → 400 INVALID_STATUS', r10i.status === 400 && r10i.json?.error_code === 'INVALID_STATUS', JSON.stringify(r10i))

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-compliance-ingress tests passed`)
