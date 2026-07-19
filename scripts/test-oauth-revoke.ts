#!/usr/bin/env tsx
/**
 * RFC-023 PR-3(revoke) test — POST /oauth/revoke (RFC 7009).
 *
 * Behavioral: fresh in-memory DB, real schema + seam, seed a grant with an access + a refresh token, then
 * the REAL /oauth/revoke route over HTTP. Covers: revoke-by-access + revoke-by-refresh → whole connection
 * torn down (grant revoked + all access/refresh revoked); unknown/malformed → 200 no-oracle; cross-client
 * no-op; missing token → 400; unknown client → 401; wrong token_type_hint still works; idempotent;
 * no-store; fail-closed. NEVER prints a token.
 *
 * Usage: npm run test:oauth-revoke
 */
import express from 'express'
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { initOAuthSchema, initAgentDelegationGrantsSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = new Database(':memory:')
initOAuthSchema(db); initAgentDelegationGrantsSchema(db)
setSeamDb(db)

const CLIENT = 'webaz-dev-client'
const RESOURCE = 'https://webaz.xyz/mcp'

let seq = 0
/** Seed a grant + one access token + one refresh token (same grant/family). Returns the raw tokens + ids. */
function seed(clientId = CLIENT): { grantId: string; access: string; refresh: string } {
  const grantId = `grt_v${++seq}`
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(grantId, 'usr_1', 'OAuth: t', JSON.stringify([{ capability: 'read_public' }]), null, 0, 'active', new Date(Date.now() + 2592000_000).toISOString())
  const access = `oat_${randomBytes(32).toString('hex')}`
  db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)')
    .run(sha(access), grantId, clientId, 'read', RESOURCE, new Date(Date.now() + 3600_000).toISOString())
  const refresh = `ort_${randomBytes(32).toString('hex')}`
  db.prepare('INSERT INTO oauth_refresh_tokens (token_hash, grant_id, client_id, family_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(sha(refresh), grantId, clientId, `orf_${randomBytes(8).toString('hex')}`, 'read', RESOURCE, new Date(Date.now() + 2592000_000).toISOString())
  return { grantId, access, refresh }
}
const grantStatus = (id: string) => (db.prepare('SELECT status FROM agent_delegation_grants WHERE grant_id = ?').get(id) as { status: string }).status
const liveTokens = (id: string) =>
  (db.prepare('SELECT COUNT(*) n FROM oauth_access_tokens WHERE grant_id = ? AND revoked_at IS NULL').get(id) as { n: number }).n +
  (db.prepare('SELECT COUNT(*) n FROM oauth_refresh_tokens WHERE grant_id = ? AND revoked_at IS NULL').get(id) as { n: number }).n

async function main() {
  process.env.WEBAZ_OAUTH = '1'; delete process.env.WEBAZ_MODE; process.env.WEBAZ_OAUTH_DEV_CLIENT = '1'
  const { registerOAuthRevokeRoutes } = await import('../src/pwa/routes/oauth-revoke.js')
  const app = express()
  app.use(express.json())
  registerOAuthRevokeRoutes(app, { db, rateLimitOk: () => true })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const revoke = (params: Record<string, string>) =>
    fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })

  // ── 1. revoke by ACCESS token → whole connection down ──
  {
    const { grantId, access } = seed()
    const r = await revoke({ token: access, client_id: CLIENT })
    ok('1a. revoke(access) → 200', r.status === 200)
    ok('1b. no-store header', (r.headers.get('cache-control') || '').includes('no-store'))
    ok('1c. grant is revoked', grantStatus(grantId) === 'revoked')
    ok('1d. all access + refresh tokens of the grant revoked', liveTokens(grantId) === 0)
  }
  // ── 2. revoke by REFRESH token → same cascade ──
  {
    const { grantId, refresh } = seed()
    const r = await revoke({ token: refresh, client_id: CLIENT, token_type_hint: 'refresh_token' })
    ok('2a. revoke(refresh) → 200 + grant revoked + tokens dead', r.status === 200 && grantStatus(grantId) === 'revoked' && liveTokens(grantId) === 0)
  }
  // ── 3. wrong token_type_hint still resolves (hint is advisory) ──
  {
    const { grantId, refresh } = seed()
    const r = await revoke({ token: refresh, client_id: CLIENT, token_type_hint: 'access_token' })   // wrong hint
    ok('3. wrong hint → still revoked (fallback to the other table)', r.status === 200 && grantStatus(grantId) === 'revoked')
  }
  // ── 4. no-oracle: EVERY presented token gets an IDENTICAL empty 200 (recognized/unknown/malformed/cross-client) ──
  const bodyOf = async (r: Response) => ({ status: r.status, body: await r.text() })
  ok('4a. unknown well-formed token → 200 empty', await (async () => {
    const b = await bodyOf(await revoke({ token: 'oat_' + 'a'.repeat(64), client_id: CLIENT })); return b.status === 200 && b.body === ''
  })())
  ok('4b. malformed token → 200 empty (no oracle)', await (async () => {
    const b = await bodyOf(await revoke({ token: 'garbage', client_id: CLIENT })); return b.status === 200 && b.body === ''
  })())
  ok('4c. cross-client revoke → 200 empty AND a genuine no-op (other client\'s grant untouched)', await (async () => {
    const { grantId, access } = seed('some-other-client')
    const b = await bodyOf(await revoke({ token: access, client_id: CLIENT }))   // dev client tries to revoke another client's token
    return b.status === 200 && b.body === '' && grantStatus(grantId) === 'active' && liveTokens(grantId) === 2
  })())
  ok('4c2. recognized-owned, unknown, malformed, cross-client responses are INDISTINGUISHABLE', await (async () => {
    const owned = await bodyOf(await revoke({ token: seed().access, client_id: CLIENT }))
    const unknown = await bodyOf(await revoke({ token: 'oat_' + 'b'.repeat(64), client_id: CLIENT }))
    const malformed = await bodyOf(await revoke({ token: 'nope', client_id: CLIENT }))
    const cross = await bodyOf(await revoke({ token: seed('other').access, client_id: CLIENT }))
    return [unknown, malformed, cross].every(x => x.status === owned.status && x.body === owned.body)
  })())
  ok('4d. missing token → 400 invalid_request', await (async () => {
    const r = await revoke({ client_id: CLIENT }); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_request'
  })())
  ok('4e. unknown client_id → 401 invalid_client', await (async () => {
    const { access } = seed()
    const r = await revoke({ token: access, client_id: 'ghost' }); return r.status === 401 && ((await r.json()) as { error: string }).error === 'invalid_client'
  })())
  ok('4f. idempotent: revoke twice → both 200', await (async () => {
    const { access } = seed()
    const r1 = await revoke({ token: access, client_id: CLIENT }); const r2 = await revoke({ token: access, client_id: CLIENT })
    return r1.status === 200 && r2.status === 200
  })())
  http.close()

  // ── 5. fail-closed ──
  {
    delete process.env.WEBAZ_OAUTH
    const { registerOAuthRevokeRoutes: reg2 } = await import('../src/pwa/routes/oauth-revoke.js')
    const app2 = express(); reg2(app2, { db, rateLimitOk: () => true })
    const h2 = await new Promise<HttpServer>(r => { const s = app2.listen(0, () => r(s)) })
    const a2 = h2.address(); const b2 = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`
    const r = await fetch(`${b2}/oauth/revoke`, { method: 'POST' })
    ok('5. flag off → 404', r.status === 404)
    h2.close()
  }

  if (fail > 0) { console.error(`\n❌ oauth revoke FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth revoke (RFC 7009): revoke-by-access/refresh → grant + all tokens down · no-oracle unknown/malformed · cross-client no-op · advisory hint fallback · idempotent · 400/401 shapes · no-store · fail-closed\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
