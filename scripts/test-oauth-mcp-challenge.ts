#!/usr/bin/env tsx
/**
 * RFC-023 PR-5 test — /mcp auth challenge (OpenAI Apps SDK shape: 200 + result._meta) + OAuth discovery advertising.
 *
 * Behavioral (real express app + real JSON-RPC over HTTP, fetch spy for webaz.xyz outbound):
 *   - anonymous tools/call on an auth-only tool → 200 + result._meta["mcp/www_authenticate"] + isError (header mirrors)
 *     (RFC 9728 pointer) so a compliant MCP client self-starts the OAuth flow;
 *   - challenge-is-a-promise (Codex P1): ONLY tools an oat_ can actually reach get challenged. Every
 *     challenged tool has a real grant path (retry with oat_ → grant endpoint → success or scope-specific
 *     PERMISSION_REQUIRED); api_key-only tools are NEVER challenged (OAuth cannot satisfy them — oat_ is a
 *     grant credential, not a human api_key) and keep their tool-layer API_KEY_REQUIRED guidance;
 *   - OAuth scope mapping is wired to the grant endpoints: every capability minted for `list:draft` is a
 *     scope some /api/agent/* route actually enforces (was list_product_draft — consumed by nothing);
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
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { initOAuthSchema, initAgentDelegationGrantsSchema } from '../src/runtime/webaz-schema-helpers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'

// 必须在 import mcp-remote(→ L1 server.js)之前:WEBAZ_API_KEY/MODE 在 import 时固化为 module const。
process.env.WEBAZ_API_KEY = 'wz_HOST_ENV_KEY_MUST_NOT_LEAK'
delete process.env.WEBAZ_MODE

// fetch spy:拦截出站 webaz.xyz(工具层 apiCall),不打真网络;进程内 127.0.0.1 请求照常放行。
// 记录出站 (url, Authorization) —— 用于断言 oat_ 重试真的以 grant 凭证落在 /api/agent/* 端点上。
const outbound: Array<{ url: string; auth: string }> = []
const _realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as { url?: string })?.url || String(input)
  if (url.includes('webaz.xyz')) {
    outbound.push({ url, auth: new Headers(init?.headers).get('authorization') || '' })
    return new Response(JSON.stringify({ products: [], found: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return _realFetch(input as RequestInfo, init)
}) as typeof fetch

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// PR-2: the /mcp edge now validates oat_ tokens (invalid → 401, insufficient scope → 403). Seed a real
// seam DB so a VALID oat_ passes the edge and reaches the grant endpoint (3c/3d). setSeamDb runs AFTER
// boot() — server.js's own initDatabase re-points the seam at import time.
const seedDb = new Database(':memory:')
initOAuthSchema(seedDb); initAgentDelegationGrantsSchema(seedDb)
seedDb.exec('CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, permanent_code TEXT, region TEXT)')
seedDb.exec('CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER, reason TEXT)')
seedDb.prepare("INSERT INTO users (id, api_key, permanent_code, region) VALUES ('usr_h','k_h','PC','SG')").run()
const VALID_OAT = 'oat_' + randomBytes(16).toString('hex')
seedDb.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('grt_valid', 'usr_h', 'OAuth', JSON.stringify([{ capability: 'seller_product_draft' }]), null, 0, 'active', '2099-01-01T00:00:00.000Z')
seedDb.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?)')
  .run(createHash('sha256').update(VALID_OAT).digest('hex'), 'grt_valid', 'c', 'read', 'https://webaz.xyz/mcp', '2099-01-01T00:00:00.000Z', null)

const ROUTE = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
const GRANTS_ROUTE = readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')
const METADATA_URL = 'https://webaz.xyz/.well-known/oauth-protected-resource/mcp'

// 挑战即承诺:入列 = 该工具在 /mcp 上有真实的 oat_/gtk_ grant 路径(resolveGrantCredential →
// requireAgentGrantScope 端点 → 成功或 scope 级 PERMISSION_REQUIRED)。
const GRANT_PATH_TOOLS = ['webaz_list_product', 'webaz_get_agent_order', 'webaz_order_action_request', 'webaz_connection_status']
// api_key-only:oat_ 永远满足不了(它只作为 grant 凭证注入,不是 human api_key)→ 401 广告 OAuth = 虚假恢复路径。
const API_KEY_ONLY_TOOLS = ['webaz_place_order', 'webaz_update_order', 'webaz_wallet', 'webaz_notifications', 'webaz_default_address']

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
const call = (base: string, tool: string, headers: Record<string, string> = {}, id: number | string = 7, args: Record<string, unknown> = {}) =>
  rpc(base, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }, headers)

// The OpenAI Apps SDK challenge lives in result._meta["mcp/www_authenticate"] as an ARRAY of challenge strings.
const chArrOf = (j: unknown): string[] => { const m = (j as { result?: { _meta?: Record<string, unknown> } } | null)?.result?._meta?.['mcp/www_authenticate']; return Array.isArray(m) ? m as string[] : [] }

async function main() {
  const { base, http } = await boot()
  setSeamDb(seedDb)   // PR-2: point the edge oat_ validator at the seeded DB (after server.js import re-set it)

  // ── 1. OAuth live:匿名打【有 grant 路径的】auth-only 工具 → OpenAI 挑战形状(HTTP 200 +
  //      result._meta["mcp/www_authenticate"] 数组 + isError,ChatGPT 据此弹 OAuth UI;头镜像同一挑战)──
  process.env.WEBAZ_OAUTH = '1'
  {
    const r = await call(base, 'webaz_list_product', {}, 42)
    const j = await r.json().catch(() => null) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; _meta?: Record<string, unknown> }; id?: unknown } | null
    const ch = chArrOf(j)
    ok('1a. anonymous list_product → HTTP 200 + result.isError + result._meta challenge (OpenAI shape)', r.status === 200 && j?.result?.isError === true && ch.length === 1 && ch[0].includes(METADATA_URL))
    ok('1b. challenge is RFC 6750 w/ error+error_description; WWW-Authenticate header mirrors it exactly', ch[0]?.includes('error=') === true && ch[0]?.includes('error_description=') === true && r.headers.get('www-authenticate') === ch[0])
    ok('1c. JSON-RPC result body + id echoed', j?.result !== undefined && j?.id === 42)
    ok('1d. human text names BOTH recovery paths (OAuth + api_key Bearer)', String(j?.result?.content?.[0]?.text || '').includes('OAuth') && String(j?.result?.content?.[0]?.text || '').includes('api_key'))
  }
  for (const t of GRANT_PATH_TOOLS) {
    const r = await call(base, t)
    const j = await r.json().catch(() => null)
    const ch = chArrOf(j)
    ok(`1e. anonymous ${t} → 200 challenge (grant path exists → promise is real)`, r.status === 200 && (j as { result?: { isError?: boolean } } | null)?.result?.isError === true && ch.length === 1 && r.headers.get('www-authenticate') === ch[0])
  }
  // Codex P1 回归:api_key-only 工具绝不挑战 —— 完成 OAuth 后重试仍然只能 api_key,401 就是虚假广告。
  // 它们照旧 200 + 工具层 API_KEY_REQUIRED 引导(fail-soft)。
  for (const t of API_KEY_ONLY_TOOLS) {
    const r = await call(base, t)
    ok(`1f. anonymous ${t} NOT challenged (oat_ cannot satisfy it — no false OAuth recovery)`, r.status === 200 && !r.headers.get('www-authenticate'))
  }
  // Codex PR-5 P1b:list_product 按 action 分粒度 —— grant 路径支持的 action 才挑战。
  {
    const mine = await call(base, 'webaz_list_product', {}, 71, { action: 'mine' })
    const mj = await mine.json().catch(() => null)
    ok('1g. list_product action=mine → 200 challenge (grant path: seller_products_read)', mine.status === 200 && (mj as { result?: { isError?: boolean } } | null)?.result?.isError === true && chArrOf(mj).length === 1)
    const delist = await call(base, 'webaz_list_product', {}, 72, { action: 'delist', product_id: 'p1' })
    ok('1h. list_product action=delist → NOT challenged (api_key-only, no false OAuth promise)', delist.status === 200 && !delist.headers.get('www-authenticate'))
    const del = await call(base, 'webaz_list_product', {}, 73, { action: 'delete', product_id: 'p1' })
    ok('1i. list_product action=delete → NOT challenged (api_key-only)', del.status === 200 && !del.headers.get('www-authenticate'))
  }

  // ── 2. I-2:匿名【读】面绝不被挑战 ──
  {
    const r = await call(base, 'webaz_search')
    ok('2a. anonymous search → 200, never challenged (I-2)', r.status === 200 && !r.headers.get('www-authenticate'))
    const l = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ok('2b. anonymous tools/list → 200, no challenge', l.status === 200 && !l.headers.get('www-authenticate'))
    const i = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    ok('2c. anonymous initialize → 200, no challenge (connector handshake unharmed)', i.status === 200 && !i.headers.get('www-authenticate'))
    // DOCUMENTED behavior: webaz_profile(view) is api_key business identity, NOT the connection-status tool —
    //   anonymous view returns a plain 200 (no OAuth challenge). Use webaz_connection_status for OAuth identity.
    const pv = await call(base, 'webaz_profile', {}, 74, { action: 'view' })
    const pvj = await pv.json().catch(() => null)
    ok('2d. anonymous webaz_profile(view) → 200, NOT an OAuth challenge (api_key business identity)', pv.status === 200 && !pv.headers.get('www-authenticate') && chArrOf(pvj).length === 0)
  }

  // ── 3. Bearer handling. PR-2: api_key/gtk_ still pass to the tool layer; an oat_ is now VALIDATED at
  //      the transport edge (invalid → 401; valid+scoped → dispatch reaches the grant endpoint). ──
  ok('3a. api_key Bearer → passes to tool layer (no 401 challenge)', (await call(base, 'webaz_list_product', { Authorization: 'Bearer wz_caller_key' })).status === 200)
  // PR-4: an INVALID/unknown oat_ on an auth-only tool → OpenAI challenge at the edge (was 401 in PR-2, 200 pass-through pre-PR-2).
  {
    const r3b = await call(base, 'webaz_order_action_request', { Authorization: 'Bearer oat_' + 'a'.repeat(32) })
    const j3b = await r3b.json().catch(() => null)
    ok('3b. invalid oat_ on auth-only tool → 200 challenge at the edge (bad credential not downgraded; error+error_description present)', r3b.status === 200 && (j3b as { result?: { isError?: boolean } } | null)?.result?.isError === true && chArrOf(j3b).length === 1 && chArrOf(j3b)[0].includes('error="invalid_token"') && chArrOf(j3b)[0].includes('error_description='))
  }
  // Challenge-is-a-promise: a VALID oat_ passes the edge and its retry lands on the GRANT endpoint
  // (/api/agent/*) carrying the per-request oat_ — never the host env key, never the api_key path.
  {
    outbound.length = 0
    const r = await call(base, 'webaz_list_product', { Authorization: `Bearer ${VALID_OAT}` }, 8, { action: 'create', title: 't' })
    const hit = outbound.find(o => o.url.includes('/api/agent/seller/products'))
    ok('3c. valid oat_ on list_product create → grant endpoint /api/agent/seller/products (not api_key path)', r.status === 200 && !!hit)
    ok('3d. …outbound carries the per-request oat_ (never the host env key)', hit?.auth === `Bearer ${VALID_OAT}`)
  }

  // ── 4. fail-closed:WEBAZ_OAUTH off → 行为与 PR-4 前完全一致(无挑战,无头)──
  delete process.env.WEBAZ_OAUTH
  {
    const r = await call(base, 'webaz_list_product')
    ok('4a. flag off → anonymous list_product NOT challenged (tool-layer guidance instead)', r.status === 200 && !r.headers.get('www-authenticate'))
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
  // PR-2 refactor: outer gate = oauthEnabled()+isAuthOnlyToolCall (fail-closed); the ANONYMOUS 401
  // challenge is the inner `if (!bearer)` branch (behaviour unchanged — see test:mcp-http-edge A1).
  // PR-4: the anonymous challenge branch is gated fail-closed on oauthEnabled()+no-bearer+auth-only tool;
  // a presented oat_ is validated separately (see test:mcp-http-edge). Behaviour unchanged for anonymous.
  ok('6b. anonymous challenge gated on oauthEnabled() + !bearer + isAuthOnlyToolCall (fail-closed)', ROUTE.includes('oauthEnabled() && !bearer && isAuthOnlyToolCall(req.body)'))
  // 挑战名单 = 恰好那些有 grant 路径的工具(结构锚:多列 = 虚假恢复,漏列 = fail-soft 工具层引导)
  {
    const setSrc = ROUTE.match(/AUTH_ONLY_TOOLS = new Set\(\[([^\]]*)\]/s)?.[1] || ''
    const listed = [...setSrc.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
    ok('6c. AUTH_ONLY_TOOLS === exactly the grant-path tools (challenge is a promise)', JSON.stringify(listed) === JSON.stringify([...GRANT_PATH_TOOLS].sort()))
  }
  // I-2 结构锚:双模/匿名可用工具 + api_key-only 工具绝不许进挑战名单
  for (const t of ['webaz_search', 'webaz_info', 'webaz_contribute', 'webaz_profile', 'webaz_mykey', 'webaz_pair', 'webaz_register', 'webaz_rotate_key', 'webaz_revoke_key', ...API_KEY_ONLY_TOOLS]) {
    ok(`6d. AUTH_ONLY_TOOLS excludes ${t}`, !new RegExp(`AUTH_ONLY_TOOLS = new Set\\(\\[[^\\]]*'${t}'`, 's').test(ROUTE))
  }
  // Codex P1 回归:OAuth scope → capability 映射必须落在 grant 端点真正强制的 scope 上
  // (曾经 list:draft → list_product_draft,没有任何端点消费它 → 合规客户端完成 OAuth 后永远 PERMISSION_REQUIRED)。
  {
    const { OAUTH_SCOPE_CAPABILITIES } = await import('../src/pwa/routes/oauth-approve.js')
    const caps = OAUTH_SCOPE_CAPABILITIES['list:draft'] || []
    ok('6e. list:draft mints seller_product_draft (the scope POST /api/agent/seller/products enforces)', caps.includes('seller_product_draft'))
    for (const c of caps) {
      ok(`6f. every list:draft capability (${c}) is enforced by an agent-grants endpoint`, GRANTS_ROUTE.includes(`requireAgentGrantScope('${c}')`))
    }
    // Codex PR-5 P1 回归(核心):EVERY challenged tool 的 required scope 必须能被某个 OAuth scope 铸出 ——
    // 否则合规客户端完成 OAuth 后重试永远 PERMISSION_REQUIRED(虚假承诺)。widen 决策后三工具全覆盖。
    const union = new Set(Object.values(OAUTH_SCOPE_CAPABILITIES).flat() as string[])
    const TOOL_REQUIRED_CAPS: Record<string, string[]> = {
      webaz_get_agent_order: ['seller_orders_read_minimal'],
      webaz_order_action_request: ['order_action_request'],
      webaz_list_product: ['seller_product_draft', 'seller_products_read'],   // create + mine
      webaz_connection_status: ['read_public'],   // GET /api/agent-grants/connection
    }
    for (const [tool, reqCaps] of Object.entries(TOOL_REQUIRED_CAPS)) {
      for (const c of reqCaps) {
        ok(`6g. challenged ${tool} needs ${c} → OAuth CAN mint it (promise is real) + endpoint enforces it`, union.has(c) && GRANTS_ROUTE.includes(`requireAgentGrantScope('${c}')`))
      }
    }
  }
  ok('6g. docs describe the 401 self-start flow', readFileSync('docs/REMOTE-MCP.md', 'utf8').includes('WWW-Authenticate') && readFileSync('docs/REMOTE-MCP.md', 'utf8').includes('Connect via OAuth'))
  ok('6h. #connect page mentions the OAuth path (bilingual, in-place)', /OAuth/.test(readFileSync('src/pwa/public/app-connect.js', 'utf8')))
  {
    // 6i — consent "Use another account": shows the current account + a switch that PRESERVES the OAuth
    //   request (saves location.hash to webaz_intended_hash) before logout, so the flow resumes on the
    //   SAME request as the new account. Must not fetch/POST anything or touch OAuth params.
    const CONSENT = readFileSync('src/pwa/public/app-oauth-consent.js', 'utf8')
    ok('6i. consent shows current account + a "Use another account" switch', CONSENT.includes('oauthConsentSwitchAccount') && CONSENT.includes('将以此账号连接'))
    ok('6j. switch PRESERVES the OAuth request (saves location.hash → webaz_intended_hash) then logs out', /webaz_intended_hash'?,\s*location\.hash/.test(CONSENT) && CONSENT.includes('window.logout'))
  }

  http.close()
  if (fail > 0) { console.error(`\n❌ oauth /mcp challenge FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ oauth /mcp challenge: 200 + result._meta["mcp/www_authenticate"]+isError (OpenAI Apps SDK shape, header mirrors) · challenge-is-a-promise (grant-path tools only, oat_ retry lands on /api/agent/*) · list:draft → seller_product_draft wired · I-2 anonymous read untouched · bearers pass through · fail-closed flag · manifest advertises oauth only when live\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
