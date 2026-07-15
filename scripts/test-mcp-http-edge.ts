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

  const post = async (body: unknown, opts: { origin?: string; bearer?: string } = {}): Promise<{ status: number; wwwAuth: string; body: Record<string, unknown> }> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (opts.origin !== undefined) headers.origin = opts.origin
    if (opts.bearer) headers.authorization = 'Bearer ' + opts.bearer
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
    const respBody = await res.json().catch(() => ({})) as Record<string, unknown>
    return { status: res.status, wwwAuth: res.headers.get('www-authenticate') || '', body: respBody }
  }
  const PUBLIC_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'webaz_search', arguments: {} } }

  // ── B. Origin validation ──
  ok('B1. no Origin (server-to-server) → allowed (tools/list 200)', (await post(TOOLS_LIST)).status === 200)
  ok('B2. allowlisted Origin webaz.xyz → allowed', (await post(TOOLS_LIST, { origin: 'https://webaz.xyz' })).status === 200)
  ok('B3. allowlisted Origin chatgpt.com → allowed', (await post(TOOLS_LIST, { origin: 'https://chatgpt.com' })).status === 200)
  ok('B4. hostile Origin → 403', (await post(TOOLS_LIST, { origin: 'https://evil.example' })).status === 403)
  ok('B5. malformed Origin → 403', (await post(TOOLS_LIST, { origin: 'not-a-url' })).status === 403)
  ok('B6. suffix-lookalike Origin (webaz.xyz.evil.com) → 403 (exact match only)', (await post(TOOLS_LIST, { origin: 'https://webaz.xyz.evil.com' })).status === 403)
  ok('B7. Origin guard applies to tools/call too (hostile → 403)', (await post(AGENT_ORDER_CALL, { origin: 'https://evil.example', bearer: seedOAuth() })).status === 403)
  const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
  ok('B8. Origin guard applies to initialize too (hostile → 403)', (await post(INIT, { origin: 'https://evil.example' })).status === 403)
  {
    process.env.WEBAZ_MCP_ALLOWED_ORIGINS = 'https://cursor.com'
    ok('B9. configured allowlist entry (https://cursor.com) → allowed', (await post(TOOLS_LIST, { origin: 'https://cursor.com' })).status === 200)
    process.env.WEBAZ_MCP_ALLOWED_ORIGINS = 'not-a-url'   // malformed config must NOT allowlist a malformed Origin
    ok('B10. malformed configured entry does not allowlist a malformed Origin → 403', (await post(TOOLS_LIST, { origin: 'not-a-url' })).status === 403)
    delete process.env.WEBAZ_MCP_ALLOWED_ORIGINS
  }
  {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'https://webaz.xyz' }, body: JSON.stringify(TOOLS_LIST) })
    const acHeaders = [...res.headers.keys()].filter(k => k.toLowerCase().startsWith('access-control-'))
    ok('B11. NO Access-Control-* response header at all (no-CORS posture intact)', acHeaders.length === 0)
  }
  ok('B12. Origin "null" (opaque/sandboxed origin) → 403', (await post(TOOLS_LIST, { origin: 'null' })).status === 403)
  ok('B13. correct host with an unapproved port → 403 (exact match)', (await post(TOOLS_LIST, { origin: 'https://webaz.xyz:8443' })).status === 403)
  {
    const gHostile = await fetch(`${base}/mcp`, { method: 'GET', headers: { origin: 'https://evil.example' } })
    ok('B14. GET /mcp hostile Origin → 403 (Origin guard on all methods)', gHostile.status === 403)
    const gPlain = await fetch(`${base}/mcp`, { method: 'GET' })
    ok('B15. GET /mcp no Origin → 405 (stateless; Origin allowed, method not)', gPlain.status === 405)
    const dHostile = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })
    ok('B16. DELETE /mcp hostile Origin → 403', dHostile.status === 403)
  }

  // ── A. bearer / OAuth token validity ──
  ok('A1. anonymous auth-only tool → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A2. unknown oat_ → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: 'oat_' + 'f'.repeat(32) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A3. expired oat_ → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ tokExp: past }) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A4. revoked oat_ → 401 + challenge', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ tokRevoked: past }) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A5. wrong-audience oat_ → 401 + challenge (re-auth, not 403)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ tokAud: 'https://webaz.xyz/other' }) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A6. valid oat_, INSUFFICIENT scope → 403 + insufficient_scope + required scope (scope-expansion, not re-login)', await (async () => {
    const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ caps: ['seller_products_read'] }) })
    const data = (r.body?.error as { data?: { error?: string; required_scope?: string } } | undefined)?.data
    return r.status === 403
      && r.wwwAuth.includes('error="insufficient_scope"') && r.wwwAuth.includes('scope="seller_orders_read_minimal"')
      && data?.error === 'insufficient_scope' && data?.required_scope === 'seller_orders_read_minimal'
  })())
  ok('A7. valid oat_ + sufficient scope → passes edge (not 401/403)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ caps: ['seller_orders_read_minimal'] }) }); return r.status !== 401 && r.status !== 403 })())
  // PR-4: a PRESENTED invalid oat_ on ANY tool call (incl. public) → 401 — a bad credential is not silently downgraded to anonymous.
  ok('A11. invalid oat_ on a PUBLIC tool call (webaz_search) → 401 (bad credential not ignored)', await (async () => { const r = await post(PUBLIC_CALL, { bearer: 'oat_' + 'f'.repeat(32) }); return r.status === 401 && r.wwwAuth.includes(CHALLENGE) })())
  ok('A12. bad oat_ on tools/list (handshake, not a tool call) → NOT 401 (client setup stays reachable)', await (async () => { const r = await post(TOOLS_LIST, { bearer: 'oat_' + 'f'.repeat(32) }); return r.status !== 401 })())
  ok('A13. valid oat_ on a PUBLIC tool call → passes edge (identity ok, no scope needed)', await (async () => { const r = await post(PUBLIC_CALL, { bearer: seedOAuth() }); return r.status !== 401 && r.status !== 403 })())
  // _meta["mcp/www_authenticate"] mirrors the WWW-Authenticate header INTO the JSON-RPC body — the OpenAI
  // Apps SDK reads the challenge from _meta, not the HTTP header (belt-and-suspenders with the header above).
  const metaChallenge = (b: Record<string, unknown>): string => String((b._meta as Record<string, unknown> | undefined)?.['mcp/www_authenticate'] ?? '')
  // Each also asserts _meta EXACTLY equals the WWW-Authenticate header — proving no drift, not just substring presence.
  ok('A14. anonymous auth-only 401: _meta["mcp/www_authenticate"] === WWW-Authenticate header (has challenge)', await (async () => { const r = await post(AGENT_ORDER_CALL); return r.status === 401 && metaChallenge(r.body) === r.wwwAuth && r.wwwAuth.includes(CHALLENGE) })())
  ok('A15. invalid-oat_ 401: _meta === header (error="invalid_token")', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: 'oat_' + 'f'.repeat(32) }); return r.status === 401 && metaChallenge(r.body) === r.wwwAuth && r.wwwAuth.includes('error="invalid_token"') })())
  ok('A16. insufficient_scope 403: _meta === header (error="insufficient_scope" + required scope)', await (async () => { const r = await post(AGENT_ORDER_CALL, { bearer: seedOAuth({ caps: ['seller_products_read'] }) }); return r.status === 403 && metaChallenge(r.body) === r.wwwAuth && r.wwwAuth.includes('error="insufficient_scope"') && r.wwwAuth.includes('scope="seller_orders_read_minimal"') })())
  // Codex PR-4 Low — explicit non-tool-call reachability + anonymous public-call success (edge never over-reaches)
  ok('A17. invalid oat_ on initialize (not a tool call) → NOT 401 (handshake stays reachable)', await (async () => { const r = await post(INIT, { bearer: 'oat_' + 'f'.repeat(32) }); return r.status !== 401 })())
  ok('A18. anonymous webaz_search (public tool call, no bearer) → 200 (anonymous read fully unaffected)', (await post(PUBLIC_CALL)).status === 200)
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
