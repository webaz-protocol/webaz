#!/usr/bin/env tsx
/**
 * RFC-020 PR-D1 — connected-agents read surface (grants + recent-use from the audit log).
 *   用法:npm run test:connected-agents-read
 *
 * GET /api/agent-grants (human-authenticated) is what the "Connected agents" UI reads.
 * Proves it returns, per grant: scope/status/expiry/revoked + recent-use (last_used_at,
 * use_count) derived from agent_grant_auth_log (allow rows), with human isolation and no
 * secret (token_hash) leakage. No money/order/wallet path.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-cagents-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
setSeamDb(db)
const auth = (req: express.Request, res: express.Response) => {
  const u = req.header('x-test-user')
  if (!u) { res.status(401).json({ error: 'unauthorized' }); return null }
  return { id: u }
}
const app = express()
app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const j = async (path: string, user?: string, method = 'GET') => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) } })
  return { status: r.status, body: await r.json().catch(() => ({})) as any }
}

const mkGrant = (human: string, label: string, caps: string[], status = 'active'): string => {
  const gid = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(gid, human, label, JSON.stringify(caps.map(c => ({ capability: c }))), 'hash_' + gid, status, new Date(Date.now() + 3600_000).toISOString())
  return gid
}
const audit = (gid: string, human: string, outcome: 'allow' | 'deny', ts: string): void => {
  db.prepare('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, ts) VALUES (?,?,?,?,?)').run(gid, human, 'read_public', outcome, ts)
}

try {
  const alice = generateId('usr'), bob = generateId('usr')
  const gUsed = mkGrant(alice, 'BusyAgent', ['read_public', 'search'])
  const gFresh = mkGrant(alice, 'NewAgent', ['read_public'])           // no usage yet
  const gRevoked = mkGrant(alice, 'OldAgent', ['read_public'], 'active')
  const gBob = mkGrant(bob, 'BobAgent', ['read_public'])               // belongs to a different human

  audit(gUsed, alice, 'allow', '2026-06-20T10:00:00Z')
  audit(gUsed, alice, 'allow', '2026-06-25T12:00:00Z')                 // latest allow
  audit(gUsed, alice, 'deny', '2026-06-26T09:00:00Z')                  // deny must NOT count as "use"

  // auth required
  ok('list requires human auth', (await j('/api/agent-grants')).status === 401)

  const r = await j('/api/agent-grants', alice)
  ok('list returns 200', r.status === 200 && Array.isArray(r.body.grants))
  const byId: Record<string, any> = Object.fromEntries(r.body.grants.map((g: any) => [g.grant_id, g]))

  // human isolation
  ok('only the human\'s own grants are listed', r.body.grants.length === 3 && !byId[gBob])

  // recent-use derived from allow rows only
  ok('used grant: use_count counts allow rows only (not deny)', byId[gUsed]?.use_count === 2)
  ok('used grant: last_used_at is the latest allow ts', byId[gUsed]?.last_used_at === '2026-06-25T12:00:00Z')
  ok('fresh grant: use_count 0, last_used_at null', byId[gFresh]?.use_count === 0 && (byId[gFresh]?.last_used_at == null))

  // scope/status surfaced for the UI
  ok('capabilities parsed to array', Array.isArray(byId[gUsed]?.capabilities))
  ok('active flag present', byId[gUsed]?.active === true)

  // no secret leakage
  ok('no token_hash / token in the read surface', !JSON.stringify(r.body).match(/token_hash|"token"|gtk_|hash_/))

  // revoke flows through to the read surface
  ok('revoke succeeds', (await j(`/api/agent-grants/${gRevoked}/revoke`, alice, 'POST')).status === 200)
  const r2 = await j('/api/agent-grants', alice)
  const revoked = r2.body.grants.find((g: any) => g.grant_id === gRevoked)
  ok('revoked grant shows status=revoked + active=false', revoked?.status === 'revoked' && revoked?.active === false)

  if (fail === 0) {
    console.log(`\n✅ connected-agents read (PR-D1): grants + recent-use (allow-only) from audit log; human isolation; revoke reflected; no secret leak\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ connected-agents read FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  rmSync(tmpHome, { recursive: true, force: true })
}
