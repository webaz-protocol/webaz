#!/usr/bin/env tsx
/**
 * PR-5 — OpenAI per-tool securitySchemes on the /mcp tools/list WIRE.
 *
 * Reads the RAW HTTP tools/list response (NOT the SDK-client-parsed result, which strips non-standard
 * fields through the strict ToolSchema) — this is exactly what ChatGPT receives. Asserts oauth2 is
 * declared ONLY for the genuinely grant-reachable tools (with the exact safe scopes) and noauth
 * everywhere else — an api_key-only tool must NEVER advertise OAuth (a false recovery promise).
 *
 * Usage: npm run test:mcp-security-schemes
 */
import express from 'express'
import type { Server as HttpServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-secschemes-'))   // hermetic DB (server.js opens $HOME/.webaz)
process.env.WEBAZ_REMOTE_MCP = '1'
delete process.env.WEBAZ_MODE

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

type Scheme = { type: string; scopes?: string[] }

async function main(): Promise<void> {
  const { registerRemoteMcpRoutes } = await import('../src/pwa/routes/mcp-remote.js')
  const app = express(); app.use(express.json())
  registerRemoteMcpRoutes(app, { rateLimitOk: () => true })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const port = typeof addr === 'object' && addr ? addr.port : 0

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const j = await res.json() as { result?: { tools?: Array<{ name: string; securitySchemes?: Scheme[] }> } }
  const tools = j.result?.tools ?? []
  const byName: Record<string, Scheme[] | undefined> = Object.fromEntries(tools.map(t => [t.name, t.securitySchemes]))

  // COARSE OAuth scopes (what the client requests at /oauth/authorize) — NOT internal fine capabilities.
  const OAUTH: Record<string, string[]> = {
    webaz_list_product: ['read', 'list:draft'],
    webaz_get_agent_order: ['read'],
    webaz_connection_status: ['read'],
    webaz_order_action_request: ['order:draft'],
  }
  const API_KEY_ONLY = ['webaz_place_order', 'webaz_update_order', 'webaz_wallet', 'webaz_notifications', 'webaz_default_address']
  const { OAUTH_SCOPES } = await import('../src/pwa/routes/oauth-discovery.js')
  const { OAUTH_SCOPE_CAPABILITIES } = await import('../src/pwa/routes/oauth-approve.js')
  // Derive the forbidden set EXHAUSTIVELY from the authoritative mapping — every fine capability, so a
  // future-added one can never silently leak into securitySchemes.
  const FINE_CAPABILITY_NAMES = [...new Set(Object.values(OAUTH_SCOPE_CAPABILITIES).flat())]

  // The REMOTE wire is the isolated surface: it excludes LOCAL_ONLY tools (webaz_pair), so 41 not 42.
  ok('1. all 42 remote-visible tools carry a non-empty securitySchemes array on the WIRE (webaz_pair local-only hidden, +webaz_connection_status)', tools.length === 42 && tools.every(t => Array.isArray(t.securitySchemes) && t.securitySchemes.length > 0))
  ok('1b. webaz_pair (local-only pairing) is NOT advertised on the remote tools/list', !byName['webaz_pair'])

  for (const [name, scopes] of Object.entries(OAUTH)) {
    const ss = byName[name]
    ok(`2. ${name} → single oauth2 with exact scopes [${scopes.join(',')}]`, !!ss && ss.length === 1 && ss[0].type === 'oauth2' && JSON.stringify(ss[0].scopes) === JSON.stringify(scopes))
  }
  for (const name of API_KEY_ONLY) {
    const ss = byName[name]
    ok(`3. ${name} → noauth ONLY (api_key-only tool never advertises OAuth)`, !!ss && ss.length === 1 && ss[0].type === 'noauth')
  }
  ok('4a. webaz_search (anonymous read) → noauth', byName['webaz_search']?.[0]?.type === 'noauth')
  ok('4b. webaz_info (anonymous read) → noauth', byName['webaz_info']?.[0]?.type === 'noauth')

  const oauthTools = tools.filter(t => (t.securitySchemes ?? []).some(s => s.type === 'oauth2')).map(t => t.name).sort()
  ok('5. EXACTLY the 4 grant-reachable tools advertise oauth2 (no false OAuth anywhere else)',
    JSON.stringify(oauthTools) === JSON.stringify(['webaz_connection_status', 'webaz_get_agent_order', 'webaz_list_product', 'webaz_order_action_request']))

  // PR-6: every advertised oauth2 scope MUST be a coarse OAuth scope the authorize endpoint accepts —
  // else ChatGPT requests it and gets invalid_scope. And a fine internal capability name must NEVER leak
  // into securitySchemes (that was the bug).
  const allOauthScopes = tools.flatMap(t => (t.securitySchemes ?? []).flatMap(s => s.scopes ?? []))
  ok(`7. every oauth2 scope is a subset of OAUTH_SCOPES [${OAUTH_SCOPES.join(',')}] (authorize accepts it)`,
    allOauthScopes.length > 0 && allOauthScopes.every(s => (OAUTH_SCOPES as readonly string[]).includes(s)))
  const wireStr = JSON.stringify(tools.map(t => t.securitySchemes))
  ok('8. NO fine grant-capability name appears anywhere in securitySchemes (coarse vocabulary only)',
    FINE_CAPABILITY_NAMES.every(cap => !wireStr.includes(cap)))

  // Every tool that is NOT one of the 3 must be EXACTLY [{type:'noauth'}] — no stray/bogus scheme
  // (e.g. [{type:'bogus'}]) may slip through the "non-empty array" check in assertion 1.
  let noauthExact = true
  for (const t of tools) {
    if (OAUTH[t.name]) continue
    const ss = t.securitySchemes
    if (!(Array.isArray(ss) && ss.length === 1 && ss[0].type === 'noauth' && ss[0].scopes === undefined)) noauthExact = false
  }
  ok('6. every non-grant-reachable tool is EXACTLY one {type:noauth} (no stray/bogus scheme)', noauthExact)

  http.close()
  if (fail > 0) { console.error(`\n❌ mcp securitySchemes FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ mcp securitySchemes: 42/42 on remote wire (webaz_pair hidden, +connection_status) · oauth2 ONLY for the 4 grant-reachable (exact scopes) · noauth everywhere else (no false OAuth on api_key-only)\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
