#!/usr/bin/env tsx
/**
 * RFC-023 PR-5 test — /mcp 401 WWW-Authenticate challenge + OAuth discovery advertising.
 *
 * Behavioral (real express app + real JSON-RPC over HTTP, fetch spy for webaz.xyz outbound):
 *   - anonymous tools/call on an auth-only tool → 401 + WWW-Authenticate: Bearer resource_metadata="…"
 *     (RFC 9728 pointer) so a compliant MCP client self-starts the OAuth flow;
 *   - I-2 hard invariant: the anonymous READ surface (search / tools/list / initialize) is NEVER challenged;
 *   - any presented Bearer (api_key or oat_) passes through to the tool layer (typed errors live there, PR-4);
 *   - fail-closed: WEBAZ_OAUTH off → no challenge, no header (metadata would 404);
 *   - remoteMcpManifest advertises authentication.oauth (metadata URLs) only when OAuth is live.
 *
 * Usage: npm run test:oauth-mcp-challenge
 */
import { readFileSync } from 'node:fs'
import express from 'express'
import type { Server as HttpServer } from 'node:http'

// 必须在 import mcp-remote(→ L1 server.js)之前:WEBAZ_API_KEY/MODE 在 import 时固化为 module const。
process.env.WEBAZ_API_KEY = 'wz_HOST_ENV_KEY_MUST_NOT_LEAK'
delete process.env.WEBAZ_MODE

// fetch spy:拦截出站 webaz.xyz(工具层 apiCall),不打真网络;进程内 127.0.0.1 请求照常放行。
const _realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as { url?: string })?.url || String(input)
  if (url.includes('webaz.xyz')) return new Response(JSON.stringify({ products: [], found: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  return _realFetch(input as RequestInfo, init)
}) as typeof fetch

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

const ROUTE = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
const METADATA_URL = 'https://webaz.xyz/.well-known/oauth-protected-resource/mcp'
const EXPECTED_CHALLENGE = `Bearer resource_metadata="${METADATA_URL}"`

async function boot(): Promise<{ base: string; http: HttpServer }> {
  process.env.WEBAZ_REMOTE_MCP = '1'
  const { registerRemoteMcpRoutes } = await import('../src/pwa/routes/mcp-remote.js')
  const app = express()
  app.use(express.json())
  registerRemoteMcpRoutes(app, { rateLimitOk: () => true })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address()
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, http }
}

const rpc = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
const call = (base: string, tool: string, headers: Record<string, string> = {}, id: number | string = 7) =>
  rpc(base, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: {} } }, headers)

