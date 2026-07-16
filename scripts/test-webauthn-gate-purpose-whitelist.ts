#!/usr/bin/env tsx
/**
 * 类别级回归(RFC-025 前置审计 Codex 发现的真实缺陷 → 修类别不修实例):
 *   凡源码里【任何地方】以字面量消费的 gate purpose(requireHumanPresence(uid,'X',…) /
 *   consumeGateToken(uid,token,'X',…)),都必须被 /api/webauthn/auth/start 的 allowed 白名单接受 ——
 *   否则该 purpose 的 Passkey 仪式对真人不可达(铸不出 gate token),功能整条断掉(fail-closed 但坏)。
 *   本轮修复的实例:'vote'(claim-verify.ts 验证者投票)与 'agent_revoke'(agent-governance.ts)。
 *
 * 手法 = 静态提取 + 可执行黑盒(沿用 test-webauthn-arbitrator-purposes 的判定法):
 *   已登录但未注册 Passkey 的用户打 auth/start:
 *     - purpose 被白名单接受 → 越过白名单,止于 403 '尚未注册任何 Passkey'(NOT 400)。
 *     - purpose 未被接受    → 400 'invalid purpose'。
 *   静态提取只捕字面量(经变量传递的 purpose 捕不到,如 directPay 的 gate helper —— 它们的 purpose
 *   常量已在白名单;若未来出现变量传递的新 purpose,请手动加入 EXTRA_PURPOSES)。
 * Usage: npm run test:webauthn-purpose-whitelist
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'wa-pwl-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { registerWebauthnRoutes } = await import('../src/pwa/routes/webauthn.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── 静态提取:全 src/ 里以字面量消费的 gate purposes ──
const EXTRA_PURPOSES: string[] = []  // 经变量传递、静态捕不到但确在消费的 purpose(目前无)
function walk(dir: string, out: string[]): void {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { if (!/node_modules|dist|\.git/.test(f)) walk(p, out) }
    else if (f.endsWith('.ts')) out.push(p)
  }
}
const files: string[] = []; walk('src', files)
const consumed = new Set<string>(EXTRA_PURPOSES)
const RX = [
  /requireHumanPresence\(\s*[^,)]+,\s*'([a-z_][a-z0-9_-]*)'/g,
  /consumeGateToken\(\s*[^,)]+,\s*[^,)]+,\s*'([a-z_][a-z0-9_-]*)'/g,
]
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const rx of RX) for (const m of src.matchAll(rx)) consumed.add(m[1])
}
ok('static scan finds a non-trivial purpose set (sanity)', consumed.size >= 5, `found: ${[...consumed].join(', ')}`)
ok("static scan captured the two round-1 defect purposes ('vote' / 'agent_revoke') — extraction not blind", consumed.has('vote') && consumed.has('agent_revoke'), `found: ${[...consumed].join(', ')}`)

// ── 可执行黑盒:每个被消费的 purpose 都必须被 auth/start 放行 ──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initWebauthnSchema(db)
db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run('u1', 'u1', 'buyer', 'k_u1')  // 已登录,未注册 Passkey

const app = express(); app.use(express.json())
registerWebauthnRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer', api_key: 'k_' + uid } },
  generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2)}`,
  rateLimitOk: () => true,
  rpId: 'localhost', rpName: 'WebAZ', origin: 'http://localhost',
  challengeTtlMs: 60000, gateTtlMs: 60000,
  invalidateAgentRiskCacheForUser: () => {},
  requireHumanPresence: () => ({ ok: true }),
} as any)

let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const start = (purpose: string, uid = 'u1'): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify({ purpose }); const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/webauthn/auth/start', headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : null }) } catch { resolve({ status: res.statusCode || 0, json: d }) } }) })
  rq.on('error', reject); rq.write(payload); rq.end()
})

try {
  for (const p of [...consumed].sort()) {
    const r = await start(p)
    ok(`consumed purpose '${p}' accepted by /auth/start allow-set (403 no-passkey, NOT 400 invalid)`, r.status === 403 && r.json?.error === '尚未注册任何 Passkey', `status=${r.status} json=${JSON.stringify(r.json)}`)
  }
  const bogus = await start('purpose_bogus_zz')  // 对照:白名单真的在拦(否则全部假绿)
  ok("unknown purpose → 400 'invalid purpose' (allow-set actually gates)", bogus.status === 400 && bogus.json?.error === 'invalid purpose', `status=${bogus.status} json=${JSON.stringify(bogus.json)}`)
  const noauth = await start('vote', '')
  ok('unauthenticated → 401 (auth gate precedes purpose gate)', noauth.status === 401, `status=${noauth.status}`)
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ webauthn-gate-purpose-whitelist FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ webauthn-gate-purpose-whitelist: every literal-consumed gate purpose (${consumed.size}) is accepted by /auth/start (category-level; executable HTTP, not static-only)\n  ✅ pass ${pass}`)
