#!/usr/bin/env tsx
/**
 * RFC-020 PR-C2a — delegation grant verifier + opt-in safe-scope enforcement.
 *   用法:npm run test:agent-grant-verify
 *
 * Proves the consumption foundation is safe and explicitly opt-in:
 *   1. valid safe grant + required scope → passes (grant principal, not a session)
 *   2. missing token → fails
 *   3. revoked / expired / inactive grant → fails
 *   4. wrong safe scope → fails
 *   5. risk / never-delegable / unknown required scope → can never pass
 *   6. ordinary human api_key auth is unchanged (works on a human route, rejected on grant route)
 *   7. a human-auth (money/order-style) route does NOT accept a gtk_* grant token
 *   + every attempt is audited (allow/deny).
 * No money/order/wallet code touched; the grant route is a brand-new read-only slice.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-grantverify-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { verifyGrantToken } = await import('../src/runtime/agent-grant-verifier.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase()
setSeamDb(db)

// Realistic human auth: Authorization: Bearer <api_key> → users lookup (mirrors real auth()'s key path).
const auth = (req: express.Request, res: express.Response) => {
  const tok = (req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  const u = tok ? db.prepare('SELECT * FROM users WHERE api_key = ?').get(tok) as Record<string, unknown> | undefined : undefined
  if (!u) { res.status(401).json({ error: 'unauthorized' }); return null }
  return u
}

const app = express()
app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
// stub "money/order-style" route guarded by ordinary human auth — must NOT accept grant tokens
app.get('/api/_test/human-only', (req, res) => { const u = auth(req, res); if (!u) return; res.json({ ok: true, user_id: u.id }) })
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const j = async (path: string, bearer?: string) => {
  const r = await fetch(base + path, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })
  return { status: r.status, body: await r.json().catch(() => ({})) as any }
}

// fixtures
const human = generateId('usr')
db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(human, 'Alice', 'buyer', 'key_human')
const future = new Date(Date.now() + 3600_000).toISOString()
const past = new Date(Date.now() - 1000).toISOString()
const mkGrant = (token: string, caps: string[], status = 'active', exp = future): string => {
  const gid = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(gid, human, 'AgentX', JSON.stringify(caps.map(c => ({ capability: c, constraints: {} }))), sha(token), status, exp)
  return gid
}

try {
  const okGid = mkGrant('gtk_ok', ['read_public', 'search'])
  mkGrant('gtk_revoked', ['read_public'], 'revoked')
  mkGrant('gtk_expired', ['read_public'], 'active', past)
  mkGrant('gtk_wrongscope', ['search'])   // no read_public

  // 1) valid safe grant + required scope passes
  const r1 = await j('/api/agent-grants/whoami', 'gtk_ok')
  ok('1 valid safe grant passes', r1.status === 200 && r1.body.grant?.grant_id === okGid && r1.body.grant?.capability === 'read_public')
  ok('1 principal carries human_id (accountable human), not a session', r1.body.grant?.human_id === human && !('api_key' in (r1.body.grant || {})))

  // 2) missing token
  ok('2 missing token → 401 GRANT_TOKEN_REQUIRED', (await j('/api/agent-grants/whoami')).body.error_code === 'GRANT_TOKEN_REQUIRED')

  // 3) revoked / expired / inactive
  ok('3a revoked grant → 403 GRANT_INACTIVE', (await j('/api/agent-grants/whoami', 'gtk_revoked')).body.error_code === 'GRANT_INACTIVE')
  ok('3b expired grant → 403 GRANT_INACTIVE', (await j('/api/agent-grants/whoami', 'gtk_expired')).body.error_code === 'GRANT_INACTIVE')
  ok('3c unknown token → 401 GRANT_NOT_FOUND', (await j('/api/agent-grants/whoami', 'gtk_nope')).body.error_code === 'GRANT_NOT_FOUND')

  // 4) wrong safe scope
  ok('4 grant without required scope → 403 SCOPE_NOT_GRANTED', (await j('/api/agent-grants/whoami', 'gtk_wrongscope')).body.error_code === 'SCOPE_NOT_GRANTED')

  // 5) risk / never / unknown required scope can never pass (verifier unit)
  ok('5a risk required scope → SCOPE_NOT_SAFE', (await verifyGrantToken('gtk_ok', 'place_order')).ok === false)
  ok('5b never-delegable required scope → SCOPE_NOT_SAFE', !(await verifyGrantToken('gtk_ok', 'withdraw')).ok)
  ok('5c unknown required scope → SCOPE_NOT_SAFE', !(await verifyGrantToken('gtk_ok', 'bogus_scope')).ok)
  const riskRes = await verifyGrantToken('gtk_ok', 'wallet') as { error_code?: string }
  ok('5d risk scope rejection is typed SCOPE_NOT_SAFE', riskRes.error_code === 'SCOPE_NOT_SAFE')

  // 6) ordinary human auth unchanged
  ok('6a human api_key works on human route', (await j('/api/_test/human-only', 'key_human')).status === 200)
  ok('6b human api_key CANNOT use a grant route (not gtk_)', (await j('/api/agent-grants/whoami', 'key_human')).body.error_code === 'GRANT_TOKEN_REQUIRED')

  // 7) human-auth (money/order-style) route does NOT accept a grant token
  ok('7 grant token rejected by ordinary human route', (await j('/api/_test/human-only', 'gtk_ok')).status === 401)

  // audit: allow + deny rows recorded
  const allow = (db.prepare("SELECT COUNT(*) n FROM agent_grant_auth_log WHERE outcome='allow'").get() as { n: number }).n
  const deny = (db.prepare("SELECT COUNT(*) n FROM agent_grant_auth_log WHERE outcome='deny'").get() as { n: number }).n
  ok('audit logged an allow', allow >= 1)
  ok('audit logged denies', deny >= 4)

  if (fail === 0) {
    console.log(`\n✅ grant verifier (PR-C2a): opt-in safe-scope enforcement; grant tokens are NOT global auth; risk/never hard-rejected; human auth unchanged; audited\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ grant verifier FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  rmSync(tmpHome, { recursive: true, force: true })
}
