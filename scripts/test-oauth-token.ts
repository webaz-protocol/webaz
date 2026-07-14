#!/usr/bin/env tsx
/**
 * RFC-023 PR-3 test — POST /oauth/token (code+PKCE → opaque access token).
 *
 * Behavioral: fresh in-memory DB, real schema, codes seeded exactly the way the consent approve
 * step mints them (hashed, grant-linked). Covers: valid exchange, single-use CAS, replay→revoke,
 * wrong verifier/redirect/client burn-on-attempt, resource mismatch, dead-grant refusal,
 * expiry clamped to the grant, fail-closed mounting, form-encoded body.
 *
 * Usage: npm run test:oauth-token
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
setSeamDb(db)   // point the dbOne/dbRun async seam at the in-memory DB

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'   // RFC 7636 appendix B
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const CLIENT = 'webaz-dev-client'
const REDIRECT = 'http://localhost:8787/callback'
const RESOURCE = 'https://webaz.xyz/mcp'

let seq = 0
/** Seed a grant + auth code exactly as the consent approve step mints them. */
function seed(over: { grantExpMs?: number; codeExpMs?: number; grantStatus?: string } = {}): { code: string; grantId: string } {
  const grantId = `grt_t${++seq}`
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(grantId, 'usr_1', 'OAuth: t', JSON.stringify([{ capability: 'read_public' }]), null, 0, over.grantStatus ?? 'active', new Date(Date.now() + (over.grantExpMs ?? 3600_000)).toISOString())
  const code = `oac_${randomBytes(32).toString('hex')}`
  db.prepare('INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, grant_id, scope, code_challenge, redirect_uri, resource, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha(code), CLIENT, 'usr_1', grantId, 'read', CHALLENGE, REDIRECT, RESOURCE, new Date(Date.now() + (over.codeExpMs ?? 60_000)).toISOString())
  return { code, grantId }
}

async function main() {
  process.env.WEBAZ_OAUTH = '1'; delete process.env.WEBAZ_MODE; process.env.WEBAZ_OAUTH_DEV_CLIENT = '1'
  const { registerOAuthTokenRoutes } = await import('../src/pwa/routes/oauth-token.js')
  const app = express()
  const rlKeys: string[] = []
  registerOAuthTokenRoutes(app, { rateLimitOk: (k: string) => { rlKeys.push(k); return true } })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const exchange = (params: Record<string, string>) =>
    fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
  const good = (code: string): Record<string, string> =>
    ({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: CLIENT })

  // ── 1. valid exchange ──
  {
    const { code, grantId } = seed()
    const r = await exchange({ ...good(code), resource: RESOURCE })
    const j = await r.json() as Record<string, unknown>
    ok('1a. valid exchange → 200 Bearer', r.status === 200 && j.token_type === 'Bearer' && String(j.access_token).startsWith('oat_'))
    ok('1b. scope echoed + expires_in ≤ 3600', j.scope === 'read' && Number(j.expires_in) > 0 && Number(j.expires_in) <= 3600)
    ok('1c. no-store on token response', (r.headers.get('cache-control') || '').includes('no-store'))
    const row = db.prepare('SELECT * FROM oauth_access_tokens WHERE grant_id = ?').get(grantId) as Record<string, unknown>
    ok('1d. token stored HASHED + aud-bound + grant-linked (T2/D1/I-5)', row.token_hash === sha(String(j.access_token)) && row.aud === RESOURCE && row.client_id === CLIENT && row.revoked_at === null)
    ok('1e. code CAS-consumed', (db.prepare('SELECT consumed_at FROM oauth_auth_codes WHERE grant_id = ?').get(grantId) as { consumed_at: string | null }).consumed_at !== null)
    // replay the same code → rejected AND the grant's tokens revoked (RFC 6749 §10.5)
    const r2 = await exchange(good(code))
    ok('1f. code replay → invalid_grant', r2.status === 400 && ((await r2.json()) as { error: string }).error === 'invalid_grant')
    const revoked = db.prepare('SELECT revoked_at FROM oauth_access_tokens WHERE grant_id = ?').get(grantId) as { revoked_at: string | null }
    ok('1g. replay REVOKES the tokens minted from that code (leak posture)', revoked.revoked_at !== null)
  }
  // ── 2. PKCE + bindings (burn-on-attempt) ──
  {
    const { code } = seed()
    const r = await exchange({ ...good(code), code_verifier: 'wrong-wrong-wrong-wrong-wrong-wrong-wrong-wr' })
    ok('2a. wrong verifier → invalid_grant (T4)', r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant')
    const r2 = await exchange(good(code))
    ok('2b. failed attempt BURNED the code (no second try)', r2.status === 400)
  }
  ok('2c. wrong redirect_uri → invalid_grant (T5)', await (async () => { const { code } = seed(); const r = await exchange({ ...good(code), redirect_uri: 'http://127.0.0.1:8787/callback' }); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant' })())
  ok('2d. different client → invalid_grant', await (async () => {
    const { code } = seed()
    db.prepare('UPDATE oauth_auth_codes SET client_id = ? WHERE code_hash = ?').run('other-client', sha(code))
    const r = await exchange(good(code)); return r.status === 400
  })())
  ok('2e. wrong resource → invalid_target (I-3)', await (async () => { const { code } = seed(); const r = await exchange({ ...good(code), resource: 'https://webaz.xyz/other' }); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_target' })())
  ok('2f. expired code → invalid_grant', await (async () => { const { code } = seed({ codeExpMs: -1000 }); const r = await exchange(good(code)); return r.status === 400 })())
  ok('2g. malformed verifier charset rejected', await (async () => { const { code } = seed(); const r = await exchange({ ...good(code), code_verifier: 'short' }); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_request' })())
  // ── 3. grant liveness + clamp (I-5/D2) ──
  ok('3a. revoked grant → invalid_grant (mid-flight revocation honored)', await (async () => { const { code } = seed({ grantStatus: 'revoked' }); const r = await exchange(good(code)); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant' })())
  ok('3b. token expiry CLAMPED to grant expiry (never outlives the grant)', await (async () => {
    const { code } = seed({ grantExpMs: 120_000 })   // grant dies in 2min
    const r = await exchange(good(code)); const j = await r.json() as { expires_in: number }
    return r.status === 200 && j.expires_in <= 120
  })())
  // ── 4. protocol shape ──
  ok('4a. wrong grant_type → unsupported_grant_type', await (async () => { const r = await exchange({ grant_type: 'client_credentials', client_id: CLIENT }); return r.status === 400 && ((await r.json()) as { error: string }).error === 'unsupported_grant_type' })())
  ok('4b. unknown client → 401 invalid_client', await (async () => { const { code } = seed(); const r = await exchange({ ...good(code), client_id: 'ghost' }); return r.status === 401 })())
  ok('4c. unknown code → invalid_grant (no oracle)', await (async () => { const r = await exchange(good('oac_' + 'f'.repeat(64))); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant' })())
  // ── 5. Codex PR-3 fixes ──
  ok('5a. oversized body → RFC-shaped invalid_request + no-store (not HTML 413)', await (async () => {
    const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a='.padEnd(4096, 'x') })
    const ct = r.headers.get('content-type') || ''
    const j = ct.includes('json') ? await r.json() as { error?: string } : {}
    return r.status === 400 && j.error === 'invalid_request' && (r.headers.get('cache-control') || '').includes('no-store')
  })())
  ok('5b. expired-UNCONSUMED code replay does NOT revoke the grant tokens (no DoS)', await (async () => {
    const { code, grantId } = seed({ codeExpMs: -1000 })
    db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)')
      .run(sha('some_other_token'), grantId, CLIENT, 'read', RESOURCE, new Date(Date.now() + 60_000).toISOString())
    const r = await exchange(good(code))
    const tok = db.prepare('SELECT revoked_at FROM oauth_access_tokens WHERE grant_id = ?').get(grantId) as { revoked_at: string | null }
    return r.status === 400 && tok.revoked_at === null
  })())
  ok('5c. rate-limit bucket keys on CF-Connecting-IP when present (P1)', await (async () => {
    rlKeys.length = 0
    await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.9' }, body: 'grant_type=x' })
    return rlKeys.length === 1 && rlKeys[0] === 'oauth_token:203.0.113.9'
  })())
  http.close()

  // ── 6. fail-closed ──
  {
    delete process.env.WEBAZ_OAUTH
    const { registerOAuthTokenRoutes: reg2 } = await import('../src/pwa/routes/oauth-token.js')
    const app2 = express(); reg2(app2, { rateLimitOk: () => true })
    const h2 = await new Promise<HttpServer>(r => { const s = app2.listen(0, () => r(s)) })
    const a2 = h2.address(); const b2 = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`
    const r = await fetch(`${b2}/oauth/token`, { method: 'POST' })
    ok('6. flag off → 404', r.status === 404)
    h2.close()
  }

  if (fail > 0) { console.error(`\n❌ oauth token FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth token: PKCE verify · CAS single-use + burn-on-attempt · replay→revoke · bindings (client/redirect/resource) · grant liveness + expiry clamp · opaque hashed · fail-closed\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
