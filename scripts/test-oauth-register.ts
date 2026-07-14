#!/usr/bin/env tsx
/**
 * RFC-024 test — Dynamic Client Registration (POST /oauth/register) + oauth_clients table wiring.
 *
 * Behavioral: real express app + fresh in-memory DB (real initOAuthSchema incl. the new columns),
 * the RFC-016 seam pointed at it. Covers registration validation (redirect_uri policy, public-client
 * only, limits), that a registered client is stored unverified + inert, that oauthClients() reads it
 * back and a registered client can then pass validateAuthorizeRequest, and fail-closed mounting.
 *
 * Usage: npm run test:oauth-register
 */
import express from 'express'
import Database from 'better-sqlite3'
import type { Server as HttpServer } from 'node:http'
import { initOAuthSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { isRegisterableRedirectUri, oauthClients, validateAuthorizeRequest } from '../src/pwa/routes/oauth-authorize.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// ── 1. redirect_uri policy (pure, T3) ──
ok('1a. https accepted', isRegisterableRedirectUri('https://claude.ai/cb'))
ok('1b. http loopback accepted (any port)', isRegisterableRedirectUri('http://localhost:53682/cb') && isRegisterableRedirectUri('http://127.0.0.1:9999/x'))
ok('1c. http non-loopback REJECTED (no cleartext to a public host)', !isRegisterableRedirectUri('http://evil.example/cb'))
ok('1d. fragment REJECTED', !isRegisterableRedirectUri('https://c.example/cb#frag'))
ok('1e. userinfo REJECTED', !isRegisterableRedirectUri('https://user:pw@c.example/cb'))
ok('1f. custom scheme REJECTED (v1)', !isRegisterableRedirectUri('cursor://cb') && !isRegisterableRedirectUri('javascript:alert(1)'))
ok('1g. garbage / empty / overlong REJECTED', !isRegisterableRedirectUri('not a url') && !isRegisterableRedirectUri('') && !isRegisterableRedirectUri('https://c.example/' + 'a'.repeat(2001)))
// Codex P2a: wildcard / malformed https host must be rejected (was accepted before HOST_RE)
ok('1h. wildcard https host REJECTED', !isRegisterableRedirectUri('https://*.evil.example/cb') && !isRegisterableRedirectUri('https://foo.*.example/cb'))
ok('1i. valid IPv4 / bracketed IPv6 loopback accepted', isRegisterableRedirectUri('http://[::1]:9/cb') && isRegisterableRedirectUri('https://1.2.3.4/cb'))
ok('1j. subdomain + hyphen hosts accepted (normal DNS)', isRegisterableRedirectUri('https://app.my-connector.example/cb'))
// Codex round-2: raw control chars (tab/newline/CR) that the URL parser would strip must be rejected up-front
ok('1k. raw tab/newline/CR in host REJECTED (no parser-strip bypass)', !isRegisterableRedirectUri('https://exa\tmple.com/cb') && !isRegisterableRedirectUri('https://exa\nmple.com/cb') && !isRegisterableRedirectUri('https://example.com/cb\r'))
// Codex round-3: IDNA-ignored Unicode (BOM/ZWSP/soft-hyphen/word-joiner/variation-selector) also
// normalizes away in the host → ASCII-only guard closes the whole class.
ok('1k2. IDNA-ignored Unicode in host REJECTED (ASCII-only)', ['﻿', '​', '­', '⁠', '️', ' '].every(c => !isRegisterableRedirectUri(`https://exa${c}mple.com/cb`)))
ok('1k3. any non-ASCII redirect_uri REJECTED (use punycode / %-encoding)', !isRegisterableRedirectUri('https://münchen.example/cb') && !isRegisterableRedirectUri('https://example.com/café'))
ok('1k4. punycode + %-encoded PATH still accepted', isRegisterableRedirectUri('https://xn--mnchen-3ya.example/cb') && isRegisterableRedirectUri('https://example.com/caf%C3%A9?q=1'))
// Codex round-4: percent-encoded HOST bytes normalize away (%65→e, %2e→.) → reject % in the authority.
ok('1k5. percent-encoded host REJECTED', !isRegisterableRedirectUri('https://%65xample.com/cb') && !isRegisterableRedirectUri('https://exa%6dple.com/cb') && !isRegisterableRedirectUri('https://example%2ecom/cb'))
ok('1k6. %-encoding in path/query still fine (only authority is constrained)', isRegisterableRedirectUri('https://example.com/a%2fb?x=%20y'))
ok('1l. raw space + NUL + DEL REJECTED', !isRegisterableRedirectUri('https://exa mple.com/cb') && !isRegisterableRedirectUri('https://example.com/\u0000') && !isRegisterableRedirectUri('https://example.com/\u007f'))

const db = new Database(':memory:')
initOAuthSchema(db)
setSeamDb(db)

async function boot(env: Record<string, string | undefined>): Promise<{ base: string; http: HttpServer }> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const { registerOAuthRegisterRoutes } = await import('../src/pwa/routes/oauth-register.js')
  const app = express(); app.use(express.json()); registerOAuthRegisterRoutes(app, { rateLimitOk: () => true })
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, http }
}
const reg = (base: string, body: unknown) => fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function main() {
  // ── 2. fail-closed ──
  { const { base, http } = await boot({ WEBAZ_OAUTH: undefined }); ok('2a. flag off → 404', (await reg(base, {})).status === 404); http.close() }
  { const { base, http } = await boot({ WEBAZ_OAUTH: '1', WEBAZ_MODE: 'sandbox' }); ok('2b. sandbox → 404 (refuse mount)', (await reg(base, {})).status === 404); http.close() }

  const { base, http } = await boot({ WEBAZ_OAUTH: '1', WEBAZ_MODE: undefined })

  // ── 3. happy path ──
  {
    const r = await reg(base, { client_name: 'Claude', redirect_uris: ['http://localhost:53682/cb'] })
    const j = await r.json() as Record<string, unknown>
    ok('3a. register → 201 + client_id (oac_client_…)', r.status === 201 && typeof j.client_id === 'string' && (j.client_id as string).startsWith('oac_client_'))
    ok('3b. public client, no secret returned', j.token_endpoint_auth_method === 'none' && j.client_secret === undefined)
    ok('3c. echoes redirect_uris + grant/response types', JSON.stringify(j.redirect_uris) === JSON.stringify(['http://localhost:53682/cb']) && JSON.stringify(j.grant_types) === '["authorization_code"]')
    ok('3d. no-store header', (r.headers.get('cache-control') || '').includes('no-store'))
    // stored unverified + inert
    const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(j.client_id) as Record<string, unknown>
    ok('3e. stored status=active but verified=0 (self-declared / unverified)', row.status === 'active' && row.verified === 0)
    ok('3f. registering IP hashed, not stored raw', typeof row.created_ip_hash === 'string' && !String(row.created_ip_hash).includes('.'))
    ok('3g. NOT yet consent-authorized (last_authorized_at NULL → sweepable)', row.last_authorized_at === null)
    // oauthClients() reads it back, and it can now pass authorize validation
    const clients = await oauthClients()
    const c = clients.find(x => x.client_id === j.client_id)
    ok('3h. oauthClients() reads the DB row back', !!c && c.verified === false && c.redirect_uris.includes('http://localhost:53682/cb'))
    const CH = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    const v = validateAuthorizeRequest({ client_id: j.client_id, redirect_uri: 'http://localhost:53682/cb', response_type: 'code', scope: 'read', code_challenge: CH, code_challenge_method: 'S256', resource: 'https://webaz.xyz/mcp' }, clients)
    ok('3i. a registered client passes /authorize validation (end to end)', v.ok === true)
  }
  // ── 4. validation (T3 / public-client / limits) ──
  ok('4a. missing redirect_uris → 400 invalid_redirect_uri', (await (await reg(base, { client_name: 'x' })).json() as { error: string }).error === 'invalid_redirect_uri')
  ok('4b. non-loopback http rejected', (await reg(base, { redirect_uris: ['http://evil.example/cb'] })).status === 400)
  ok('4c. >5 redirect_uris rejected', (await reg(base, { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://c.example/${i}`) })).status === 400)
  ok('4d. confidential client (auth_method != none) rejected', (await (await reg(base, { redirect_uris: ['https://c.example/cb'], token_endpoint_auth_method: 'client_secret_basic' })).json() as { error: string }).error === 'invalid_client_metadata')
  ok('4e. wrong grant_types rejected', (await reg(base, { redirect_uris: ['https://c.example/cb'], grant_types: ['implicit'] })).status === 400)
  ok('4f. one bad uri in the array fails the whole registration', (await reg(base, { redirect_uris: ['https://ok.example/cb', 'http://evil.example/cb'] })).status === 400)
  ok('4g. wildcard host in a registration request → 400', (await reg(base, { redirect_uris: ['https://*.evil.example/cb'] })).status === 400)
  // ── 5. missing client_name defaults, still registers ──
  {
    const r = await reg(base, { redirect_uris: ['https://ok.example/cb'] })
    const j = await r.json() as Record<string, unknown>
    ok('5a. no client_name → defaults, still 201', r.status === 201 && j.client_name === 'Unnamed client')
  }
  http.close()

  // ── 5b. Codex P2b: a GLOBAL cap bounds total row growth even if per-IP is bypassed ──
  {
    // rateLimitOk that always allows the per-IP key but denies the global key → registration blocked
    const { registerOAuthRegisterRoutes } = await import('../src/pwa/routes/oauth-register.js')
    const saved = process.env.WEBAZ_OAUTH; process.env.WEBAZ_OAUTH = '1'
    const app2 = express(); app2.use(express.json())
    registerOAuthRegisterRoutes(app2, { rateLimitOk: (k: string) => !k.includes(':global') })
    if (saved === undefined) delete process.env.WEBAZ_OAUTH; else process.env.WEBAZ_OAUTH = saved
    const h2 = await new Promise<HttpServer>(r => { const s = app2.listen(0, () => r(s)) })
    const a2 = h2.address(); const b2 = `http://127.0.0.1:${typeof a2 === 'object' && a2 ? a2.port : 0}`
    const r = await reg(b2, { redirect_uris: ['https://ok.example/cb'] })
    ok('5b. global rate cap blocks registration even when per-IP allows (anti IP-rotation)', r.status === 429)
    h2.close()
  }

  // ── 6. source guards ──
  ok('6a. registration_endpoint advertised in AS metadata', readFileSync('src/pwa/routes/oauth-discovery.ts', 'utf8').includes('registration_endpoint'))
  ok('6b. server registers the route (fail-closed dep)', readFileSync('src/pwa/server.ts', 'utf8').includes('registerOAuthRegisterRoutes(app'))

  if (fail > 0) { console.error(`\n❌ oauth register FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth register (RFC-024 DCR): redirect policy (https/loopback only) · public-client only · unverified+inert row · IP hashed · oauthClients() DB-backed · registered client passes authorize · fail-closed\n  ✅ pass ${pass}`)
}
import { readFileSync } from 'node:fs'
main().catch(e => { console.error(e); process.exit(1) })
