#!/usr/bin/env tsx
/**
 * 角色切换守卫(梦想者1号被卡案)—— 真 express + 真路由。
 *   铁律不变量:admin/verifier 不得切到交易面(buyer/seller);
 *   修复不变量:受信/治理身份【之间】可切(verifier→arbitrator 曾被误拦 → 切到审核员即永久卡死)。
 *   + 静态锚:治理上岗不再把 arbitrator 写进 users.roles(资格=白名单,非角色);前端 chip 过滤与服务端同谓词。
 * Usage: npm run test:role-switch-guard
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'rsg-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerProfileIdentityRoutes } = await import('../src/pwa/routes/profile-identity.js')
const { registerGovernanceOnboardingRoutes } = await import('../src/pwa/routes/governance-onboarding.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db); initDisputeSchema(db)
db.exec(`CREATE TABLE IF NOT EXISTS governance_applications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, consent_hash TEXT, passkey_sig TEXT, iron_rule_method TEXT, quiz_score INTEGER, case_review_text TEXT, cooldown_until INTEGER, appeal_reason TEXT, appeal_resolution TEXT, ip_hash TEXT, ua_hash TEXT, source_application_id TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`)
const U = (id: string, role: string, roles: string[]): void => {
  db.prepare("INSERT INTO users (id,name,role,roles,api_key) VALUES (?,?,?,?,?)").run(id, id, role, JSON.stringify(roles), 'k_' + id)
}
U('dreamer', 'verifier', ['buyer', 'verifier', 'arbitrator'])   // 梦想者1号形态:治理双岗 + 遗留 arbitrator 角色
U('trader', 'buyer', ['buyer', 'seller'])
U('pureadm', 'admin', ['admin'])
U('wlarb', 'buyer', ['buyer'])   // #249 之后的新形态:白名单资格,roles 无 arbitrator
db.prepare("INSERT INTO arbitrator_whitelist (user_id, status, note) VALUES ('wlarb','active','test')").run()
db.prepare("INSERT INTO governance_applications (id,user_id,role,action,status) VALUES ('ga1','wlarb','arbitrator','activate','active')").run()

const safeRoles = (u: Record<string, unknown> | undefined | null): string[] => { try { const p = JSON.parse((u?.roles as string) || '[]'); return Array.isArray(p) ? p : [] } catch { return [] } }
const app = express(); app.use(express.json())
let n = 0
const authStub = (req: Request, res: Response): Record<string, unknown> | null => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null }; return db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> }
registerProfileIdentityRoutes(app, { db, generateId: (p: string) => `${p}_${++n}`, auth: authStub, safeRoles } as never)
registerGovernanceOnboardingRoutes(app, {
  db, generateId: (p: string) => `${p}_${++n}`, auth: authStub,
  errorRes: (res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, code }),
  checkArbitratorEligibility: () => ({ eligible: true, items: [] }), checkVerifierEligibility: () => ({ eligible: true, items: [] }),
  consumeGateToken: () => ({ ok: true }),
  getProtocolParam: (<T,>(k: string, fb: T): T => (k === 'require_human_presence_for_governance_resign' ? 0 : fb) as T),
  requireGovernanceAdmin: () => null, logAdminAction: () => {},
} as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const post = (path: string, body: Record<string, unknown>, uid: string): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-test-uid': uid } }, res => { let dt = ''; res.on('data', c => dt += c); res.on('end', () => resolve({ status: res.statusCode || 0, json: dt ? JSON.parse(dt) : {} })) })
  rq.on('error', reject); rq.write(payload); rq.end()
})
const roleOf = (id: string): string => (db.prepare('SELECT role FROM users WHERE id=?').get(id) as { role: string }).role

try {
  // ── ① 铁律面:锁交易目标 ──
  ok('1a. verifier-holder CANNOT switch to buyer', !!(await post('/api/profile/switch-role', { role: 'buyer' }, 'dreamer')).json.error && roleOf('dreamer') === 'verifier')
  ok('1b. verifier-holder CANNOT switch to seller (not held anyway, but locked path first)', !!(await post('/api/profile/switch-role', { role: 'seller' }, 'dreamer')).json.error)
  ok('1c. verifier-holder CANNOT self-serve add buyer/seller', !!(await post('/api/profile/add-role', { role: 'seller' }, 'dreamer')).json.error)

  // ── ② 修复面:受信/治理身份之间可切(此前被误拦 → 永久卡死在审核员) ──
  const r2 = await post('/api/profile/switch-role', { role: 'arbitrator' }, 'dreamer')
  ok('2a. verifier → arbitrator ALLOWED (was wedged before)', r2.json.success === true && roleOf('dreamer') === 'arbitrator', JSON.stringify(r2.json))
  const r2b = await post('/api/profile/switch-role', { role: 'verifier' }, 'dreamer')
  ok('2b. arbitrator → verifier allowed back', r2b.json.success === true && roleOf('dreamer') === 'verifier')

  // ── ③ 普通用户不受影响 ──
  ok('3a. buyer → seller normal switch', (await post('/api/profile/switch-role', { role: 'seller' }, 'trader')).json.success === true && roleOf('trader') === 'seller')
  ok('3b. switch to a role not held rejected', !!(await post('/api/profile/switch-role', { role: 'logistics' }, 'trader')).json.error)
  ok('3c. admin still cannot switch to buyer', !!(await post('/api/profile/switch-role', { role: 'buyer' }, 'pureadm')).json.error)

  // ── ③b #249-P2:白名单仲裁员可自助卸任(resign 真源=whitelist,不再只看 roles) ──
  {
    const r = await post('/api/governance/onboarding/resign', { role: 'arbitrator', confirm_text: 'RESIGN arbitrator' }, 'wlarb')
    ok('3d. whitelist-only arbitrator CAN self-resign (was 404 NOT_ACTIVE before)', r.status === 200 || r.json.success === true, JSON.stringify(r.json))
    const wl = db.prepare("SELECT status FROM arbitrator_whitelist WHERE user_id='wlarb'").get() as { status: string }
    ok('3e. resign suspends the whitelist (reversible; NOT terminal revoke)', wl.status === 'suspended')
    ok('3f. buyer identity untouched by arbitrator resign', (db.prepare("SELECT roles FROM users WHERE id='wlarb'").get() as { roles: string }).roles === JSON.stringify(['buyer']))
    ok('3g. governance active rows closed', !db.prepare("SELECT 1 FROM governance_applications WHERE user_id='wlarb' AND role='arbitrator' AND status='active'").get())
    const r2 = await post('/api/governance/onboarding/resign', { role: 'arbitrator', confirm_text: 'RESIGN arbitrator' }, 'trader')
    ok('3h. non-arbitrator resign still 404 NOT_ACTIVE', r2.status === 404)
  }

  // ── ④ 静态:治理上岗不再造"仲裁员角色";前端 chip 过滤与服务端同谓词 ──
  const GOV = readFileSync('src/pwa/routes/governance-onboarding.ts', 'utf8')
  ok('4a. governance activate skips roles-push for arbitrator (whitelist is the authority, granted in the same tx)',
    /role !== 'arbitrator' && !roles\.includes\(role\)/.test(GOV) && /grantArbitratorTx\(db, \{ userId: app_\.user_id/.test(GOV))
  const ACC = readFileSync('src/pwa/public/app-account.js', 'utf8')
  ok('4b. role-chip filter locks only admin/verifier (arbitrator/logistics keep their buyer/seller chips)',
    /const identityLocked = \['admin', 'verifier'\]\.includes\(data\.role\) \|\| roles\.some\(r => \['admin', 'verifier'\]\.includes\(r\)\)/.test(ACC)
    && /const visibleRoles = identityLocked \?/.test(ACC))
  const PI = readFileSync('src/pwa/routes/profile-identity.ts', 'utf8')
  ok('4c. server guard blocks only trading targets', /ROLE_LOCKED_ROLES\.includes\(r\)\) && \['buyer', 'seller'\]\.includes\(role\)/.test(PI))
  ok('4d. resign truth source forks: arbitrator=whitelist(suspend), verifier=roles', /isActiveWhitelistArbitrator\(db, userId\)/.test(GOV) && /suspendArbitrator\(db, \{ userId, note: '主动卸任/.test(GOV))
  ok('4e. settings hides 申请仲裁员 for whitelisted arbitrators + shows capability badge', /r === 'arbitrator' && state\.canArbitrate/.test(ACC) && /仲裁员资格\(白名单\)/.test(ACC))
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ role-switch-guard FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ role switch guard: trading targets stay locked for admin/verifier + trusted↔trusted unwedged (dreamer case) + arbitrator is a whitelist capability not a role\n  ✅ pass ${pass}`)
