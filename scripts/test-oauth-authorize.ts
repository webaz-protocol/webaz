#!/usr/bin/env tsx
/**
 * RFC-023 PR-2a test — /authorize request validation + endpoint (mints nothing).
 *
 * Pure-function coverage of the security surface (PKCE-S256-required, client allowlist, redirect
 * exact-match, SAFE-scope-only, resource binding, open-redirect refusal) + a real express route
 * asserting fail-closed mounting, the SPA hand-off on success, and the redirectable-vs-error-page
 * split.
 *
 * Usage: npm run test:oauth-authorize
 */
import express from 'express'
import Database from 'better-sqlite3'
import type { Server as HttpServer } from 'node:http'
import { validateAuthorizeRequest, type OAuthClient } from '../src/pwa/routes/oauth-authorize.js'
import { verifiedConnectorLabel } from '../src/pwa/routes/oauth-verified-connectors.js'
import { initOAuthSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'

// RFC-024: the GET /authorize route now resolves clients via await oauthClients() (DB seam).
// Point the seam at a fresh oauth_clients-bearing DB; the dev client comes from WEBAZ_OAUTH_DEV_CLIENT.
{ const d = new Database(':memory:'); initOAuthSchema(d); setSeamDb(d) }

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

const CLIENTS: OAuthClient[] = [{ client_id: 'c1', name: 'Client One', redirect_uris: ['https://c1.example/cb'] }]
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' // valid 43-char base64url
const good: Record<string, unknown> = {
  client_id: 'c1', redirect_uri: 'https://c1.example/cb', response_type: 'code',
  scope: 'read order:draft', code_challenge: CHALLENGE, code_challenge_method: 'S256',
  resource: 'https://webaz.xyz/mcp', state: 'xyz',
}
const v = (over: Record<string, unknown>) => validateAuthorizeRequest({ ...good, ...over }, CLIENTS)

// ── happy path ──
{
  const r = v({})
  ok('1a. valid request → ok', r.ok === true)
  if (r.ok) {
    ok('1b. scopes parsed', JSON.stringify(r.scopes) === '["read","order:draft"]')
    ok('1c. state echoed', r.state === 'xyz')
    ok('1d. resource pinned', r.resource === 'https://webaz.xyz/mcp')
  }
}
// ── client identity / open-redirect refusal (NON-redirectable) ──
ok('2a. unknown client → non-redirectable invalid_client', (() => { const r = v({ client_id: 'nope' }); return !r.ok && r.redirectable === false && r.error === 'invalid_client' })())
ok('2b. missing client → non-redirectable', (() => { const r = v({ client_id: undefined }); return !r.ok && r.redirectable === false })())
ok('2c. unregistered redirect_uri → non-redirectable (NO open redirect)', (() => { const r = v({ redirect_uri: 'https://evil.example/cb' }); return !r.ok && r.redirectable === false })())
ok('2d. redirect_uri must be EXACT (no trailing slash tolerance)', (() => { const r = v({ redirect_uri: 'https://c1.example/cb/' }); return !r.ok && r.redirectable === false })())
// ── redirectable errors (redirect_uri already proven allowlisted) ──
ok('3a. wrong response_type → redirectable unsupported_response_type', (() => { const r = v({ response_type: 'token' }); return !r.ok && r.redirectable === true && r.error === 'unsupported_response_type' })())
ok('3b. missing PKCE → redirectable invalid_request (I-4)', (() => { const r = v({ code_challenge: undefined, code_challenge_method: undefined }); return !r.ok && r.redirectable === true && r.error === 'invalid_request' })())
ok('3c. PKCE plain REJECTED (S256 only, I-4)', (() => { const r = v({ code_challenge_method: 'plain' }); return !r.ok && r.error === 'invalid_request' })())
ok('3d. malformed code_challenge rejected', (() => { const r = v({ code_challenge: 'too-short' }); return !r.ok && r.error === 'invalid_request' })())
ok('3e. wrong resource → invalid_target (I-3/RFC 8707)', (() => { const r = v({ resource: 'https://webaz.xyz/other' }); return !r.ok && r.error === 'invalid_target' })())
ok('3f. missing resource → invalid_target', (() => { const r = v({ resource: undefined }); return !r.ok && r.error === 'invalid_target' })())
ok('3g. unknown scope token → invalid_scope (T8, SAFE-only)', (() => { const r = v({ scope: 'read admin' }); return !r.ok && r.error === 'invalid_scope' })())
ok('3h. RISK-shaped scope rejected (not in SAFE set)', (() => { const r = v({ scope: 'order:execute' }); return !r.ok && r.error === 'invalid_scope' })())
ok('3i. empty scope → invalid_scope', (() => { const r = v({ scope: undefined }); return !r.ok && r.error === 'invalid_scope' })())
ok('3j. redirectable errors carry redirect_uri + state', (() => { const r = v({ response_type: 'x' }); return !r.ok && r.redirectable === true && r.redirect_uri === 'https://c1.example/cb' && r.state === 'xyz' })())

async function boot(env: Record<string, string | undefined>): Promise<{ base: string; http: HttpServer }> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, val] of Object.entries(env)) { saved[k] = process.env[k]; if (val === undefined) delete process.env[k]; else process.env[k] = val }
  const { registerOAuthAuthorizeRoutes } = await import('../src/pwa/routes/oauth-authorize.js')
  const app = express(); registerOAuthAuthorizeRoutes(app)
  for (const [k, val] of Object.entries(saved)) { if (val === undefined) delete process.env[k]; else process.env[k] = val }
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, http }
}

