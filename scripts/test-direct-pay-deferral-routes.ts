#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 缓交(deferred base-bond)ROUTES 测试。
 * 验:
 *  - 卖家 apply(POST /api/direct-receive/deferral):需登录 + seller 角色;创建 pending;单一活跃(重复 → 400)。
 *    apply【不】需 Passkey(只建 pending,不授予资格;授予门在 admin 审批侧)。
 *  - 卖家 status(GET /api/direct-receive/deferral):返回最新申请 + 是否生效(active),脱敏(不含 admin 身份)。
 *  - admin list(GET /api/admin/direct-receive/deferrals):ROOT only;非法 status → 400。
 *  - admin approve/reject:ROOT + 真人 Passkey(铁律)。无 Passkey 凭证(agent)硬拒;无 token → HUMAN_PRESENCE_REQUIRED;
 *    purpose_data 绑完整条款(deferral_id+factor+grace),签 A 用 B 拒;token 单次使用;gate 失败也审计。
 *    批准后卖家 status 变 granted + active(reduced_quota_factor 压低)。授予绝不自动发生。
 * Usage: npm run test:direct-pay-deferral-routes
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-dfr-routes-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
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
for (const u of ['seller1', 'seller2', 'seller_b', 'seller_c', 'buyer1', 'root1', 'root_nopk']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_root','root1')").run()   // root1 有 Passkey;root_nopk 无(模拟 agent)

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
const auditCount = (action: string): number => (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action=?").get(action) as any).n

// ══════ 1. seller apply ══════
ok('1. apply requires auth → 401', (await req('POST', '/api/direct-receive/deferral', { reason: 'x' })).status === 401)
ok('1a. non-seller (buyer) apply → 403 SELLER_ONLY', (await req('POST', '/api/direct-receive/deferral', { reason: 'x' }, { 'x-uid': 'buyer1', 'x-role': 'buyer' })).json?.error_code === 'SELLER_ONLY')
// seller1 has NO Passkey credential → apply MUST still succeed (apply is not Passkey-gated; it grants nothing)
const a1 = await req('POST', '/api/direct-receive/deferral', { reason: '新店,先上架后补保证金', period_days: 30 }, { 'x-uid': 'seller1' })
ok('1b. seller apply (no Passkey) → 200 status=pending', a1.status === 200 && a1.json?.ok === true && a1.json?.status === 'pending', JSON.stringify(a1.json))
ok('1c. duplicate active apply → 400 DEFERRAL_REQUEST_REJECTED', (await req('POST', '/api/direct-receive/deferral', {}, { 'x-uid': 'seller1' })).json?.error_code === 'DEFERRAL_REQUEST_REJECTED')

// ══════ 2. seller status ══════
const s1 = await req('GET', '/api/direct-receive/deferral', null, { 'x-uid': 'seller1' })
ok('2. seller status → pending deferral, active=null', s1.json?.deferral?.status === 'pending' && s1.json?.active === null, JSON.stringify(s1.json))
ok('2a. seller status leaks NO admin identity (approved_by/admin)', !/approved_by|admin/i.test(s1.raw))

// ══════ 3. admin list ══════
ok('3. admin list non-root → 403', (await req('GET', '/api/admin/direct-receive/deferrals', null, { 'x-uid': 'seller1' })).status === 403)
ok('3a. admin list bad status → 400 BAD_STATUS', (await req('GET', '/api/admin/direct-receive/deferrals?status=bogus', null, { 'x-root': '1', 'x-uid': 'root1' })).json?.error_code === 'BAD_STATUS')
const list = await req('GET', '/api/admin/direct-receive/deferrals?status=pending', null, { 'x-root': '1', 'x-uid': 'root1' })
const dfrId: string = list.json?.deferrals?.[0]?.id
ok('3b. admin list pending → seller1 row present', list.status === 200 && list.json?.deferrals?.some((d: any) => d.user_id === 'seller1' && d.status === 'pending') && !!dfrId, JSON.stringify(list.json).slice(0, 160))

// ══════ 4. admin approve — ROOT + Passkey iron-rule ══════
ok('4. approve non-root → 403', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/approve`, { reduced_quota_factor: 0.5, grace_days: 7 }, { 'x-uid': 'seller1' })).status === 403)
// agent hard-reject: ROOT identity WITHOUT a Passkey credential → PASSKEY_REQUIRED (before any token check)
const apk = await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/approve`, { reduced_quota_factor: 0.5, grace_days: 7 }, { 'x-root': '1', 'x-uid': 'root_nopk' })
ok('4a. ROOT w/o Passkey credential (agent) → 403 PASSKEY_REQUIRED_FOR_DIRECT_PAY', apk.status === 403 && apk.json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', JSON.stringify(apk.json))
// ROOT with Passkey but no gate token → HUMAN_PRESENCE_REQUIRED
const anotok = await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/approve`, { reduced_quota_factor: 0.5, grace_days: 7 }, { 'x-root': '1', 'x-uid': 'root1' })
ok('4b. ROOT + Passkey, no token → 403 HUMAN_PRESENCE_REQUIRED', anotok.status === 403 && anotok.json?.error_code === 'HUMAN_PRESENCE_REQUIRED')
const failAuditsBefore = auditCount('direct_pay.deferral_approve')
ok('4c. approve gate-failures audited', failAuditsBefore >= 2)
// purpose_data MISMATCH: token bound to factor 0.9 but request asks 0.5 → token validate fails → 403
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_bad','root1','direct_pay_deferral_approve',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfrId, reduced_quota_factor: 0.9, grace_days: 7 }))
ok('4d. token bound to different terms (factor 0.9 vs req 0.5) → 403', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/approve`, { reduced_quota_factor: 0.5, grace_days: 7, webauthn_token: 'tk_bad' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)
// valid token bound to exact terms → 200 granted
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_ok','root1','direct_pay_deferral_approve',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfrId, reduced_quota_factor: 0.5, grace_days: 7 }))
const aok = await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/approve`, { reduced_quota_factor: 0.5, grace_days: 7, webauthn_token: 'tk_ok' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('4e. ROOT + valid purpose-bound token → 200 granted', aok.status === 200 && aok.json?.ok === true && aok.json?.status === 'granted', JSON.stringify(aok.json))
ok('4f. approve success audited (ok=true granted)', (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.deferral_approve' AND detail LIKE '%granted%'").get() as any).n >= 1)
ok('4g. token single-use (reuse → 403)', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/approve`, { reduced_quota_factor: 0.5, grace_days: 7, webauthn_token: 'tk_ok' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)

// ══════ 5. seller sees granted + active after approval ══════
const s2 = await req('GET', '/api/direct-receive/deferral', null, { 'x-uid': 'seller1' })
ok('5. seller status now granted + active (reduced factor 0.5)', s2.json?.deferral?.status === 'granted' && s2.json?.active?.reduced_quota_factor === 0.5 && !!s2.json?.active?.expires_at, JSON.stringify(s2.json))
ok('5a. seller status still leaks no admin identity', !/approved_by|admin/i.test(s2.raw))

// ══════ 5b. admin adjust-quota — ROOT + Passkey,只 granted 可调,purpose_data 绑 deferral_id+factor ══════
ok('5b. adjust non-root → 403', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, { reduced_quota_factor: 0.9 }, { 'x-uid': 'seller1' })).status === 403)
ok('5c. adjust ROOT no token → 403 (human presence required)', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, { reduced_quota_factor: 0.9 }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)
ok('5d. adjust missing factor → 400', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, {}, { 'x-root': '1', 'x-uid': 'root1' })).json?.error_code === 'INVALID_QUOTA_FACTOR')
// token bound to 0.8 but request 0.9 → purpose_data validate fail → 403
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_adjbad','root1','direct_pay_deferral_adjust',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfrId, reduced_quota_factor: 0.8 }))
ok('5e. adjust token bound to different factor (0.8 vs 0.9) → 403', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, { reduced_quota_factor: 0.9, webauthn_token: 'tk_adjbad' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_adjok','root1','direct_pay_deferral_adjust',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfrId, reduced_quota_factor: 0.9 }))
const adjok = await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, { reduced_quota_factor: 0.9, webauthn_token: 'tk_adjok' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('5f. adjust success → 200 factor 0.5→0.9 (previous/new 回传)', adjok.status === 200 && adjok.json?.new_factor === 0.9 && adjok.json?.previous_factor === 0.5, JSON.stringify(adjok.json))
ok('5g. adjust success audited', (db.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='direct_pay.deferral_adjust_quota' AND detail LIKE '%factor%'").get() as any).n >= 1)
ok('5h. adjust token single-use (reuse → 403)', (await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, { reduced_quota_factor: 0.9, webauthn_token: 'tk_adjok' }, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)
// 5i. audit fail-closed:注入 audit 写失败(RAISE trigger)→ 配额 UPDATE 与 audit INSERT 同事务 → 整体回滚,factor 不变 + 500
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_adjfc','root1','direct_pay_deferral_adjust',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfrId, reduced_quota_factor: 0.7 }))
db.exec("CREATE TRIGGER _audit_boom BEFORE INSERT ON admin_audit_log WHEN NEW.action='direct_pay.deferral_adjust_quota' BEGIN SELECT RAISE(ABORT,'boom'); END")
const fBefore = (db.prepare("SELECT reduced_quota_factor f FROM direct_receive_deferrals WHERE id=?").get(dfrId) as { f: number }).f
const adjfc = await req('POST', `/api/admin/direct-receive/deferrals/${dfrId}/adjust-quota`, { reduced_quota_factor: 0.7, webauthn_token: 'tk_adjfc' }, { 'x-root': '1', 'x-uid': 'root1' })
db.exec("DROP TRIGGER _audit_boom")
ok('5i. audit fail-closed → 500 AUDIT_WRITE_FAILED + factor 回滚(不变)', adjfc.status >= 500 && adjfc.json?.error_code === 'AUDIT_WRITE_FAILED' && (db.prepare("SELECT reduced_quota_factor f FROM direct_receive_deferrals WHERE id=?").get(dfrId) as { f: number }).f === fBefore)

// ══════ 6. admin reject (fresh seller2 application) ══════
await req('POST', '/api/direct-receive/deferral', { reason: 'x' }, { 'x-uid': 'seller2' })
const list2 = await req('GET', '/api/admin/direct-receive/deferrals?status=pending', null, { 'x-root': '1', 'x-uid': 'root1' })
const dfr2: string = list2.json?.deferrals?.find((d: any) => d.user_id === 'seller2')?.id
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_rej','root1','direct_pay_deferral_reject',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfr2 }))
const rej = await req('POST', `/api/admin/direct-receive/deferrals/${dfr2}/reject`, { webauthn_token: 'tk_rej' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('6. ROOT + valid token reject → 200 rejected', rej.status === 200 && rej.json?.status === 'rejected', JSON.stringify(rej.json))
ok('6a. reject without token → 403', (await req('POST', `/api/admin/direct-receive/deferrals/${dfr2}/reject`, {}, { 'x-root': '1', 'x-uid': 'root1' })).status === 403)

// ══════ 7. P2-1 boundary: huge period rejected at apply; huge grace → 409 (not 500) at approve ══════
ok('7. apply huge period_days → 400 (rejected at request, no oversized pending)', (await req('POST', '/api/direct-receive/deferral', { period_days: 100000000000 }, { 'x-uid': 'seller_b' })).json?.error_code === 'DEFERRAL_REQUEST_REJECTED')
// fresh seller applies normally, admin approve with huge grace_days → 409 DEFERRAL_APPROVE_REJECTED (NOT a 500)
await req('POST', '/api/direct-receive/deferral', { reason: 'x' }, { 'x-uid': 'seller_c' })
const lc = await req('GET', '/api/admin/direct-receive/deferrals?status=pending', null, { 'x-root': '1', 'x-uid': 'root1' })
const dfrC: string = lc.json?.deferrals?.find((d: any) => d.user_id === 'seller_c')?.id
db.prepare("INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES ('tk_hg','root1','direct_pay_deferral_approve',?,datetime('now','+60 seconds'))").run(JSON.stringify({ deferral_id: dfrC, reduced_quota_factor: 0.5, grace_days: 100000000000 }))
const hg = await req('POST', `/api/admin/direct-receive/deferrals/${dfrC}/approve`, { reduced_quota_factor: 0.5, grace_days: 100000000000, webauthn_token: 'tk_hg' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('7a. approve huge grace_days → 409 DEFERRAL_APPROVE_REJECTED, not 500', hg.status === 409 && hg.json?.error_code === 'DEFERRAL_APPROVE_REJECTED', `status=${hg.status} ${JSON.stringify(hg.json)}`)

// ══════ N. seller my-fee-account (PR-C) ══════
ok('N1. my-fee-account requires auth → 401', (await req('GET', '/api/direct-receive/my-fee-account', null)).status === 401)
ok('N2. non-seller (buyer) → 403 SELLER_ONLY', (await req('GET', '/api/direct-receive/my-fee-account', null, { 'x-uid': 'buyer1', 'x-role': 'buyer' })).json?.error_code === 'SELLER_ONLY')
const mfa0 = await req('GET', '/api/direct-receive/my-fee-account', null, { 'x-uid': 'seller_c' })
ok('N3. seller reads own account → 200 + available 0 (no activity)', mfa0.status === 200 && mfa0.json?.account?.availableUnits === 0, JSON.stringify(mfa0.json))
// admin records a 50 USDC prepay for seller_c (Passkey), then seller sees it (end-to-end PR-A→PR-C)
db.prepare("INSERT INTO webauthn_gate_tokens (id,user_id,purpose,purpose_data,expires_at) VALUES ('tkc','root1','direct_pay_fee_prepay_record',?,datetime('now','+60 seconds'))").run(JSON.stringify({ seller_id: 'seller_c', amount_units: 50000000, method: 'usdc', evidence_ref: '' }))
const tp = await req('POST', '/api/admin/direct-receive/fee-prepay', { seller_id: 'seller_c', amount_units: 50000000, method: 'usdc', webauthn_token: 'tkc' }, { 'x-root': '1', 'x-uid': 'root1' })
ok('N4. admin prepay 50 USDC → 200', tp.status === 200, JSON.stringify(tp.json))
const mfa1 = await req('GET', '/api/direct-receive/my-fee-account', null, { 'x-uid': 'seller_c' })
ok('N5. seller_c now sees available 50 USDC', mfa1.json?.account?.availableUnits === 50000000, JSON.stringify(mfa1.json))
ok('N6. isolation: seller_b (no activity) still sees 0', (await req('GET', '/api/direct-receive/my-fee-account', null, { 'x-uid': 'seller_b' })).json?.account?.availableUnits === 0)

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-deferral-routes tests passed`)
