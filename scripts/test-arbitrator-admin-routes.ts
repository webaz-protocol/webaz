#!/usr/bin/env tsx
/**
 * PR-B 仲裁员管理路由 —— admin mutation 必须【现场真人 Passkey】+ 每次尝试写 admin_audit_log(含失败留痕)。
 * 真 express + 注入 deps。证明:非 admin 403;无 Passkey token → 412 + audit(ok:false);有 token → 200 + audit(ok:true);
 *   域规则(无 Passkey 目标 / revoked 终态)经路由如实透出;GET 名册 admin-only 只读(无需 Passkey)。
 * Usage: npm run test:arbitrator-admin-routes
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arb-route-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initArbitratorReviewSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { registerArbitratorRoutes } = await import('../src/pwa/routes/arbitrator.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF')
initSystemUser(db); initArbitratorReviewSchema(db); initWebauthnSchema(db)
const mkUser = (id: string, role = 'buyer', passkey = false): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  if (passkey) db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('cred_' + id, id, Buffer.from([1]))
}
mkUser('arb1', 'buyer', true); mkUser('nopk', 'buyer', false); mkUser('admin1', 'admin', true)

const audit: Array<{ action: string; target: string | null; detail?: Record<string, unknown> }> = []
const app = express(); app.use(express.json())
registerArbitratorRoutes(app, {
  db, generateId: (p: string) => `${p}_1`,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
  requireArbitrationAdmin: (req: Request, res: Response) => { const a = req.headers['x-test-admin'] as string | undefined; if (!a) { res.status(403).json({ error: 'not admin' }); return null } return { id: a, role: 'admin' } },
  checkArbitratorEligibility: () => ({ eligible: true, items: [] }), getArbitratorState: () => ({}),
  errorRes: (res: Response, status: number, code: string, msg: string) => { res.status(status).json({ error: msg, error_code: code }) },
  logAdminAction: (_adminId: string, action: string, _t: string | null, targetId: string | null, detail?: Record<string, unknown>) => { audit.push({ action, target: targetId, detail }) },
  consumeGateToken: (_uid: string, token: string | undefined, _purpose: string, _validate: (d: unknown) => boolean) => token ? { ok: true } : { ok: false, reason: '缺少 X-WebAuthn-Token' },
  ARB_STAKE_REQUIRED: 0, ARB_APP_REJECT_COOLDOWN_DAYS: 60,
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const call = (path: string, body: Record<string, unknown>, admin?: string, method = 'POST'): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-test-uid': 'admin1' }
  if (admin) headers['x-test-admin'] = admin
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})
const wlStatus = (id: string) => (db.prepare('SELECT status FROM arbitrator_whitelist WHERE user_id=?').get(id) as { status: string } | undefined)?.status
const auditFor = (action: string, target: string) => audit.filter(a => a.action === action && a.target === target)

try {
  // 非 admin → 403
  ok('non-admin cannot grant (403)', (await call('/api/admin/arbitrators/grant', { user_id: 'arb1', webauthn_token: 'x' })).status === 403)

  // ⑧ admin 无 Passkey token → 412 + audit(ok:false)
  const noTok = await call('/api/admin/arbitrators/grant', { user_id: 'arb1' }, 'admin1')
  ok('8a. admin grant WITHOUT Passkey → 412 HUMAN_PRESENCE_REQUIRED', noTok.status === 412 && noTok.json?.error_code === 'HUMAN_PRESENCE_REQUIRED')
  ok('8a-audit. failed-gate attempt is audited (ok:false)', auditFor('arbitrator.grant', 'arb1').some(a => a.detail?.ok === false))
  ok('8a. NOT granted (no whitelist row)', wlStatus('arb1') === undefined)

  // admin WITH token → 200 + audit(ok:true) + active
  const good = await call('/api/admin/arbitrators/grant', { user_id: 'arb1', webauthn_token: 'GOOD' }, 'admin1')
  ok('8b. admin grant WITH Passkey → 200', good.status === 200 && good.json?.success === true)
  ok('9. successful grant is audited (ok:true)', auditFor('arbitrator.grant', 'arb1').some(a => a.detail?.ok === true))
  ok('8b. arb1 whitelist now active', wlStatus('arb1') === 'active')

  // domain reject (no-passkey target) surfaces through route → 409 PASSKEY_REQUIRED + audited
  const npk = await call('/api/admin/arbitrators/grant', { user_id: 'nopk', webauthn_token: 'GOOD' }, 'admin1')
  ok('grant no-passkey target → 409 PASSKEY_REQUIRED', npk.status === 409 && npk.json?.error_code === 'PASSKEY_REQUIRED')
  ok('failed mutation still audited', auditFor('arbitrator.grant', 'nopk').some(a => a.detail?.ok === false))

  // suspend / reinstate with token
  ok('suspend arb1 → 200 + suspended', (await call('/api/admin/arbitrators/arb1/suspend', { webauthn_token: 'GOOD' }, 'admin1')).status === 200 && wlStatus('arb1') === 'suspended')
  ok('suspend WITHOUT Passkey → 412', (await call('/api/admin/arbitrators/arb1/reinstate', {}, 'admin1')).status === 412)
  ok('reinstate arb1 → 200 + active', (await call('/api/admin/arbitrators/arb1/reinstate', { webauthn_token: 'GOOD' }, 'admin1')).status === 200 && wlStatus('arb1') === 'active')

  // revoke → terminal: subsequent grant blocked through route
  ok('revoke arb1 → 200 + revoked', (await call('/api/admin/arbitrators/arb1/revoke', { webauthn_token: 'GOOD' }, 'admin1')).status === 200 && wlStatus('arb1') === 'revoked')
  const reGrant = await call('/api/admin/arbitrators/grant', { user_id: 'arb1', webauthn_token: 'GOOD' }, 'admin1')
  ok('revoked is terminal via route → 409 REVOKED_TERMINAL', reGrant.status === 409 && reGrant.json?.error_code === 'REVOKED_TERMINAL')

  // GET roster (admin-only, no Passkey)
  const roster = await call('/api/admin/arbitrators', {}, 'admin1', 'GET')
  ok('roster: admin-only read (no Passkey) → 200 + includes arb1 revoked', roster.status === 200 && Array.isArray(roster.json?.arbitrators) && roster.json.arbitrators.some((r: any) => r.user_id === 'arb1' && r.status === 'revoked'))
  ok('roster: non-admin → 403', (await call('/api/admin/arbitrators', {}, undefined, 'GET')).status === 403)

  server!.close()
  if (fail > 0) { console.error(`\n❌ arbitrator-admin-routes FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ arbitrator-admin-routes: ROOT/admin + live Passkey required + audit(incl. failures) + revoked-terminal + roster read\n  ✅ pass ${pass}`)
} catch (e) { console.error(e); server!.close(); process.exit(1) }
