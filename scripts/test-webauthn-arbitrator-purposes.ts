#!/usr/bin/env tsx
/**
 * PR-F 回归(可执行,非静态):arbitrator_grant/suspend/reinstate/revoke 四个 purpose 必须被
 *   /api/webauthn/auth/start 的 allowed 白名单接受 —— 否则仲裁员管理 UI 的 requestPasskeyGate 拿不到
 *   gate token,grant/suspend/reinstate/revoke 全部 400 'invalid purpose'(P1 阻断)。
 * 判定手法(黑盒,打真实 HTTP 路由):已登录但【未注册 Passkey】的用户打 auth/start:
 *   - purpose 被白名单接受 → 越过白名单,止于 403 '尚未注册任何 Passkey'(= NOT 'invalid purpose')。
 *   - purpose 未被接受    → 400 'invalid purpose'。
 * 故 403(no-passkey) 证明放行;400 invalid 证明拦截。对照:未知 purpose 必须 400(证明白名单真的在拦)。
 * Usage: npm run test:webauthn-arbitrator-purposes
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'wa-arb-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { registerWebauthnRoutes } = await import('../src/pwa/routes/webauthn.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initWebauthnSchema(db)
db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run('root1', 'root1', 'admin', 'k_root1')  // 已登录,未注册 Passkey

const app = express(); app.use(express.json())
registerWebauthnRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'admin', api_key: 'k_' + uid } },
  generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2)}`,
  rateLimitOk: () => true,
  rpId: 'localhost', rpName: 'WebAZ', origin: 'http://localhost',
  challengeTtlMs: 60000, gateTtlMs: 60000,
  invalidateAgentRiskCacheForUser: () => {},
  requireHumanPresence: () => ({ ok: true }),
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const start = (purpose: string, uid = 'root1'): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify({ purpose }); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/webauthn/auth/start', headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})

try {
  for (const p of ['arbitrator_grant', 'arbitrator_suspend', 'arbitrator_reinstate', 'arbitrator_revoke', 'arbitrate']) {
    const r = await start(p)
    ok(`purpose '${p}' accepted by allow-set (403 no-passkey, NOT 400 invalid purpose)`, r.status === 403 && r.json?.error === '尚未注册任何 Passkey', `status=${r.status} json=${JSON.stringify(r.json)}`)
  }
  const bogus = await start('arbitrator_bogus')  // 对照:白名单真的在拦(否则恒放行,上面 4 条假绿)
  ok(`unknown purpose 'arbitrator_bogus' → 400 'invalid purpose' (allow-set actually gates)`, bogus.status === 400 && bogus.json?.error === 'invalid purpose', `status=${bogus.status} json=${JSON.stringify(bogus.json)}`)
  const noauth = await start('arbitrator_grant', '')  // 对照:auth 门在 purpose 门之前
  ok('unauthenticated → 401 (auth gate precedes purpose gate)', noauth.status === 401, `status=${noauth.status}`)
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ webauthn-arbitrator-purposes FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ webauthn-arbitrator-purposes: 4 arbitrator_* purposes accepted by /auth/start allow-set (executable HTTP, not static grep)\n  ✅ pass ${pass}`)
