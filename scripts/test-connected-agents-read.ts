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
const { initOAuthSchema } = await import('../src/runtime/webaz-schema-helpers.js')   // PR-4: oauth tables for the revoke cascade + connection_kind

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
setSeamDb(db)
initOAuthSchema(db)   // oauth_access_tokens / oauth_refresh_tokens for the PR-4 revoke cascade
const auth = (req: express.Request, res: express.Response) => {
  const u = req.header('x-test-user')
  if (!u) { res.status(401).json({ error: 'unauthorized' }); return null }
  return { id: u }
}
const app = express()
app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true, getProtocolParam: <T,>(k: string, fb: T): T => (k === 'payment_rail_waz_escrow_enabled' ? 1 as unknown as T /* WAZ 退役:验证渠道【开着时】语义 */ : fb) })
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
// An OAuth-consent grant: token_hash=NULL (the OAuth token is the credential) + backing access/refresh tokens.
const mkOAuthGrant = (human: string, label: string): string => {
  const gid = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(gid, human, label, JSON.stringify([{ capability: 'read_public' }]), null, 'active', new Date(Date.now() + 2592000_000).toISOString())
  // The authoritative OAuth discriminator: an oauth_auth_code minted for this grant (oauth-approve does this atomically).
  db.prepare('INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, grant_id, scope, code_challenge, redirect_uri, resource, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('ch_' + gid, 'webaz-dev-client', human, gid, 'read', 'chal', 'https://x/cb', 'https://webaz.xyz/mcp', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
  db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)')
    .run('ah_' + gid, gid, 'webaz-dev-client', 'read', 'https://webaz.xyz/mcp', new Date(Date.now() + 3600_000).toISOString())
  db.prepare('INSERT INTO oauth_refresh_tokens (token_hash, grant_id, client_id, family_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run('rh_' + gid, gid, 'webaz-dev-client', 'orf_' + gid, 'read', 'https://webaz.xyz/mcp', new Date(Date.now() + 2592000_000).toISOString())
  return gid
}
const oauthTokensLive = (gid: string) =>
  (db.prepare('SELECT COUNT(*) n FROM oauth_access_tokens WHERE grant_id = ? AND revoked_at IS NULL').get(gid) as { n: number }).n +
  (db.prepare('SELECT COUNT(*) n FROM oauth_refresh_tokens WHERE grant_id = ? AND revoked_at IS NULL').get(gid) as { n: number }).n

try {
  const alice = generateId('usr'), bob = generateId('usr')
  const gUsed = mkGrant(alice, 'BusyAgent', ['read_public', 'search'])
  const gFresh = mkGrant(alice, 'NewAgent', ['read_public'])           // no usage yet
  const gRevoked = mkGrant(alice, 'OldAgent', ['read_public'], 'active')
  const gBob = mkGrant(bob, 'BobAgent', ['read_public'])               // belongs to a different human
  const gOAuth = mkOAuthGrant(alice, 'OAuth: ChatGPT')                 // PR-4: an OAuth-connected app (has an oauth_auth_code)
  // A Passkey-paired grant that is token_hash=NULL but has NO oauth code (approved, credential not yet retrieved).
  const gNullNoOauth = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(gNullNoOauth, alice, 'PendingAgent', JSON.stringify([{ capability: 'read_public' }]), null, 'active', new Date(Date.now() + 3600_000).toISOString())

  audit(gUsed, alice, 'allow', '2026-06-20T10:00:00Z')
  audit(gUsed, alice, 'allow', '2026-06-25T12:00:00Z')                 // latest allow
  audit(gUsed, alice, 'deny', '2026-06-26T09:00:00Z')                  // deny must NOT count as "use"

  // auth required
  ok('list requires human auth', (await j('/api/agent-grants')).status === 401)

  const r = await j('/api/agent-grants', alice)
  ok('list returns 200', r.status === 200 && Array.isArray(r.body.grants))
  const byId: Record<string, any> = Object.fromEntries(r.body.grants.map((g: any) => [g.grant_id, g]))

  // human isolation
  ok('only the human\'s own grants are listed', r.body.grants.length === 5 && !byId[gBob])

  // PR-4: connection_kind distinguishes OAuth apps (has an oauth_auth_code) from gtk_ paired agents.
  // Authoritative discriminator is the auth-code, NOT token_hash-nullability (Codex R1).
  ok('gtk_ paired grant → connection_kind=delegation', byId[gUsed]?.connection_kind === 'delegation')
  ok('OAuth-consent grant → connection_kind=oauth', byId[gOAuth]?.connection_kind === 'oauth')
  ok('NULL-token-hash grant WITHOUT an oauth code → still delegation (not mislabeled OAuth)', byId[gNullNoOauth]?.connection_kind === 'delegation')

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

  // PR-4: revoking an OAuth grant cascades — its access + refresh tokens are stamped revoked (like /oauth/revoke)
  ok('OAuth grant has live tokens before revoke', oauthTokensLive(gOAuth) === 2)
  ok('revoke OAuth grant succeeds', (await j(`/api/agent-grants/${gOAuth}/revoke`, alice, 'POST')).status === 200)
  ok('revoke cascaded: all OAuth access+refresh tokens revoked', oauthTokensLive(gOAuth) === 0)

  // PR-4 (Codex R1): an ALREADY-revoked grant with an orphaned live token → retry still cascades (idempotent teardown)
  const gOrphan = mkOAuthGrant(alice, 'OAuth: Legacy')
  db.prepare("UPDATE agent_delegation_grants SET status='revoked', revoked_at=? WHERE grant_id=?").run(new Date().toISOString(), gOrphan)   // grant revoked but tokens left live (legacy/partial state)
  ok('legacy: revoked grant still has live orphan tokens', oauthTokensLive(gOrphan) === 2)
  const rr = await j(`/api/agent-grants/${gOrphan}/revoke`, alice, 'POST')
  ok('retry on already-revoked grant → 200 already_revoked', rr.status === 200 && rr.body.already_revoked === true)
  ok('retry repaired the orphan tokens (cascade runs even when already revoked)', oauthTokensLive(gOrphan) === 0)

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
