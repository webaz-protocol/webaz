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
type WireTool = {
  name: string
  securitySchemes?: Scheme[]
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
  _meta?: { securitySchemes?: Scheme[]; 'openai/outputTemplate'?: unknown }
}

async function main(): Promise<void> {
  const { registerRemoteMcpRoutes } = await import('../src/pwa/routes/mcp-remote.js')
  const app = express(); app.use(express.json())
  registerRemoteMcpRoutes(app, { rateLimitOk: () => true })
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address(); const port = typeof addr === 'object' && addr ? addr.port : 0

  const res = await fetch(`http://127.0.0.1:${port}/mcp?surface=full`, {   // PR-3:本测试审计【全量】面(匿名默认已是 buyer 面)
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const j = await res.json() as { result?: { tools?: WireTool[] } }
  const tools = j.result?.tools ?? []
  const byName: Record<string, Scheme[] | undefined> = Object.fromEntries(tools.map(t => [t.name, t.securitySchemes]))
  const shoppingRes = await fetch(`http://127.0.0.1:${port}/mcp?surface=shopping_v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  const shoppingJson = await shoppingRes.json() as { result?: { tools?: WireTool[] } }
  const shoppingTools = shoppingJson.result?.tools ?? []
  const invalidSurfaceResponses = await Promise.all([
    `http://127.0.0.1:${port}/mcp?surface=`,
    `http://127.0.0.1:${port}/mcp?surface=shopping_v1&surface=buyer`,
    `http://127.0.0.1:${port}/mcp?surface=shopping-v1`,
  ].map(url => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  })))

  // COARSE OAuth scopes (what the client requests at /oauth/authorize) — NOT internal fine capabilities.
  const OAUTH: Record<string, string[]> = {
    webaz_list_product: ['read', 'list:draft'],
    webaz_upload_product_image: ['list:draft'],
    webaz_get_agent_order: ['read'],
    webaz_connection_status: ['read'],
    webaz_order_action_request: ['order:draft'],
    webaz_buyer_orders: ['read'],   // RFC-025 PR-1
    webaz_discover: ['read'],       // RFC-025 PR-2
    webaz_quote_order: ['order:draft'],   // RFC-025 PR-3
    webaz_order_draft: ['order:draft'],   // RFC-025 PR-4
    webaz_submit_order_request: ['order:draft'],   // RFC-025 PR-5a
    webaz_prepare_case: ['read'],   // RFC-025 PR-6
    webaz_approval_requests: ['read'],   // RFC-026 PR-2
    webaz_wallet_view: ['read'],   // RFC-026 PR-3
    webaz_order_chat: ['chat:context'],   // RFC-026 PR-4
    webaz_address: ['address'],   // RFC-026 PR-5
    webaz_buyer_action_request: ['aftersales:request'],   // RFC-026 PR-6
  }
  const SHOPPING_NAMES = ['webaz_buyer_orders', 'webaz_connection_status', 'webaz_discover', 'webaz_order_draft', 'webaz_quote_order', 'webaz_search', 'webaz_submit_order_request']
  const SHOPPING_ANNOTATIONS: Record<string, [boolean, boolean, boolean]> = {
    webaz_search: [true, false, true],
    webaz_discover: [false, false, true],
    webaz_quote_order: [false, false, true],
    webaz_order_draft: [false, true, true],
    webaz_submit_order_request: [false, false, true],
    webaz_buyer_orders: [true, false, true],
    webaz_connection_status: [true, false, false],
  }
  const SHOPPING_TEMPLATES: Record<string, RegExp> = {
    webaz_search: /^ui:\/\/widget\/webaz-products\.[0-9a-f]{10}\.html$/,
    webaz_quote_order: /^ui:\/\/widget\/webaz-quote-approval\.[0-9a-f]{10}\.html$/,
    webaz_order_draft: /^ui:\/\/widget\/webaz-quote-approval\.[0-9a-f]{10}\.html$/,
    webaz_submit_order_request: /^ui:\/\/widget\/webaz-quote-approval\.[0-9a-f]{10}\.html$/,
    webaz_buyer_orders: /^ui:\/\/widget\/webaz-order-timeline\.[0-9a-f]{10}\.html$/,
  }
  const API_KEY_ONLY = ['webaz_place_order', 'webaz_update_order', 'webaz_wallet', 'webaz_notifications', 'webaz_default_address']
  const { OAUTH_SCOPES } = await import('../src/pwa/routes/oauth-discovery.js')
  const { OAUTH_SCOPE_CAPABILITIES } = await import('../src/pwa/routes/oauth-approve.js')
  // Derive the forbidden set EXHAUSTIVELY from the authoritative mapping — every fine capability, so a
  // future-added one can never silently leak into securitySchemes.
  const FINE_CAPABILITY_NAMES = [...new Set(Object.values(OAUTH_SCOPE_CAPABILITIES).flat())]

  // The REMOTE wire is the isolated surface: it excludes LOCAL_ONLY tools (webaz_pair), so excludes webaz_pair.
  ok('1. all 54 remote-visible tools carry a non-empty securitySchemes array on the WIRE (webaz_pair local-only hidden)', tools.length === 54 && tools.every(t => Array.isArray(t.securitySchemes) && t.securitySchemes.length > 0))
  ok('1b. webaz_pair (local-only pairing) is NOT advertised on the remote tools/list', !byName['webaz_pair'])
  ok('1c. shopping_v1 raw WIRE is exactly seven reviewed tools, all with explicit security schemes',
    JSON.stringify(shoppingTools.map(t => t.name).sort()) === JSON.stringify(SHOPPING_NAMES)
    && shoppingTools.every(t => Array.isArray(t.securitySchemes) && t.securitySchemes.length > 0))
  ok('1d. shopping_v1 raw WIRE mirrors the canonical securitySchemes into _meta for legacy OpenAI clients',
    shoppingTools.every(t => JSON.stringify(t._meta?.securitySchemes) === JSON.stringify(t.securitySchemes)))
  ok('1e. shopping_v1 raw WIRE carries the exact reviewed annotations for all seven tools',
    shoppingTools.every(t => {
      const expected = SHOPPING_ANNOTATIONS[t.name]
      return !!expected && JSON.stringify([t.annotations?.readOnlyHint, t.annotations?.destructiveHint, t.annotations?.openWorldHint]) === JSON.stringify(expected)
    }))
  const shoppingTemplateTools = shoppingTools.filter(t => typeof t._meta?.['openai/outputTemplate'] === 'string')
  ok('1f. shopping_v1 raw WIRE binds exactly five tools to the expected content-versioned buyer card families',
    JSON.stringify(shoppingTemplateTools.map(t => t.name).sort()) === JSON.stringify(Object.keys(SHOPPING_TEMPLATES).sort())
    && shoppingTemplateTools.every(t => SHOPPING_TEMPLATES[t.name]?.test(String(t._meta?.['openai/outputTemplate']))))
  ok('1g. supplied empty, repeated, or unknown surface parameters fail closed instead of widening tools/list',
    invalidSurfaceResponses.every(r => r.status === 400))

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
  ok('5. EXACTLY the 16 grant-reachable tools advertise oauth2 (no false OAuth anywhere else)',
    JSON.stringify(oauthTools) === JSON.stringify(['webaz_address', 'webaz_approval_requests', 'webaz_buyer_action_request', 'webaz_buyer_orders', 'webaz_connection_status', 'webaz_discover', 'webaz_get_agent_order', 'webaz_list_product', 'webaz_order_action_request', 'webaz_order_chat', 'webaz_order_draft', 'webaz_prepare_case', 'webaz_quote_order', 'webaz_submit_order_request', 'webaz_upload_product_image', 'webaz_wallet_view']))

  // PR-6: every advertised oauth2 scope MUST be a coarse OAuth scope the authorize endpoint accepts —
  // else ChatGPT requests it and gets invalid_scope. And a fine internal capability name must NEVER leak
  // into securitySchemes (that was the bug).
  const allOauthScopes = tools.flatMap(t => (t.securitySchemes ?? []).flatMap(s => s.scopes ?? []))
  ok(`7. every oauth2 scope is a subset of OAUTH_SCOPES [${OAUTH_SCOPES.join(',')}] (authorize accepts it)`,
    allOauthScopes.length > 0 && allOauthScopes.every(s => (OAUTH_SCOPES as readonly string[]).includes(s)))
  const wireStr = JSON.stringify(tools.map(t => t.securitySchemes))
  ok('8. NO fine grant-capability name appears anywhere in securitySchemes (coarse vocabulary only)',
    FINE_CAPABILITY_NAMES.every(cap => !wireStr.includes(cap)))

  // 9 — EVERY oauth2 grant-reachable tool MUST be in NETWORK_TOOLS. Otherwise the RFC-003 migration gate
  //   (isNetworkMode && !toolAllowedInNetworkMode → not_on_network_yet) intercepts the authenticated call
  //   BEFORE the handler runs, so OAuth "succeeds" but the tool returns "not on the network yet". (This is
  //   exactly the bug that shipped for webaz_connection_status; a direct-handler unit test bypassed the gate.)
  const { NETWORK_TOOLS } = await import('../src/layer1-agent/L1-1-mcp-server/network-mode.js')
  ok('9. every oauth2 grant-reachable tool is in NETWORK_TOOLS (else the migration gate blocks dispatch)',
    oauthTools.length > 0 && oauthTools.every(n => (NETWORK_TOOLS as Set<string>).has(n)))

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
  console.log(`✅ mcp securitySchemes: ${tools.length}/${tools.length} on remote wire (webaz_pair hidden) · oauth2 ONLY for the ${oauthTools.length} grant-reachable tools (exact scopes) · noauth everywhere else (no false OAuth on api_key-only)\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
