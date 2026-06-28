#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — PR-6E AML flag 合规复核 workflow 测试。
 * 验:reviewAmlFlag(唯一受控 review writer)decision 校验 + clear/escalate/suspend 与 #107 breaker 对齐 +
 *   reviewed_by/at 写入 + 原子 audit(无 PII)+ 无资金/订单副作用;route ROOT + 真人 Passkey 门(拒未授权/无 Passkey,
 *   放行真人 token)。不接真实 AML vendor、不做真实 STR。
 * Usage: npm run test:direct-pay-aml-review
 */
import Database from 'better-sqlite3'
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { reviewAmlFlag } = await import('../src/direct-pay-aml-review.js')
const { sellerDirectPayAmlClear } = await import('../src/direct-pay-controls.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerAdminDirectReceiveDepositsRoutes } = await import('../src/pwa/routes/admin-direct-receive-deposits.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
db.exec("CREATE TABLE aml_flags (id TEXT PRIMARY KEY, subject_user_id TEXT NOT NULL, related_order_id TEXT, rule TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'low', detail TEXT, status TEXT NOT NULL DEFAULT 'open', disposition TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now')))")
db.exec("CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))")
db.exec("CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)")
db.exec("CREATE TABLE webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)")
// 副作用断言表(review 绝不应触碰)
db.exec("CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL)")
db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, seller_id TEXT)")
db.exec("CREATE TABLE direct_pay_fee_stakes (id TEXT PRIMARY KEY, order_id TEXT)")