async function main() {
  const { base, http } = await boot()

  // ── 1. OAuth live:匿名打 auth-only 工具 → 401 挑战(合规客户端自启流)──
  process.env.WEBAZ_OAUTH = '1'
  {
    const r = await call(base, 'webaz_place_order', {}, 42)
    const j = await r.json().catch(() => null) as { error?: { code?: number; message?: string }; id?: unknown } | null
    ok('1a. anonymous place_order → HTTP 401', r.status === 401)
    ok('1b. WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource/mcp" (RFC 9728)', r.headers.get('www-authenticate') === EXPECTED_CHALLENGE)
    ok('1c. JSON-RPC error body + id echoed', !!j?.error?.message && j?.id === 42)
    ok('1d. body names BOTH recovery paths (OAuth + api_key Bearer)', String(j?.error?.message || '').includes('OAuth') && String(j?.error?.message || '').includes('api_key'))
  }
  ok('1e. wallet (personal read) also challenged', (await call(base, 'webaz_wallet')).status === 401)
  ok('1f. grant tool (order_action_request) also challenged', (await call(base, 'webaz_order_action_request')).status === 401)

  // ── 2. I-2:匿名【读】面绝不被挑战 ──
  {
    const r = await call(base, 'webaz_search')
    ok('2a. anonymous search → 200, never challenged (I-2)', r.status === 200 && !r.headers.get('www-authenticate'))
    const l = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ok('2b. anonymous tools/list → 200, no challenge', l.status === 200 && !l.headers.get('www-authenticate'))
    const i = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    ok('2c. anonymous initialize → 200, no challenge (connector handshake unharmed)', i.status === 200 && !i.headers.get('www-authenticate'))
  }

  // ── 3. 任何 Bearer 在场 → 不在 HTTP 层挑战(语义化 error_code 在工具层,PR-4)──
  ok('3a. api_key Bearer → passes to tool layer (no 401 challenge)', (await call(base, 'webaz_place_order', { Authorization: 'Bearer wz_caller_key' })).status === 200)
  ok('3b. oat_ Bearer → passes to tool layer (introspection there, PR-4)', (await call(base, 'webaz_order_action_request', { Authorization: 'Bearer oat_' + 'a'.repeat(32) })).status !== 401)

  // ── 4. fail-closed:WEBAZ_OAUTH off → 行为与 PR-4 前完全一致(无挑战,无头)──
  delete process.env.WEBAZ_OAUTH
  {
    const r = await call(base, 'webaz_place_order')
    ok('4a. flag off → anonymous place_order NOT challenged (tool-layer guidance instead)', r.status === 200 && !r.headers.get('www-authenticate'))
  }
  // sandbox 下 oauthEnabled() 也必须为 false(双保险;挂载层本就拒 sandbox)
  process.env.WEBAZ_OAUTH = '1'; process.env.WEBAZ_MODE = 'sandbox'
  const { oauthEnabled } = await import('../src/pwa/routes/oauth-discovery.js')
  ok('4b. sandbox → oauthEnabled() false (challenge impossible)', oauthEnabled() === false)
  delete process.env.WEBAZ_MODE

  // ── 5. 发现面:manifest 仅在 OAuth live 时公告 authentication.oauth ──
  const { remoteMcpManifest } = await import('../src/pwa/routes/mcp-remote.js')
  {
    process.env.WEBAZ_OAUTH = '1'
    const man = remoteMcpManifest() as { authentication?: { oauth?: { protected_resource_metadata?: string; authorization_server_metadata?: string; flow?: string } } } | null
    const oauth = man?.authentication?.oauth
    ok('5a. OAuth live → manifest authentication.oauth present', !!oauth)
    ok('5b. …with RFC 9728 + RFC 8414 metadata URLs', oauth?.protected_resource_metadata === METADATA_URL && oauth?.authorization_server_metadata === 'https://webaz.xyz/.well-known/oauth-authorization-server')
    ok('5c. …flow text is honest about the human gate (approve_url unchanged)', String(oauth?.flow || '').includes('approve_url'))
    delete process.env.WEBAZ_OAUTH
    const man2 = remoteMcpManifest() as { authentication?: { oauth?: unknown } } | null
    ok('5d. OAuth off → manifest has NO authentication.oauth (不广告 404 面)', !!man2 && man2.authentication !== undefined && !(man2.authentication as Record<string, unknown>).oauth)
  }

  // ── 6. 源码守卫 ──
  ok('6a. challenge sits AFTER rate limit and BEFORE server assembly', ROUTE.indexOf('deps.rateLimitOk(') < ROUTE.indexOf('isAuthOnlyToolCall(req.body)') && ROUTE.indexOf('isAuthOnlyToolCall(req.body)') < ROUTE.indexOf('buildMcpServer({'))
  ok('6b. challenge gated on oauthEnabled() (fail-closed) + no-bearer only', ROUTE.includes('!bearer && oauthEnabled() && isAuthOnlyToolCall'))
  // I-2 结构锚:双模/匿名可用工具绝不许进挑战名单
  for (const t of ['webaz_search', 'webaz_info', 'webaz_contribute', 'webaz_profile', 'webaz_mykey', 'webaz_pair', 'webaz_register', 'webaz_rotate_key', 'webaz_revoke_key']) {
    ok(`6c. AUTH_ONLY_TOOLS excludes dual-mode/anonymous-capable ${t} (I-2)`, !new RegExp(`AUTH_ONLY_TOOLS = new Set\\(\\[[^\\]]*'${t}'`, 's').test(ROUTE))
  }
  ok('6d. docs describe the 401 self-start flow', readFileSync('docs/REMOTE-MCP.md', 'utf8').includes('WWW-Authenticate') && readFileSync('docs/REMOTE-MCP.md', 'utf8').includes('Connect via OAuth'))
  ok('6e. #connect page mentions the OAuth path (bilingual, in-place)', /OAuth/.test(readFileSync('src/pwa/public/app-connect.js', 'utf8')))

  http.close()
  if (fail > 0) { console.error(`\n❌ oauth /mcp challenge FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth /mcp challenge: 401 + WWW-Authenticate resource_metadata (RFC 9728) · I-2 anonymous read untouched · bearers pass through · fail-closed flag · manifest advertises oauth only when live\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
