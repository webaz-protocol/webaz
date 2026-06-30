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

const { recordKybReview, recordSanctionsScreening, recordAmlFlagIngress, amlDetailHash, isNumericDetail, normalizeExpiry } = await import('../src/direct-pay-compliance-ingress.js')
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
db.exec("CREATE TABLE direct_pay_fee_payments (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, invoice_id TEXT, amount REAL NOT NULL CHECK (amount >= 0), currency TEXT, method TEXT, received_at TEXT, recorded_by TEXT, evidence_ref TEXT, note TEXT)")
db.exec("CREATE TABLE direct_pay_fee_receivables (id TEXT PRIMARY KEY, order_id TEXT, seller_id TEXT, amount REAL, currency TEXT, accrued_at TEXT)")
db.exec("CREATE TABLE direct_pay_fee_adjustments (id TEXT PRIMARY KEY, receivable_id TEXT, seller_id TEXT, delta_amount REAL, currency TEXT, kind TEXT, reason TEXT, created_at TEXT, created_by TEXT)")
db.exec("CREATE TABLE direct_pay_fee_prepay_refunds (id TEXT PRIMARY KEY, seller_id TEXT, amount REAL NOT NULL CHECK (amount >= 0), currency TEXT, method TEXT, evidence_ref TEXT, reason TEXT, recorded_by TEXT, created_at TEXT)")

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
// 6b. P2: AML detail 仅允许聚合数字;PII-like(字符串)detail → INVALID_DETAIL,不写
ok('6b. isNumericDetail: allowlist-key numbers ok / non-allowlist key / string value / array / undefined', isNumericDetail({ order_count: 3, window_hours: 24 }) === true && isNumericDetail({ foo: 1 }) === false && isNumericDetail({ order_count: 'a@b.com' }) === false && isNumericDetail(undefined) === true && isNumericDetail([1, 2]) === false)
const amlBeforePII = (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n
const rPII = recordAmlFlagIngress(db, { userId: 'u_pii_aml', reviewerId: 'rv', rule: 'crypto', severity: 'high', status: 'open', detail: { wallet: '0xabc', note: 'lives at 5th ave' } as any })
ok('6c. AML ingress with PII-like (string) detail → INVALID_DETAIL, NOT written', rPII.error === 'INVALID_DETAIL' && (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n === amlBeforePII)
// PII hidden in the KEY (allowlisted value) → still INVALID_DETAIL, not written
const rPIIKey = recordAmlFlagIngress(db, { userId: 'u_pii_key', reviewerId: 'rv', rule: 'crypto', severity: 'high', status: 'open', detail: { 'alice@example.com': 1 } as any })
ok('6c2. AML ingress with PII in KEY ({"alice@example.com":1}) → INVALID_DETAIL, NOT written', rPIIKey.error === 'INVALID_DETAIL' && (db.prepare("SELECT COUNT(*) n FROM aml_flags WHERE subject_user_id='u_pii_key'").get() as any).n === 0)
const rNum = recordAmlFlagIngress(db, { userId: 'u_num_aml', reviewerId: 'rv', rule: 'velocity', severity: 'medium', status: 'open', detail: { order_count: 7, window_hours: 24 } })
ok('6d. AML ingress with numeric detail → ok, stored', rNum.ok === true && JSON.parse((db.prepare("SELECT detail FROM aml_flags WHERE id=?").get(rNum.id) as any).detail).order_count === 7)

// 6e. P1: invalid expires_at(任意字符串)→ INVALID_EXPIRES_AT,不写;reader 不会被坏日期误判为通过
const kybBeforeBadExp = (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews WHERE user_id='u_badexp'").get() as any).n
const rBadKyb = recordKybReview(db, { userId: 'u_badexp', reviewerId: 'rv', status: 'approved', expiresAt: 'not-a-date' })
ok('6e. KYB approved + bad expires_at → INVALID_EXPIRES_AT, NOT written', rBadKyb.error === 'INVALID_EXPIRES_AT' && (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews WHERE user_id='u_badexp'").get() as any).n === kybBeforeBadExp)
ok('6e-2. bad-date KYB never created → reader false (not fooled by lexical "future")', sellerDirectPayKybPassed(db, 'u_badexp') === false)
const rBadSanc = recordSanctionsScreening(db, { userId: 'u_badexp2', reviewerId: 'rv', status: 'clear', expiresAt: 'not-a-date' })
ok('6f. sanctions clear + bad expires_at → INVALID_EXPIRES_AT, NOT written', rBadSanc.error === 'INVALID_EXPIRES_AT' && (db.prepare("SELECT COUNT(*) n FROM sanctions_screening WHERE user_id='u_badexp2'").get() as any).n === 0)
ok('6f-2. bad-date sanctions never created → reader false', sellerDirectPaySanctionsClear(db, 'u_badexp2') === false)
// partial / nonsense dates also rejected
ok('6g. partial date "2024" → INVALID_EXPIRES_AT', recordKybReview(db, { userId: 'u_p', reviewerId: 'rv', status: 'approved', expiresAt: '2024' }).error === 'INVALID_EXPIRES_AT')
ok('6h. impossible date "2024-13-99 99:99:99" → INVALID_EXPIRES_AT', recordKybReview(db, { userId: 'u_p2', reviewerId: 'rv', status: 'approved', expiresAt: '2024-13-99 99:99:99' }).error === 'INVALID_EXPIRES_AT')
// 6h2-6h4: well-formed but non-existent dates must NOT be auto-rolled into a valid future fact (no Date.parse leniency)
ok('6h2. rollover dates rejected (Feb-31 / Apr-31 / hour 25, sqlite + ISO)', normalizeExpiry('2099-02-31 00:00:00').ok === false && normalizeExpiry('2099-02-31T00:00:00Z').ok === false && normalizeExpiry('2099-04-31 00:00:00').ok === false && normalizeExpiry('2099-01-01T25:00:00Z').ok === false)
ok('6h3. ISO without timezone rejected (no local-tz normalization)', normalizeExpiry('2099-01-01T00:00:00').ok === false)
ok('6h4. real leap day / real date accepted (positive control)', normalizeExpiry('2096-02-29 00:00:00').ok === true && normalizeExpiry('2099-02-28T00:00:00Z').ok === true)
const rRoll = recordKybReview(db, { userId: 'u_roll', reviewerId: 'rv', status: 'approved', expiresAt: '2099-02-31 00:00:00' })
ok('6h5. KYB Feb-31 expiry → INVALID_EXPIRES_AT, not written, reader false', rRoll.error === 'INVALID_EXPIRES_AT' && (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews WHERE user_id='u_roll'").get() as any).n === 0 && sellerDirectPayKybPassed(db, 'u_roll') === false)
const rRollS = recordSanctionsScreening(db, { userId: 'u_roll2', reviewerId: 'rv', status: 'clear', expiresAt: '2099-02-31T00:00:00Z' })
ok('6h6. sanctions Feb-31 ISO expiry → INVALID_EXPIRES_AT, not written, reader false', rRollS.error === 'INVALID_EXPIRES_AT' && (db.prepare("SELECT COUNT(*) n FROM sanctions_screening WHERE user_id='u_roll2'").get() as any).n === 0 && sellerDirectPaySanctionsClear(db, 'u_roll2') === false)
// valid ISO future expiry → normalized + reader true; valid ISO past → reader false (fail-closed)
ok('6i. valid ISO future expiry → normalized + reader true', (() => { const r = recordKybReview(db, { userId: 'u_iso', reviewerId: 'rv', status: 'approved', expiresAt: '2099-01-01T00:00:00Z' }); const stored = (db.prepare("SELECT expires_at e FROM direct_receive_kyb_reviews WHERE user_id='u_iso'").get() as any)?.e; return r.ok && stored === '2099-01-01 00:00:00' && sellerDirectPayKybPassed(db, 'u_iso') === true })())
ok('6j. valid ISO past expiry → reader false (fail-closed)', (() => { const r = recordSanctionsScreening(db, { userId: 'u_iso2', reviewerId: 'rv', status: 'clear', expiresAt: '2000-01-01T00:00:00Z' }); return r.ok && sellerDirectPaySanctionsClear(db, 'u_iso2') === false })())

// 7. invalid enums → rejected AND not written
const beforeInvalid = { kyb: (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews").get() as any).n, sc: (db.prepare("SELECT COUNT(*) n FROM sanctions_screening").get() as any).n, aml: (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n, aud: auditN() }
ok('7a. KYB invalid status → INVALID_STATUS', recordKybReview(db, { userId: 'x', reviewerId: 'rv', status: 'banana' }).error === 'INVALID_STATUS')
ok('7b. sanctions invalid status → INVALID_STATUS', recordSanctionsScreening(db, { userId: 'x', reviewerId: 'rv', status: 'hit' }).error === 'INVALID_STATUS')
ok('7c. AML invalid rule → INVALID_RULE', recordAmlFlagIngress(db, { userId: 'x', reviewerId: 'rv', rule: 'wat', severity: 'high', status: 'open' }).error === 'INVALID_RULE')
ok('7d. AML invalid severity → INVALID_SEVERITY', recordAmlFlagIngress(db, { userId: 'x', reviewerId: 'rv', rule: 'crypto', severity: 'critical', status: 'open' }).error === 'INVALID_SEVERITY')
ok('7e. AML invalid status → INVALID_STATUS', recordAmlFlagIngress(db, { userId: 'x', reviewerId: 'rv', rule: 'crypto', severity: 'high', status: 'weird' }).error === 'INVALID_STATUS')
ok('7f. invalid calls wrote NOTHING (tables + audit unchanged)', (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews").get() as any).n === beforeInvalid.kyb && (db.prepare("SELECT COUNT(*) n FROM sanctions_screening").get() as any).n === beforeInvalid.sc && (db.prepare("SELECT COUNT(*) n FROM aml_flags").get() as any).n === beforeInvalid.aml && auditN() === beforeInvalid.aud)
// 8. every success wrote exactly one audit row (k1-k4,s1-s4,a1,rNum,u_iso,u_iso2 = 12; rejected PII/enum/bad-expiry write none)
ok('8. each success wrote one admin_audit_log row', auditN() === 12, `audit=${auditN()}`)
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
mkTok('ta', 'direct_pay_aml_ingress', { user_id: 'r_aml', rule: 'velocity', severity: 'high', status: 'open', related_order_id: '', detail_hash: amlDetailHash(undefined) })
const r10h = await call(AML, { user_id: 'r_aml', rule: 'velocity', severity: 'high', status: 'open', webauthn_token: 'ta' }, ROOT)
ok('10h. aml ingress root+token → 200 + breaker false', r10h.status === 200 && sellerDirectPayAmlClear(db, 'r_aml') === false, JSON.stringify(r10h))
// 10i. invalid enum through route → 400 (helper fail-closed)
mkTok('tx', 'direct_pay_kyb_ingress', { user_id: 'r_bad', status: 'banana' })
const r10i = await call(KYB, { user_id: 'r_bad', status: 'banana', webauthn_token: 'tx' }, ROOT)
ok('10i. invalid status via route → 400 INVALID_STATUS', r10i.status === 400 && r10i.json?.error_code === 'INVALID_STATUS', JSON.stringify(r10i))
// 10j. bad expires_at via route (token bound to same bad value so gate passes) → 400 INVALID_EXPIRES_AT, no row
mkTok('tj', 'direct_pay_sanctions_ingress', { user_id: 'r_badexp', status: 'clear', provider_ref: '', expires_at: 'not-a-date' })
const r10j = await call(SANC, { user_id: 'r_badexp', status: 'clear', expires_at: 'not-a-date', webauthn_token: 'tj' }, ROOT)
ok('10j. bad expires_at via route → 400 INVALID_EXPIRES_AT, no sanctions row', r10j.status === 400 && r10j.json?.error_code === 'INVALID_EXPIRES_AT' && (db.prepare("SELECT COUNT(*) n FROM sanctions_screening WHERE user_id='r_badexp'").get() as any).n === 0, JSON.stringify(r10j))
// 10k. rollover date (Feb-31) via route → 400 INVALID_EXPIRES_AT, no row
mkTok('tk2', 'direct_pay_kyb_ingress', { user_id: 'r_roll', status: 'approved', provider_ref: '', expires_at: '2099-02-31 00:00:00' })
const r10k = await call(KYB, { user_id: 'r_roll', status: 'approved', expires_at: '2099-02-31 00:00:00', webauthn_token: 'tk2' }, ROOT)
ok('10k. Feb-31 expiry via route → 400 INVALID_EXPIRES_AT, no kyb row', r10k.status === 400 && r10k.json?.error_code === 'INVALID_EXPIRES_AT' && (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews WHERE user_id='r_roll'").get() as any).n === 0, JSON.stringify(r10k))

// ══════ P1 negative: token signs A, body writes B → 403, NO ledger/audit write ══════
const kybN = (): number => (db.prepare("SELECT COUNT(*) n FROM direct_receive_kyb_reviews WHERE user_id='r_bind'").get() as any).n
// token bound to provider_ref='REF_A' + expires_at='' ; body sends provider_ref='REF_B' → mismatch
mkTok('tb1', 'direct_pay_kyb_ingress', { user_id: 'r_bind', status: 'approved', provider_ref: 'REF_A', expires_at: '' })
const auditB1 = auditN()
const rN1 = await call(KYB, { user_id: 'r_bind', status: 'approved', provider_ref: 'REF_B', webauthn_token: 'tb1' }, ROOT)
ok('P1a. KYB token signs provider_ref=A, body=B → 403, no row', rN1.status === 403 && rN1.json?.error_code === 'HUMAN_PRESENCE_REQUIRED' && kybN() === 0, JSON.stringify(rN1))
ok('P1a-2. gate-fail audited, ledger untouched', auditN() === auditB1 + 1)
// token bound to expires_at='' ; body sends a non-empty expires_at → mismatch (token single-use consumed above, fresh token)
mkTok('tb2', 'direct_pay_kyb_ingress', { user_id: 'r_bind', status: 'approved', provider_ref: '', expires_at: '' })
const rN2 = await call(KYB, { user_id: 'r_bind', status: 'approved', expires_at: '2099-01-01 00:00:00', webauthn_token: 'tb2' }, ROOT)
ok('P1b. KYB token signs expires_at="", body sets expiry → 403, no row', rN2.status === 403 && kybN() === 0, JSON.stringify(rN2))
// AML: token signs detail {count:1}, body sends detail {count:2} → detail_hash mismatch → 403, no flag
mkTok('tb3', 'direct_pay_aml_ingress', { user_id: 'r_bind2', rule: 'velocity', severity: 'high', status: 'open', related_order_id: '', detail_hash: amlDetailHash({ order_count: 1 }) })
const rN3 = await call(AML, { user_id: 'r_bind2', rule: 'velocity', severity: 'high', status: 'open', detail: { order_count: 2 }, webauthn_token: 'tb3' }, ROOT)
ok('P1c. AML token signs detail{count:1}, body writes {count:2} → 403, no flag', rN3.status === 403 && (db.prepare("SELECT COUNT(*) n FROM aml_flags WHERE subject_user_id='r_bind2'").get() as any).n === 0, JSON.stringify(rN3))
// AML: matching detail_hash → 200 (positive control for the binding)
mkTok('tb4', 'direct_pay_aml_ingress', { user_id: 'r_bind3', rule: 'velocity', severity: 'high', status: 'open', related_order_id: '', detail_hash: amlDetailHash({ order_count: 2 }) })
const rN4 = await call(AML, { user_id: 'r_bind3', rule: 'velocity', severity: 'high', status: 'open', detail: { order_count: 2 }, webauthn_token: 'tb4' }, ROOT)
ok('P1d. AML token detail_hash matches body detail → 200 (binding positive control)', rN4.status === 200 && (db.prepare("SELECT COUNT(*) n FROM aml_flags WHERE subject_user_id='r_bind3'").get() as any).n === 1, JSON.stringify(rN4))

// ══════ Part C: fee-prepay top-up route(ROOT + 真人 Passkey;append-only payment + admin audit)══════
const FEEP = '/api/admin/direct-receive/fee-prepay'
const payN = (sid: string): number => (db.prepare("SELECT COUNT(*) n FROM direct_pay_fee_payments WHERE seller_id=?").get(sid) as any).n
const auditFor = (sid: string): number => (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE target_id=? AND action='direct_pay.fee_prepay_record'").get(sid) as any).n
// 11a. 非 ROOT → 403,无 payment
ok('11a. fee-prepay non-root → 403, no payment', (await call(FEEP, { seller_id: 'fp1', amount_units: 1000, method: 'usdc' })).status === 403 && payN('fp1') === 0)
// 11b. ROOT 无 token → 403 HUMAN_PRESENCE_REQUIRED,无 payment
const r11b = await call(FEEP, { seller_id: 'fp2', amount_units: 1000, method: 'usdc' }, ROOT)
ok('11b. root no token → 403, no payment', r11b.status === 403 && r11b.json?.error_code === 'HUMAN_PRESENCE_REQUIRED' && payN('fp2') === 0)
// 11c. ROOT + 有效 purpose-bound token → 200 + payment 写入 + admin_audit_log(direct_pay.fee_prepay_record)
mkTok('tfp', 'direct_pay_fee_prepay_record', { seller_id: 'fp3', amount_units: 50_000_000, method: 'usdc', evidence_ref: 'tx#9' })
const r11c = await call(FEEP, { seller_id: 'fp3', amount_units: 50_000_000, method: 'usdc', evidence_ref: 'tx#9', webauthn_token: 'tfp' }, ROOT)
ok('11c. root+token → 200 + payment row + audit row', r11c.status === 200 && r11c.json?.ok === true && payN('fp3') === 1 && auditFor('fp3') === 1, JSON.stringify(r11c))
ok('11c-2. payment is unallocated prepayment (invoice_id NULL)', (db.prepare("SELECT invoice_id FROM direct_pay_fee_payments WHERE seller_id='fp3'").get() as any).invoice_id === null)
// 11d. purpose_data 不匹配(token 绑 fp4/1000,body 写 fp4/2000)→ 403,无 payment
mkTok('tfp2', 'direct_pay_fee_prepay_record', { seller_id: 'fp4', amount_units: 1000, method: 'usdc', evidence_ref: '' })
const r11d = await call(FEEP, { seller_id: 'fp4', amount_units: 2000, method: 'usdc', webauthn_token: 'tfp2' }, ROOT)
ok('11d. token signs amount=1000, body=2000 → 403, no payment', r11d.status === 403 && payN('fp4') === 0, JSON.stringify(r11d))
// 11e. 非法 amount(0)经 route(token 绑同值,gate 过)→ 400,无 payment
mkTok('tfp3', 'direct_pay_fee_prepay_record', { seller_id: 'fp5', amount_units: 0, method: 'usdc', evidence_ref: '' })
const r11e = await call(FEEP, { seller_id: 'fp5', amount_units: 0, method: 'usdc', webauthn_token: 'tfp3' }, ROOT)
ok('11e. amount 0 via route → 400 AMOUNT_MUST_BE_POSITIVE, no payment', r11e.status === 400 && payN('fp5') === 0, JSON.stringify(r11e))
// 11f. 非法 method 经 route → 400,无 payment
mkTok('tfp4', 'direct_pay_fee_prepay_record', { seller_id: 'fp6', amount_units: 1000, method: 'paypal', evidence_ref: '' })
const r11f = await call(FEEP, { seller_id: 'fp6', amount_units: 1000, method: 'paypal', webauthn_token: 'tfp4' }, ROOT)
ok('11f. bad method via route → 400 BAD_METHOD, no payment', r11f.status === 400 && payN('fp6') === 0, JSON.stringify(r11f))

// ══════ Part D: fee-adjust / fee-refund / fee-account(ROOT + Passkey 写;ROOT 只读账户)══════
const ADJ = '/api/admin/direct-receive/fee-adjust', REF = '/api/admin/direct-receive/fee-refund'
const adjN = (sid: string): number => (db.prepare("SELECT COUNT(*) n FROM direct_pay_fee_adjustments WHERE seller_id=?").get(sid) as any).n
const refN = (sid: string): number => (db.prepare("SELECT COUNT(*) n FROM direct_pay_fee_prepay_refunds WHERE seller_id=?").get(sid) as any).n
// 12a. adjust root+token → 200 + adjustment row + audit
mkTok('tadj', 'direct_pay_fee_adjust', { seller_id: 'fa1', delta_units: 5_000_000, reason: 'goodwill' })
const r12a = await call(ADJ, { seller_id: 'fa1', delta_units: 5_000_000, reason: 'goodwill', webauthn_token: 'tadj' }, ROOT)
ok('12a. fee-adjust root+token → 200 + adj row + audit', r12a.status === 200 && adjN('fa1') === 1 && (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.fee_adjust' AND target_id='fa1'").get() as any).n === 1, JSON.stringify(r12a))
// 12b. adjust purpose_data mismatch → 403 no row
mkTok('tadj2', 'direct_pay_fee_adjust', { seller_id: 'fa2', delta_units: 5_000_000, reason: 'x' })
ok('12b. fee-adjust delta mismatch → 403 no row', (await call(ADJ, { seller_id: 'fa2', delta_units: 9_000_000, reason: 'x', webauthn_token: 'tadj2' }, ROOT)).status === 403 && adjN('fa2') === 0)
// 12c. refund > available → 400 REFUND_EXCEEDS_AVAILABLE, no row(fa3 无预充值 → available 0)
mkTok('tref0', 'direct_pay_fee_refund', { seller_id: 'fa3', amount_units: 1_000_000, method: 'usdc', evidence_ref: '' })
const r12c = await call(REF, { seller_id: 'fa3', amount_units: 1_000_000, method: 'usdc', webauthn_token: 'tref0' }, ROOT)
const failAudit12c = (db.prepare("SELECT detail FROM admin_audit_log WHERE action='direct_pay_fee_refund' AND target_id='fa3'").get() as any)
ok('12c. refund > available → 400 REFUND_EXCEEDS_AVAILABLE, no row, BUT failure audit written', r12c.status === 400 && r12c.json?.error_code === 'REFUND_EXCEEDS_AVAILABLE' && refN('fa3') === 0 && !!failAudit12c && JSON.parse(failAudit12c.detail).ok === false && JSON.parse(failAudit12c.detail).error_code === 'REFUND_EXCEEDS_AVAILABLE', JSON.stringify(r12c))
// 12d. seed 预充值 50 → refund 30 ≤ available → 200 + refund row + audit
db.prepare("INSERT INTO direct_pay_fee_payments (id,seller_id,invoice_id,amount,currency,method) VALUES ('pp_fa4','fa4',NULL,50,'usdc','usdc')").run()
mkTok('tref', 'direct_pay_fee_refund', { seller_id: 'fa4', amount_units: 30_000_000, method: 'usdc', evidence_ref: 'rr#1' })
const r12d = await call(REF, { seller_id: 'fa4', amount_units: 30_000_000, method: 'usdc', evidence_ref: 'rr#1', webauthn_token: 'tref' }, ROOT)
ok('12d. refund ≤ available → 200 + refund row + audit', r12d.status === 200 && refN('fa4') === 1 && (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.fee_refund' AND target_id='fa4'").get() as any).n === 1, JSON.stringify(r12d))
// 12e. fee-account GET:non-root 403 / root 200 + account(fa4 available = 50-30 = 20 USDC)
const getReq = (headers: Record<string, string>): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => { const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/admin/direct-receive/fee-account/fa4', headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) }); rq.on('error', reject); rq.end() })
ok('12e. fee-account non-root → 403', (await getReq({})).status === 403)
const r12f = await getReq(ROOT)
ok('12f. fee-account root → 200 + available 20 USDC', r12f.status === 200 && r12f.json?.account?.availableUnits === 20_000_000, JSON.stringify(r12f.json))

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-compliance-ingress tests passed`)
