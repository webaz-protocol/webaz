#!/usr/bin/env tsx
/**
 * RFC-023 PR-1 test — OAuth schema + discovery metadata (foundation, no auth logic).
 *
 * Behavioral: real express app + fresh in-memory DB. Asserts the 3 OAuth tables are created by the
 * schema helper, the two well-known metadata docs serve the locked-decision shape (S256-only, no
 * refresh, public clients, aud-bound resource), and the whole surface is fail-closed behind
 * WEBAZ_OAUTH=1 (+ sandbox refusal).
 *
 * Usage: npm run test:oauth-discovery
 */
import { readFileSync } from 'node:fs'
import express from 'express'
import Database from 'better-sqlite3'
import type { Server as HttpServer } from 'node:http'
import { initOAuthSchema } from '../src/runtime/webaz-schema-helpers.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

const ROUTE = readFileSync('src/pwa/routes/oauth-discovery.ts', 'utf8')
const HELPERS = readFileSync('src/runtime/webaz-schema-helpers.ts', 'utf8')
const SERVER = readFileSync('src/pwa/server.ts', 'utf8')

// ── 1. schema helper creates the 3 tables (fresh DB) ──
const db = new Database(':memory:')
initOAuthSchema(db)
const tbls = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: { name: string }) => r.name))
ok('1a. oauth_clients created', tbls.has('oauth_clients'))
ok('1b. oauth_auth_codes created', tbls.has('oauth_auth_codes'))
ok('1c. oauth_access_tokens created', tbls.has('oauth_access_tokens'))
// secrets hashed (columns are *_hash), token references an RFC-020 grant (I-5)
const tokCols = db.prepare('PRAGMA table_info(oauth_access_tokens)').all().map((c: { name: string }) => c.name)
ok('1d. access-token stored HASHED (token_hash), never plaintext', tokCols.includes('token_hash') && !tokCols.includes('token'))
ok('1e. token references an RFC-020 grant + aud (I-3/I-5)', tokCols.includes('grant_id') && tokCols.includes('aud') && tokCols.includes('revoked_at'))
const codeCols = db.prepare('PRAGMA table_info(oauth_auth_codes)').all().map((c: { name: string }) => c.name)
ok('1f. auth code stores PKCE challenge + single-use + resource (I-3/I-4)', codeCols.includes('code_challenge') && codeCols.includes('consumed_at') && codeCols.includes('resource'))
ok('1g. initOAuthSchema idempotent (2nd call no-throw)', (() => { try { initOAuthSchema(db); return true } catch { return false } })())
db.close()

async function boot(env: Record<string, string | undefined>): Promise<{ base: string; http: HttpServer }> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const { registerOAuthDiscoveryRoutes } = await import('../src/pwa/routes/oauth-discovery.js')
  const app = express(); app.use(express.json()); registerOAuthDiscoveryRoutes(app)
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, http }
}

async function main() {
  // ── 2. fail-closed: flag off → 404 ──
  {
    const { base, http } = await boot({ WEBAZ_OAUTH: undefined, WEBAZ_MODE: undefined })
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
    ok('2. flag off → discovery absent (404)', r.status === 404)
    http.close()
  }
  // ── 3. sandbox → refuses to mount ──
  {
    const { base, http } = await boot({ WEBAZ_OAUTH: '1', WEBAZ_MODE: 'sandbox' })
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
    ok('3. sandbox → refuses to mount (404)', r.status === 404)
    http.close()
  }
  // ── 4. flag on → metadata shape (locked decisions) ──
  const { base, http } = await boot({ WEBAZ_OAUTH: '1', WEBAZ_MODE: undefined })
  {
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>
    ok('4a. AS metadata: PKCE S256 ONLY (I-4)', JSON.stringify(as.code_challenge_methods_supported) === '["S256"]')
    ok('4b. AS metadata: authorization_code only, no refresh (D2)', JSON.stringify(as.grant_types_supported) === '["authorization_code"]')
    ok('4c. AS metadata: public clients, none auth (D4)', JSON.stringify(as.token_endpoint_auth_methods_supported) === '["none"]')
    ok('4d. AS metadata: resource indicators supported (RFC 8707 / I-3)', as.resource_indicators_supported === true)
    ok('4e. AS metadata: authorize + token endpoints', typeof as.authorization_endpoint === 'string' && typeof as.token_endpoint === 'string')
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as Record<string, unknown>
    ok('4f. protected-resource: aud-bound resource = /mcp (I-3)', pr.resource === 'https://webaz.xyz/mcp')
    ok('4g. protected-resource: names the AS', Array.isArray(pr.authorization_servers) && (pr.authorization_servers as string[])[0] === 'https://webaz.xyz')
    // RFC 9728 §3.1: resource carries a path (/mcp) → strict client derives the suffixed well-known
    const prPath = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    const prPathJson = prPath.headers.get('content-type')?.includes('json') ? await prPath.json() as Record<string, unknown> : null
    ok('4h. protected-resource served at path-suffixed URI (RFC 9728 §3.1)', prPath.status === 200 && prPathJson?.resource === 'https://webaz.xyz/mcp')
  }
  http.close()

  // ── 5. source guards ──
  ok('5a. schema helper auto-wired (exported init* → composition root)', has(HELPERS, 'export function initOAuthSchema'))
  ok('5b. server registers oauth discovery (fail-closed)', has(SERVER, 'registerOAuthDiscoveryRoutes(app)'))
  ok('5c. route fail-closed on flag + sandbox refuse', has(ROUTE, "process.env.WEBAZ_OAUTH !== '1'") && has(ROUTE, "WEBAZ_MODE === 'sandbox'"))

  if (fail > 0) { console.error(`\n❌ oauth discovery FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth discovery: 3 tables (hashed secrets, grant-linked) + RFC 9728/8414 metadata (S256-only, no-refresh, aud-bound) + fail-closed flag/sandbox\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
