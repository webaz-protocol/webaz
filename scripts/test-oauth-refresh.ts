#!/usr/bin/env tsx
/**
 * RFC-023 PR-1(refresh) test — rotating refresh tokens on POST /oauth/token.
 *
 * Behavioral: fresh in-memory DB, real schema, codes seeded the way consent-approve mints them, then the
 * REAL /oauth/token route over HTTP. Covers: code exchange now also returns a refresh token (hashed,
 * family-linked, grant-clamped); refresh rotation → new access + new refresh (same family, old spent);
 * single-use + family-replay theft revocation; rotation chain; grant liveness + I-5 clamp; client binding;
 * malformed/unknown refresh; and that refresh never escalates scope. NEVER prints any token.
 *
 * Usage: npm run test:oauth-refresh
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

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'   // RFC 7636 appendix B
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const CLIENT = 'webaz-dev-client'
const REDIRECT = 'http://localhost:8787/callback'
const RESOURCE = 'https://webaz.xyz/mcp'

let seq = 0
/** Seed a grant + auth code exactly as the consent approve step mints them. */
function seed(over: { grantExpMs?: number } = {}): { code: string; grantId: string } {
  const grantId = `grt_r${++seq}`
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(grantId, 'usr_1', 'OAuth: t', JSON.stringify([{ capability: 'read_public' }]), null, 0, 'active', new Date(Date.now() + (over.grantExpMs ?? 3600_000)).toISOString())
  const code = `oac_${randomBytes(32).toString('hex')}`
  db.prepare('INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, grant_id, scope, code_challenge, redirect_uri, resource, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha(code), CLIENT, 'usr_1', grantId, 'read', CHALLENGE, REDIRECT, RESOURCE, new Date(Date.now() + 60_000).toISOString())
  return { code, grantId }
}

async function main() {
  process.env.WEBAZ_OAUTH = '1'; delete process.env.WEBAZ_MODE; process.env.WEBAZ_OAUTH_DEV_CLIENT = '1'
  const { registerOAuthTokenRoutes } = await import('../src/pwa/routes/oauth-token.js')
  const app = express()
  app.use(express.json())
  registerOAuthTokenRoutes(app, { rateLimitOk: () => true })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const post = (params: Record<string, string>) =>
    fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
  const exchange = (code: string) => post({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: CLIENT, resource: RESOURCE })
  const refresh = (rt: string, over: Record<string, string> = {}) => post({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT, ...over })
  const REFRESH_RE = /^ort_[0-9a-f]{64}$/

  // ── 1. code exchange now ALSO issues a refresh token ──
  let firstRefresh = ''; let firstGrant = ''
  {
    const { code, grantId } = seed(); firstGrant = grantId
    const r = await exchange(code); const j = await r.json() as Record<string, unknown>
    firstRefresh = String(j.refresh_token)
    ok('1a. code exchange returns a refresh_token (ort_)', r.status === 200 && REFRESH_RE.test(firstRefresh))
    ok('1b. access_token still returned (no regression)', String(j.access_token).startsWith('oat_'))
    const row = db.prepare('SELECT * FROM oauth_refresh_tokens WHERE grant_id = ?').get(grantId) as Record<string, unknown>
    ok('1c. refresh stored HASHED + grant/client/aud-bound + has family_id (D1/I-5)',
      row.token_hash === sha(firstRefresh) && row.grant_id === grantId && row.client_id === CLIENT && row.aud === RESOURCE && typeof row.family_id === 'string' && (row.family_id as string).length > 0)
    ok('1d. fresh refresh is un-rotated + un-revoked', row.rotated_at === null && row.revoked_at === null && row.replaced_by === null)
    ok('1e. refresh expiry clamped to grant (≤ grant expiry, I-5)', new Date(String(row.expires_at)).getTime() <= new Date(Date.now() + 3600_000 + 2000).getTime())
  }

  // ── 2. valid rotation → new access + new refresh (same family); old is spent ──
  let secondRefresh = ''; let firstFamily = ''
  {
    const before = db.prepare('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ?').get(sha(firstRefresh)) as { family_id: string }
    firstFamily = before.family_id
    const r = await refresh(firstRefresh); const j = await r.json() as Record<string, unknown>
    secondRefresh = String(j.refresh_token)
    ok('2a. refresh → 200 with new access + new refresh', r.status === 200 && String(j.access_token).startsWith('oat_') && REFRESH_RE.test(secondRefresh))
    ok('2b. new refresh differs from old', secondRefresh !== firstRefresh)
    const oldRow = db.prepare('SELECT rotated_at, replaced_by FROM oauth_refresh_tokens WHERE token_hash = ?').get(sha(firstRefresh)) as { rotated_at: string | null; replaced_by: string | null }
    ok('2c. old refresh marked rotated + replaced_by → successor (audit chain)', oldRow.rotated_at !== null && oldRow.replaced_by === sha(secondRefresh))
    const newRow = db.prepare('SELECT family_id, rotated_at FROM oauth_refresh_tokens WHERE token_hash = ?').get(sha(secondRefresh)) as { family_id: string; rotated_at: string | null }
    ok('2d. successor keeps the SAME family + is fresh', newRow.family_id === firstFamily && newRow.rotated_at === null)
    ok('2e. scope carried forward unchanged (no escalation)', j.scope === 'read')
  }

  // ── 3. chained rotation continues to work ──
  let thirdRefresh = ''
  {
    const r = await refresh(secondRefresh); const j = await r.json() as Record<string, unknown>
    thirdRefresh = String(j.refresh_token)
    ok('3. chain: rotate the successor again → 200', r.status === 200 && REFRESH_RE.test(thirdRefresh))
  }

  // ── 4. single-use + family-replay theft revocation (RFC 6819 §5.2.2.3) ──
  {
    // Mint a live access token on this grant so we can prove the replay nukes it too.
    db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)')
      .run(sha('live_access_' + firstGrant), firstGrant, CLIENT, 'read', RESOURCE, new Date(Date.now() + 3600_000).toISOString())
    // Reuse the ALREADY-ROTATED second refresh → theft.
    const r = await refresh(secondRefresh); const j = await r.json() as { error: string }
    ok('4a. reuse of a spent refresh → invalid_grant', r.status === 400 && j.error === 'invalid_grant')
    const family = db.prepare('SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE family_id = ? AND revoked_at IS NULL').get(firstFamily) as { n: number }
    ok('4b. replay revokes the WHOLE rotation family', family.n === 0)
    const acc = db.prepare("SELECT COUNT(*) AS n FROM oauth_access_tokens WHERE grant_id = ? AND revoked_at IS NULL").get(firstGrant) as { n: number }
    ok('4c. replay also revokes the grant\'s access tokens (leak posture)', acc.n === 0)
    // The (previously valid) third refresh is now dead too — the family was nuked.
    const r2 = await refresh(thirdRefresh)
    ok('4d. the still-unused successor is dead after family revocation', r2.status === 400)
  }

  // ── 5. grant liveness + I-5 clamp ──
  ok('5a. refresh after grant revoked → invalid_grant (mid-flight)', await (async () => {
    const { code, grantId } = seed(); const j = await (await exchange(code)).json() as { refresh_token: string }
    db.prepare("UPDATE agent_delegation_grants SET status = 'revoked', revoked_at = ? WHERE grant_id = ?").run(new Date().toISOString(), grantId)
    const r = await refresh(j.refresh_token); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant'
  })())
  ok('5b. refresh access expiry clamped to a short grant (never outlives it)', await (async () => {
    const { code } = seed({ grantExpMs: 120_000 }); const j = await (await exchange(code)).json() as { refresh_token: string }
    const r = await refresh(j.refresh_token); const jj = await r.json() as { expires_in: number }
    return r.status === 200 && jj.expires_in <= 120
  })())

  // ── 6. bindings + protocol shape ──
  ok('6a. refresh from a different client → invalid_grant', await (async () => {
    const { code } = seed(); const j = await (await exchange(code)).json() as { refresh_token: string }
    // A second registered-looking client id that is NOT the dev client → unknown_client 401 first;
    // so instead simulate a mismatch by rebinding the token's client_id in the DB, then present dev client.
    db.prepare('UPDATE oauth_refresh_tokens SET client_id = ? WHERE token_hash = ?').run('other-client', sha(j.refresh_token))
    const r = await refresh(j.refresh_token); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant'
  })())
  ok('6b. malformed refresh_token → invalid_request', await (async () => {
    const r = await refresh('not-a-refresh-token'); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_request'
  })())
  ok('6c. unknown well-formed refresh → invalid_grant (no oracle, no spurious revoke)', await (async () => {
    const r = await refresh('ort_' + 'a'.repeat(64)); return r.status === 400 && ((await r.json()) as { error: string }).error === 'invalid_grant'
  })())
  ok('6d. unknown client on refresh → 401 invalid_client', await (async () => {
    const { code } = seed(); const j = await (await exchange(code)).json() as { refresh_token: string }
    const r = await refresh(j.refresh_token, { client_id: 'ghost' }); return r.status === 401
  })())
  ok('6e. discovery-unlisted grant_type → unsupported_grant_type', await (async () => {
    const r = await post({ grant_type: 'client_credentials', client_id: CLIENT }); return r.status === 400 && ((await r.json()) as { error: string }).error === 'unsupported_grant_type'
  })())

  http.close()

  if (fail > 0) { console.error(`\n❌ oauth refresh FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth refresh: code→access+refresh · rotation (same family, single-use) · family-replay theft revocation · rotation chain · grant liveness + I-5 clamp · client binding · no scope escalation\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