const mkFlag = (id: string, subject: string, severity: string, status: string, disposition: string | null = null): void => {
  db.prepare("INSERT INTO aml_flags (id, subject_user_id, rule, severity, status, disposition) VALUES (?,?,?,?,?,?)").run(id, subject, 'velocity', severity, status, disposition)
}
const flagRow = (id: string): any => db.prepare("SELECT status, disposition, reviewed_by, reviewed_at, detail FROM aml_flags WHERE id=?").get(id)
const auditN = (): number => (db.prepare("SELECT COUNT(*) n FROM admin_audit_log").get() as { n: number }).n
const sideEffectN = (): number => {
  const w = (db.prepare("SELECT COUNT(*) n FROM wallets").get() as { n: number }).n
  const o = (db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n
  const s = (db.prepare("SELECT COUNT(*) n FROM direct_pay_fee_stakes").get() as { n: number }).n
  return w + o + s
}

// ══════ Part A: reviewAmlFlag helper ══════
// 1. unknown flag → fail
ok('1. unknown flag → { ok:false, FLAG_NOT_FOUND }', (() => { const r = reviewAmlFlag(db, { flagId: 'nope', reviewerId: 'rv1', decision: 'clear' }); return r.ok === false && r.error === 'FLAG_NOT_FOUND' })())
// 2. invalid decision → fail
mkFlag('f_inv', 's_inv', 'medium', 'open')
ok('2. invalid decision → { ok:false, INVALID_DECISION }', (() => { const r = reviewAmlFlag(db, { flagId: 'f_inv', reviewerId: 'rv1', decision: 'banana' }); return r.ok === false && r.error === 'INVALID_DECISION' })())
ok('2b. invalid decision did NOT mutate the flag', flagRow('f_inv').status === 'open' && flagRow('f_inv').reviewed_by === null)

// 3. clear → cleared/downgrade, breaker true
mkFlag('f_clear', 's_clear', 'high', 'open')
ok('3-pre: open/high flag → breaker FALSE (blocking)', sellerDirectPayAmlClear(db, 's_clear') === false)
const rClear = reviewAmlFlag(db, { flagId: 'f_clear', reviewerId: 'rv_a', decision: 'clear', notes: 'reviewed, benign' })
ok('3. clear → ok, status=cleared, disposition=downgrade', rClear.ok && flagRow('f_clear').status === 'cleared' && flagRow('f_clear').disposition === 'downgrade', JSON.stringify(rClear))
ok('3b. after clear → sellerDirectPayAmlClear TRUE (unblocked)', sellerDirectPayAmlClear(db, 's_clear') === true)
// clear 覆盖旧 suspend(确保解除真的解除)
mkFlag('f_clear2', 's_clear2', 'high', 'open', 'suspend')
reviewAmlFlag(db, { flagId: 'f_clear2', reviewerId: 'rv_a', decision: 'clear' })
ok('3c. clear overrides prior suspend → breaker TRUE', sellerDirectPayAmlClear(db, 's_clear2') === true && flagRow('f_clear2').disposition === 'downgrade')

// 4. escalate (medium) → still blocking
mkFlag('f_esc', 's_esc', 'medium', 'open')
const rEsc = reviewAmlFlag(db, { flagId: 'f_esc', reviewerId: 'rv_b', decision: 'escalate' })
ok('4. escalate → status=escalated, disposition=review_queue', rEsc.ok && flagRow('f_esc').status === 'escalated' && flagRow('f_esc').disposition === 'review_queue')
ok('4b. after escalate (medium) → breaker still FALSE (blocking)', sellerDirectPayAmlClear(db, 's_esc') === false)

// 5. suspend → blocking even if status='cleared'
mkFlag('f_susp', 's_susp', 'high', 'cleared')  // 先是 cleared(不阻断)
ok('5-pre: cleared flag → breaker TRUE', sellerDirectPayAmlClear(db, 's_susp') === true)
const rSusp = reviewAmlFlag(db, { flagId: 'f_susp', reviewerId: 'rv_c', decision: 'suspend' })
ok('5. suspend → disposition=suspend, status preserved (cleared)', rSusp.ok && flagRow('f_susp').disposition === 'suspend' && flagRow('f_susp').status === 'cleared')
ok('5b. after suspend → breaker FALSE even though status=cleared (suspend wins)', sellerDirectPayAmlClear(db, 's_susp') === false)

// 6. reviewed_by / reviewed_at written
ok('6. reviewed_by + reviewed_at written', flagRow('f_clear').reviewed_by === 'rv_a' && typeof flagRow('f_clear').reviewed_at === 'string' && flagRow('f_clear').reviewed_at.length > 0)
ok('6b. notes NOT persisted to flag (no reviewer-notes column; PII kept out)', flagRow('f_clear').detail === null)

// 7. audit log written (no PII: ids + decision only; NO notes)
const aud = db.prepare("SELECT admin_id, action, target_type, target_id, detail FROM admin_audit_log WHERE target_id='f_clear'").get() as any
ok('7. audit row: action=direct_pay.aml_review, target=aml_flag/f_clear, admin=reviewer', aud && aud.action === 'direct_pay.aml_review' && aud.target_type === 'aml_flag' && aud.target_id === 'f_clear' && aud.admin_id === 'rv_a', JSON.stringify(aud))
ok('7b. audit detail has subject_user_id + decision, and NO notes/PII', (() => { const d = JSON.parse(aud.detail); return d.subject_user_id === 's_clear' && d.decision === 'clear' && !('notes' in d) && !/benign/.test(aud.detail) })(), aud?.detail)
ok('7c. every successful review wrote exactly one audit row', auditN() === 4)  // clear, clear2, escalate, suspend (none for the 2 failed helper calls)

// 9. no wallet/order/stake side effects from any review
ok('9. reviews produced ZERO wallet/order/stake rows', sideEffectN() === 0)

// ══════ Part B: route (ROOT + 真人 Passkey 门) ══════
const { consumeGateToken } = createHumanPresence(db, <T,>(_k: string, fb: T): T => fb)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root','root1')").run()  // root1 有 Passkey;rootNoPk 没有
let ac = 0
const logAdminAction = (adminId: string, action: string, tt: string | null, tid: string | null, detail?: Record<string, unknown>): void => {
  db.prepare("INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)").run('au_' + (++ac), adminId, action, tt, tid, detail ? JSON.stringify(detail) : null)
}
const app = express(); app.use(express.json())
registerAdminDirectReceiveDepositsRoutes(app, {
  db,
  requireRootAdmin: (req: Request, res: Response) => { if (req.headers['x-root'] !== '1') { res.status(403).json({ error: 'root only' }); return null } return { id: req.headers['x-uid'] as string, role: 'admin' } },
  consumeGateToken,
  logAdminAction,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
function call(flagId: string, body: Record<string, unknown>, h: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...h }
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/admin/direct-receive/aml-flags/${flagId}/review`, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } })
    })
    rq.on('error', reject); rq.write(payload); rq.end()
  })
}

mkFlag('f_route', 's_route', 'high', 'open')
// 8a. 非 ROOT → 403,flag 不变
const r8a = await call('f_route', { decision: 'clear' })
ok('8a. non-root → 403, flag unchanged', r8a.status === 403 && flagRow('f_route').status === 'open')
// 8b. ROOT 但无 Passkey(rootNoPk)→ 403 PASSKEY_REQUIRED,gate-fail 审计,flag 不变
const auditBefore8b = auditN()
const r8b = await call('f_route', { decision: 'clear' }, { 'x-root': '1', 'x-uid': 'rootNoPk' })
ok('8b. root w/o Passkey → 403 PASSKEY_REQUIRED_FOR_DIRECT_PAY', r8b.status === 403 && r8b.json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', JSON.stringify(r8b))
ok('8b-2. gate failure audited, flag still unchanged', auditN() === auditBefore8b + 1 && flagRow('f_route').status === 'open')
// 8c. ROOT + Passkey + 无 token → 403 HUMAN_PRESENCE_REQUIRED,flag 不变
const r8c = await call('f_route', { decision: 'clear' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('8c. root + Passkey but no token → 403 HUMAN_PRESENCE_REQUIRED', r8c.status === 403 && r8c.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r8c))
ok('8c-2. flag still unchanged after missing-token', flagRow('f_route').status === 'open')
// 8d. ROOT + Passkey + 有效 purpose-bound token → 200,flag 复核为 cleared(端到端)
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tok1','root1','direct_pay_aml_review',?,datetime('now','+60 seconds'))").run(JSON.stringify({ flag_id: 'f_route', decision: 'clear' }))
const r8d = await call('f_route', { decision: 'clear', webauthn_token: 'tok1', notes: 'ok' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('8d. root + Passkey + valid token → 200, flag cleared (end-to-end)', r8d.status === 200 && r8d.json?.ok === true && flagRow('f_route').status === 'cleared' && flagRow('f_route').reviewed_by === 'root1', JSON.stringify(r8d))
// 8e. token 一次性:同 token 再用 → 403(已消费)
const r8e = await call('f_route', { decision: 'clear', webauthn_token: 'tok1' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('8e. gate token single-use → reused token rejected 403', r8e.status === 403, JSON.stringify(r8e))

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-aml-review tests passed`)