function qs(over: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    client_id: 'webaz-dev-client', redirect_uri: 'http://localhost:8787/callback', response_type: 'code',
    scope: 'read', code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: 'https://webaz.xyz/mcp', ...over,
  })
  return p.toString()
}

async function main() {
  // The dev client is resolved at REQUEST time (oauthClients() reads env per-request), so it must
  // stay set for the whole flag-on section — not just at mount. Set it directly, clean up at the end.
  process.env.WEBAZ_OAUTH_DEV_CLIENT = '1'
  // flag off → 404
  { const { base, http } = await boot({ WEBAZ_OAUTH: undefined }); const r = await fetch(`${base}/oauth/authorize?${qs()}`, { redirect: 'manual' }); ok('4a. flag off → 404', r.status === 404); http.close() }
  // sandbox → refuse
  { const { base, http } = await boot({ WEBAZ_OAUTH: '1', WEBAZ_MODE: 'sandbox' }); const r = await fetch(`${base}/oauth/authorize?${qs()}`, { redirect: 'manual' }); ok('4b. sandbox → 404 (refuse mount)', r.status === 404); http.close() }
  // flag on
  const { base, http } = await boot({ WEBAZ_OAUTH: '1', WEBAZ_MODE: undefined })
  {
    const r = await fetch(`${base}/oauth/authorize?${qs({ state: 's1' })}`, { redirect: 'manual' })
    const loc = r.headers.get('location') || ''
    ok('4c. valid → 302 SPA consent hand-off', r.status === 302 && loc.startsWith('/#oauth-consent?'))
    ok('4d. hand-off carries validated params + state', loc.includes('client_id=webaz-dev-client') && loc.includes('state=s1') && loc.includes('code_challenge='))
    ok('4e. no-store on authorize', (r.headers.get('cache-control') || '').includes('no-store'))
  }
  {
    const r = await fetch(`${base}/oauth/authorize?${qs({ client_id: 'ghost' })}`, { redirect: 'manual' })
    ok('4f. bad client → 400 error page, NO redirect', r.status === 400 && (r.headers.get('content-type') || '').includes('text/html') && !r.headers.get('location'))
  }
  {
    const r = await fetch(`${base}/oauth/authorize?${qs({ scope: 'read admin', state: 's2' })}`, { redirect: 'manual' })
    const loc = r.headers.get('location') || ''
    ok('4g. bad scope (valid client) → 302 back to redirect_uri with error', r.status === 302 && loc.startsWith('http://localhost:8787/callback?') && loc.includes('error=invalid_scope') && loc.includes('state=s2'))
  }
  {
    const r = await fetch(`${base}/oauth/authorize?${qs({ redirect_uri: 'http://evil/cb' })}`, { redirect: 'manual' })
    ok('4h. unregistered redirect_uri → 400, NO redirect to attacker', r.status === 400 && !r.headers.get('location'))
  }
  http.close()
  delete process.env.WEBAZ_OAUTH_DEV_CLIENT

  // ── 5. verifiedConnectorLabel — badge is trustworthy iff EVERY redirect_uri is one vendor's host ──
  ok('5a. exact official host → vendor label', verifiedConnectorLabel(['https://claude.ai/cb']) === 'Claude (Anthropic)')
  ok('5b. subdomain of official host → vendor label', verifiedConnectorLabel(['https://auth.claude.ai/oauth/cb']) === 'Claude (Anthropic)')
  ok('5c. case-insensitive host', verifiedConnectorLabel(['https://CLAUDE.AI/cb']) === 'Claude (Anthropic)')
  ok('5d. ChatGPT host', verifiedConnectorLabel(['https://chatgpt.com/cb']) === 'ChatGPT (OpenAI)')
  ok('5e. all uris same vendor → label', verifiedConnectorLabel(['https://claude.ai/a', 'https://claude.com/b']) === 'Claude (Anthropic)')
  // ★ security-critical negatives
  ok('5f. lookalike claude.ai.evil.com → NULL (no suffix-substring bypass)', verifiedConnectorLabel(['https://claude.ai.evil.com/cb']) === null)
  ok('5g. official + attacker host mixed → NULL (attacker host could receive the code)', verifiedConnectorLabel(['https://claude.ai/cb', 'https://evil.example/cb']) === null)
  ok('5h. two different vendors → NULL', verifiedConnectorLabel(['https://claude.ai/cb', 'https://chatgpt.com/cb']) === null)
  ok('5i. non-allowlisted host → NULL', verifiedConnectorLabel(['https://random.example/cb']) === null)
  ok('5j. loopback dev client → NULL (not a connector)', verifiedConnectorLabel(['http://localhost:8787/cb']) === null)
  ok('5k. empty list → NULL', verifiedConnectorLabel([]) === null)
  ok('5l. malformed uri anywhere → NULL', verifiedConnectorLabel(['https://claude.ai/cb', 'not a url']) === null)

  if (fail > 0) { console.error(`\n❌ oauth authorize FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth authorize: PKCE-S256-required · client allowlist · redirect exact-match (no open redirect) · SAFE-scope-only · resource-bound · fail-closed · SPA hand-off\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
