#!/usr/bin/env tsx
/**
 * PR-2 — MCP/OAuth HTTP-edge conformance for /mcp (Streamable HTTP).
 *
 * Drives the REAL registered route over HTTP against a seeded seam DB (real oauth_access_tokens +
 * agent_delegation_grants via verifyGrantToken — not stubbed). Asserts the transport-level status/
 * challenge split:
 *   A. bearer — anonymous protected → 401+challenge; invalid/expired/revoked/wrong-aud oat_ →
 *      401+challenge; VALID token, insufficient scope → 403 (no re-login); valid+scoped → passes edge;
 *      api_key & gtk_ semantics untouched.
 *   B. Origin — no Origin (server-to-server) allowed; allowlisted Origin allowed; hostile/malformed → 403;
 *      applies uniformly to initialize/tools/list/tools/call.
 *
 * Usage: npm run test:mcp-http-edge
 */
import express from 'express'
import Database from 'better-sqlite3'
import type { Server as HttpServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { initOAuthSchema, initAgentDelegationGrantsSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerRemoteMcpRoutes } from '../src/pwa/routes/mcp-remote.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const AUD = 'https://webaz.xyz/mcp'
const future = '2099-01-01T00:00:00.000Z'
const past = '2000-01-01T00:00:00.000Z'
const CHALLENGE = 'https://webaz.xyz/.well-known/oauth-protected-resource/mcp'

const db = new Database(':memory:')
initOAuthSchema(db); initAgentDelegationGrantsSchema(db)
db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, permanent_code TEXT, region TEXT)')
db.exec('CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER, reason TEXT)')
setSeamDb(db)
db.prepare("INSERT INTO users (id, api_key, permanent_code, region) VALUES ('usr_h','k_h','PC','SG')").run()

let seq = 0
function seedOAuth(o: { caps?: string[]; tokAud?: string; tokExp?: string; tokRevoked?: string | null } = {}): string {
  const grantId = `grt_o${++seq}`
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(grantId, 'usr_h', 'OAuth', JSON.stringify((o.caps ?? ['seller_orders_read_minimal']).map(c => ({ capability: c }))), null, 0, 'active', future)
  const oat = `oat_${randomBytes(16).toString('hex')}`
  db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?)')
    .run(sha(oat), grantId, 'c', 'read', o.tokAud ?? AUD, o.tokExp ?? future, o.tokRevoked ?? null)
  return oat
}

const AGENT_ORDER_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'webaz_get_agent_order', arguments: { order_id: 'x' } } }
const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

async function main(): Promise<void> {
  process.env.WEBAZ_REMOTE_MCP = '1'
  process.env.WEBAZ_OAUTH = '1'
  delete process.env.WEBAZ_MODE
  process.env.WEBAZ_API_URL = 'http://127.0.0.1:9'   // dead: valid-token dispatch fails fast → 200 tool error (edge already passed)

  const app = express(); app.use(express.json())
  registerRemoteMcpRoutes(app, { rateLimitOk: () => true })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  const base = `http://127.0.0.1:${port}`

  const post = async (body: unknown, opts: { origin?: string; bearer?: string } = {}): Promise<{ status: number; wwwAuth: string }> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (opts.origin !== undefined) headers.origin = opts.origin
    if (opts.bearer) headers.authorization = 'Bearer ' + opts.bearer
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, wwwAuth: res.headers.get('www-authenticate') || '' }
  }

  // ── B. Origin validation ──
  ok('B1. no Origin (server-to-server) → allowed (tools/list 200)', (await post(TOOLS_LIST)).status === 200)
  ok('B2. allowlisted Origin webaz.xyz → allowed', (await post(TOOLS_LIST, { origin: 'https://webaz.xyz' })).status === 200)
  ok('B3. allowlisted Origin chatgpt.com → allowed', (await post(TOOLS_LIST, { origin: 'https://chatgpt.com' })).status === 200)
  ok('B4. hostile Origin → 403', (await post(TOOLS_LIST, { origin: 'https://evil.example' })).status === 403)
  ok('B5. malformed Origin → 403', (await post(TOOLS_LIST, { origin: 'not-a-url' })).status === 403)
  ok('B6. suffix-lookalike Origin (webaz.xyz.evil.com) → 403 (exact match only)', (await post(TOOLS_LIST, { origin: 'https://webaz.xyz.evil.com' })).status === 403)
  ok('B7. Origin guard applies to tools/call too (hostile → 403)', (await post(AGENT_ORDER_CALL, { origin: 'https://evil.example', bearer: seedOAuth() })).status === 403)

  // ── A. bearer / OAuth token validity ──
  ok('A1. anonymous auth-only tool → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A2. unknown oat_ → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: 'oat_' + 'f'.repeat(32) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A3. expired oat_ → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ tokExp: past }) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A4. revoked oat_ → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ tokRevoked: past }) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A5. wrong-audience oat_ → 401 + challenge (re-auth, not 403)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ tokAud: 'https://webaz.xyz/other' }) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A6. valid oat_, INSUFFICIENT scope → 403 (no challenge, no re-login)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ caps: ['seller_products_read'] }) }); return r.status === 403 && r.wwwAuth === '' })())
  ok('A7. valid oat_ + sufficient scope → passes edge (not 401/403)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ caps: ['seller_orders_read_minimal'] }) }); return r.status !== 401 && r.status !== 403 })())
  // A8/A9: gtk_ and api_key are NOT handled by the oat_ edge — must fall through (never edge-401), preserving semantics
  ok('A8. invalid gtk_ on auth-only tool → NOT edge-401 (gtk_ semantics unchanged, falls through)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: 'gtk_' + 'a'.repeat(32) }); return r.status !== 401 })())
  ok('A9. api_key bearer on auth-only tool → NOT edge-401 (api_key semantics unchanged)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: 'k_h' }); return r.status !== 401 })())
  // A10: anonymous READ tool is never gated (I-2)
  ok('A10. anonymous tools/list (no auth) → 200', (await post(TOOLS_LIST)).status === 200)

  http.close()
  if (fail > 0) { console.error(`\n❌ mcp http edge FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ mcp http edge: Origin allowlist (no-Origin/allowed pass · hostile/malformed/lookalike 403) · invalid/expired/revoked/wrong-aud oat_ → 401+challenge · insufficient scope → 403 · valid+scoped passes · gtk_/api_key untouched\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
