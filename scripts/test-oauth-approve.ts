#!/usr/bin/env tsx
/**
 * RFC-023 PR-2b test — consent approve/deny (grant + single-use code mint behind a REAL Passkey gate).
 *
 * Behavioral: real express app, fresh in-memory DB (real initOAuthSchema / initAgentDelegationGrantsSchema /
 * initWebauthnSchema), and the REAL createHumanPresence gate consuming real webauthn_gate_tokens rows —
 * the gate is the key judge here and is NOT stubbed (only the browser-side ceremony is simulated by
 * inserting the token row it would mint). auth is injected via the deps seam (standard route pattern).
 *
 * Gate has NO param bypass: the injected getProtocolParam returns 0 ('disabled') and every unauthorized
 * mint attempt must still 412 — the route consumes gate tokens directly (Codex PR-2b P2 fix).
 *
 * Usage: npm run test:oauth-approve
 */
import express from 'express'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { Request, Response } from 'express'
import { initOAuthSchema, initAgentDelegationGrantsSchema, initWebauthnSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { createHumanPresence } from '../src/pwa/human-presence.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const USER = 'usr_test_1'
const GOOD = {
  client_id: 'webaz-dev-client', redirect_uri: 'http://localhost:8787/callback',
  scope: 'read order:draft', code_challenge: CHALLENGE, resource: 'https://webaz.xyz/mcp', state: 'st1',
}

const db = new Database(':memory:')
initOAuthSchema(db); initAgentDelegationGrantsSchema(db); initWebauthnSchema(db)
setSeamDb(db)   // RFC-024: the approve route now reads oauth_clients via the async seam (await oauthClients())
const hp = createHumanPresence(db, <T,>(_k: string, _fb: T): T => 0 as T)   // params claim DISABLED — the mint gate must ignore params entirely (P2 fix: consumeGateToken direct)

let gateSeq = 0
/** Simulate the post-ceremony state: insert the gate-token row /api/webauthn/auth/finish would mint. */
function mintGateToken(purposeData: Record<string, unknown>, purpose = 'oauth_consent_approve', userId = USER): string {
  const id = `wgt_${++gateSeq}_${Math.random().toString(36).slice(2)}`
  // PR-2: the consent gate is now bound to duration too; default to the server default (30d) unless overridden.
  const pd = { duration: '30d', ...purposeData }
  db.prepare('INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,?)')
    .run(id, userId, purpose, JSON.stringify(pd), new Date(Date.now() + 60_000).toISOString())
  return id
}

async function main() {
  process.env.WEBAZ_OAUTH = '1'; delete process.env.WEBAZ_MODE; process.env.WEBAZ_OAUTH_DEV_CLIENT = '1'
  const { registerOAuthApproveRoutes } = await import('../src/pwa/routes/oauth-approve.js')

  const auth = (req: Request, res: Response): Record<string, unknown> | null => {
    const key = req.headers.authorization?.replace('Bearer ', '')
    if (key !== 'k_test') { res.status(401).json({ error: 'unauthorized' }); return null }
    return { id: USER }
  }
  const app = express(); app.use(express.json())
  registerOAuthApproveRoutes(app, {
    db, auth,
    generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    consumeGateToken: hp.consumeGateToken,
    rateLimitOk: () => true,
  })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const post = (path: string, body: Record<string, unknown>, authed = true) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authed ? { authorization: 'Bearer k_test' } : {}) }, body: JSON.stringify(body) })
  const counts = () => ({
    grants: (db.prepare('SELECT COUNT(*) c FROM agent_delegation_grants').get() as { c: number }).c,
    codes: (db.prepare('SELECT COUNT(*) c FROM oauth_auth_codes').get() as { c: number }).c,
  })

  // ── 1. happy path: approve mints grant + code ──
  {
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource })
    const r = await post('/oauth/authorize/approve', { ...GOOD, webauthn_token: tok })
    const j = await r.json() as { redirect_to?: string }
    ok('1a. approve → 200 with redirect_to', r.status === 200 && typeof j.redirect_to === 'string')
    const url = new URL(j.redirect_to as string)
    const code = url.searchParams.get('code') || ''
    ok('1b. redirect_to targets the validated redirect_uri', j.redirect_to!.startsWith('http://localhost:8787/callback?'))
    ok('1c. code is oac_ + state echoed', code.startsWith('oac_') && url.searchParams.get('state') === 'st1')
    const { grants, codes } = counts()
    ok('1d. exactly 1 grant + 1 code minted', grants === 1 && codes === 1)
    const g = db.prepare('SELECT * FROM agent_delegation_grants').get() as Record<string, unknown>
    ok('1e. grant: active, human-bound, OAuth-labeled, no bearer', g.human_id === USER && g.status === 'active' && String(g.agent_label).startsWith('OAuth:') && g.token_hash === null)
    const capNames = (JSON.parse(String(g.capabilities)) as { capability: string }[]).map(c => c.capability).sort()
    // read → public reads + own catalog + minimal orders; order:draft → draft_order + order_action_request (widened, Codex PR-5 P1)
    ok('1f. capabilities = SAFE mapping of read+order:draft', JSON.stringify(capNames) === JSON.stringify(['approval_requests_read', 'buyer_case_prepare', 'buyer_discover', 'buyer_orders_read', 'buyer_orders_read_minimal', 'draft_order', 'order_action_request', 'order_submit_request', 'price_quote', 'profile_read', 'read_public', 'search', 'seller_orders_read_minimal', 'seller_products_read', 'wallet_read_minimal']))
    const c = db.prepare('SELECT * FROM oauth_auth_codes').get() as Record<string, unknown>
    ok('1g. code stored HASHED, bound to grant/client/challenge/redirect/resource', c.code_hash === createHash('sha256').update(code).digest('hex') && c.grant_id === g.grant_id && c.client_id === GOOD.client_id && c.code_challenge === CHALLENGE && c.redirect_uri === GOOD.redirect_uri && c.resource === GOOD.resource && c.consumed_at === null)
    ok('1h. code TTL short (≤60s)', new Date(String(c.expires_at)).getTime() - Date.now() <= 60_000)
    // gate token single-use: replay the SAME token
    const r2 = await post('/oauth/authorize/approve', { ...GOOD, webauthn_token: tok })
    ok('1i. gate token single-use — replay → 412, nothing extra minted', r2.status === 412 && counts().grants === 1)
  }
  // ── 2. human gate (I-1) ──
  ok('2a. missing webauthn_token → 412, no mint', await (async () => { const r = await post('/oauth/authorize/approve', { ...GOOD }); return r.status === 412 && counts().grants === 1 })())
  ok('2b. token bound to DIFFERENT client rejected (purpose_data binding)', await (async () => {
    const tok = mintGateToken({ client_id: 'other-client', scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource })
    const r = await post('/oauth/authorize/approve', { ...GOOD, webauthn_token: tok }); return r.status === 412 && counts().grants === 1
  })())
  ok('2c. token with WRONG purpose rejected', await (async () => {
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource }, 'agent_pair_approve')
    const r = await post('/oauth/authorize/approve', { ...GOOD, webauthn_token: tok }); return r.status === 412 && counts().grants === 1
  })())
  ok('2e. token bound to DIFFERENT redirect_uri rejected (approve-what-you-saw)', await (async () => {
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: 'http://127.0.0.1:8787/callback', resource: GOOD.resource })
    const r = await post('/oauth/authorize/approve', { ...GOOD, webauthn_token: tok }); return r.status === 412 && counts().grants === 1
  })())
  ok("2d. another user's token rejected", await (async () => {
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource }, 'oauth_consent_approve', 'usr_other')
    const r = await post('/oauth/authorize/approve', { ...GOOD, webauthn_token: tok }); return r.status === 412 && counts().grants === 1
  })())
  // ── 3. request re-validation (untrusted SPA hand-off) ──
  const withTok = (over: Record<string, unknown>) => ({ ...GOOD, ...over, webauthn_token: mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource }) })
  ok('3a. tampered redirect_uri → 400, no mint', await (async () => { const r = await post('/oauth/authorize/approve', withTok({ redirect_uri: 'http://evil/cb' })); return r.status === 400 && counts().grants === 1 })())
  ok('3b. RISK/unknown scope → 400 (T8)', await (async () => { const r = await post('/oauth/authorize/approve', withTok({ scope: 'order:execute' })); return r.status === 400 && counts().grants === 1 })())
  ok('3c. wrong resource → 400 (I-3)', await (async () => { const r = await post('/oauth/authorize/approve', withTok({ resource: 'https://webaz.xyz/other' })); return r.status === 400 && counts().grants === 1 })())
  ok('3d. unauthenticated → 401', await (async () => { const r = await post('/oauth/authorize/approve', { ...GOOD }, false); return r.status === 401 })())
  // ── 4. deny ──
  {
    const r = await post('/oauth/authorize/deny', { client_id: GOOD.client_id, redirect_uri: GOOD.redirect_uri, state: 's9' })
    const j = await r.json() as { redirect_to?: string }
    ok('4a. deny → access_denied redirect, needs NO passkey', r.status === 200 && (j.redirect_to || '').includes('error=access_denied') && (j.redirect_to || '').includes('state=s9'))
    ok('4b. deny minted nothing', counts().grants === 1 && counts().codes === 1)
    const r2 = await post('/oauth/authorize/deny', { client_id: GOOD.client_id, redirect_uri: 'http://evil/cb' })
    ok('4c. deny with unregistered redirect_uri → 400 (no open redirect)', r2.status === 400)
  }

  // ── 5. PR-2 human-chosen connection duration ──
  const latestGrantExpMs = () => new Date(String((db.prepare('SELECT expires_at FROM agent_delegation_grants ORDER BY rowid DESC LIMIT 1').get() as { expires_at: string }).expires_at)).getTime()
  const near = (ms: number, targetSec: number) => Math.abs(ms - (Date.now() + targetSec * 1000)) <= 120_000
  ok('5a. default (no duration in body) → grant lasts ~30d', await (async () => {
    // happy-path grant #1 was minted with the default; assert its lifetime is ~30d, not the old fixed 1h
    const first = new Date(String((db.prepare('SELECT expires_at FROM agent_delegation_grants ORDER BY rowid ASC LIMIT 1').get() as { expires_at: string }).expires_at)).getTime()
    return first - Date.now() > 25 * 86400 * 1000   // clearly a multi-week grant, not 1h
  })())
  ok('5b. explicit duration=7d → grant lasts ~7d', await (async () => {
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource, duration: '7d' })
    const r = await post('/oauth/authorize/approve', { ...GOOD, duration: '7d', webauthn_token: tok })
    return r.status === 200 && near(latestGrantExpMs(), 604800)
  })())
  ok('5c. explicit duration=30d → grant lasts ~30d', await (async () => {
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource, duration: '30d' })
    const r = await post('/oauth/authorize/approve', { ...GOOD, duration: '30d', webauthn_token: tok })
    return r.status === 200 && near(latestGrantExpMs(), 2592000)
  })())
  ok('5d. disallowed duration (90d) → 400 DURATION_NOT_ALLOWED, no mint', await (async () => {
    const before = counts().grants
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource, duration: '90d' })
    const r = await post('/oauth/authorize/approve', { ...GOOD, duration: '90d', webauthn_token: tok })
    return r.status === 400 && ((await r.json()) as { error_code?: string }).error_code === 'DURATION_NOT_ALLOWED' && counts().grants === before
  })())
  ok('5e. gate bound to a DIFFERENT duration than the body → 412 (approve-what-you-saw)', await (async () => {
    const before = counts().grants
    const tok = mintGateToken({ client_id: GOOD.client_id, scope: GOOD.scope, code_challenge: CHALLENGE, redirect_uri: GOOD.redirect_uri, resource: GOOD.resource, duration: '7d' })
    const r = await post('/oauth/authorize/approve', { ...GOOD, duration: '30d', webauthn_token: tok })
    return r.status === 412 && counts().grants === before
  })())

  http.close()

  // ── 5. fail-closed mounting ──
  {
    delete process.env.WEBAZ_OAUTH
    const { registerOAuthApproveRoutes: reg2 } = await import('../src/pwa/routes/oauth-approve.js')
    const app2 = express(); app2.use(express.json())
    reg2(app2, { db, auth, generateId: (p: string) => `${p}_x`, consumeGateToken: hp.consumeGateToken, rateLimitOk: () => true })
    const h2 = await new Promise<HttpServer>(r => { const s = app2.listen(0, () => r(s)) })
    const a2 = h2.address(); const b2 = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`
    const r = await fetch(`${b2}/oauth/authorize/approve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k_test' }, body: '{}' })
    ok('5. flag off → 404', r.status === 404)
    h2.close()
  }

  if (fail > 0) { console.error(`\n❌ oauth approve FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth approve: Passkey-gated mint (purpose-bound, single-use) · grant+code atomic · hashed code · SAFE-cap mapping · re-validation · deny cheap · fail-closed\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
