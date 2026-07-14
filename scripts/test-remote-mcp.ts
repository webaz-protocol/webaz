#!/usr/bin/env tsx
/**
 * RFC-022 Remote MCP endpoint test — real express app + real Streamable HTTP handshake (no webaz DB, no network).
 *
 * Behavioral: mounts registerRemoteMcpRoutes on a bare express app and speaks actual JSON-RPC over HTTP:
 * initialize → serverInfo, tools/list → full tool surface. Security: fail-closed flag, sandbox refuse,
 * 405 on GET/DELETE, no CORS headers, bearer parse + injection seam asserted at source.
 *
 * Usage: npm run test:remote-mcp
 */
import { readFileSync } from 'node:fs'
import express from 'express'
import type { Server as HttpServer } from 'node:http'

// 必须在 import server.js(经 boot→mcp-remote)之前设置:apiCall/resolveMcpApiKey 的 WEBAZ_API_KEY module const
// 在 import 时固化。设成非空,才能证明"隔离态 apiCall 不把这个宿主 key 泄漏到出站请求"。
process.env.WEBAZ_API_KEY = 'wz_HOST_ENV_KEY_MUST_NOT_LEAK'

// fetch spy:拦截出站到 webaz.xyz 的请求,记录每次的 Authorization,并返回空 catalog(不打真网络)。
// 进程内的 /mcp 握手用 undici 打 127.0.0.1,不经此 spy(只拦 webaz.xyz)。
const _realFetch = globalThis.fetch
const outboundAuth: Array<string | null> = []
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as { url?: string })?.url || String(input)
  if (url.includes('webaz.xyz')) {
    const h = new Headers(init?.headers as HeadersInit)
    outboundAuth.push(h.get('authorization'))
    return new Response(JSON.stringify({ products: [], found: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return _realFetch(input as RequestInfo, init)
}) as typeof fetch

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

const ROUTE = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
const L1 = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
const SERVER = readFileSync('src/pwa/server.ts', 'utf8')
const IC = readFileSync('src/pwa/integration-contract.ts', 'utf8')
const PU = readFileSync('src/pwa/routes/public-utils.ts', 'utf8')

async function boot(env: Record<string, string | undefined>, rlCap?: number): Promise<{ base: string; http: HttpServer }> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const { registerRemoteMcpRoutes } = await import('../src/pwa/routes/mcp-remote.js')
  const app = express()
  app.use(express.json())
  let rlCalls = 0
  const rateLimitOk = () => { rlCalls++; return rlCalls <= (rlCap ?? 1e9) }
  ;(app as unknown as { _rl: () => number })._rl = () => rlCalls
  registerRemoteMcpRoutes(app, { rateLimitOk })
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const http = await new Promise<HttpServer>(r => { const s = app.listen(0, () => r(s)) })
  const addr = http.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, http }
}

const rpc = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })

async function main() {
  // ── 1. fail-closed:未设 WEBAZ_REMOTE_MCP → 不挂载 ──
  {
    const { base, http } = await boot({ WEBAZ_REMOTE_MCP: undefined, WEBAZ_MODE: undefined })
    const r = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    ok('1. flag off → endpoint absent (404)', r.status === 404)
    http.close()
  }

  // ── 2. sandbox 拒绝挂载(T7)──
  {
    const { base, http } = await boot({ WEBAZ_REMOTE_MCP: '1', WEBAZ_MODE: 'sandbox' })
    const r = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'ping' })
    ok('2. sandbox mode → refuses to mount (404)', r.status === 404)
    http.close()
  }

  // ── 3. flag on:真握手 ──
  const { base, http } = await boot({ WEBAZ_REMOTE_MCP: '1', WEBAZ_MODE: undefined })
  {
    const r = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    const j = await r.json().catch(() => null) as { result?: { serverInfo?: { name?: string }, capabilities?: Record<string, unknown> } } | null
    ok('3a. initialize → 200 JSON', r.status === 200 && !!j?.result)
    ok('3b. serverInfo.name = dcp-protocol (stdio 同源)', j?.result?.serverInfo?.name === 'dcp-protocol')
    ok('3c. capabilities include tools', !!j?.result?.capabilities && 'tools' in (j.result.capabilities as object))
    ok('3d. no CORS headers emitted (T6)', !r.headers.get('access-control-allow-origin'))
    ok('3e. stateless: no session id issued', !r.headers.get('mcp-session-id'))
  }
  {
    const r = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const j = await r.json().catch(() => null) as { result?: { tools?: Array<{ name: string }> } } | null
    const tools = j?.result?.tools || []
    ok('4a. tools/list works statelessly (no prior initialize in-request)', r.status === 200 && tools.length >= 38)
    const names = new Set(tools.map(t => t.name))
    ok('4b. tool surface identical to stdio (spot: info/search/place_order/contribute)',
      names.has('webaz_info') && names.has('webaz_search') && names.has('webaz_place_order') && names.has('webaz_contribute'))
  }
  {
    const g = await fetch(`${base}/mcp`)
    const d = await fetch(`${base}/mcp`, { method: 'DELETE' })
    ok('5. GET/DELETE → 405 (stateless, POST only)', g.status === 405 && d.status === 405)
  }
  http.close()

  // ── 6. 源码守卫:bearer 解析 + 注入 seam + 优先级 + 日志隐私 ──
  ok('6a. route parses Authorization: Bearer', has(ROUTE, "authz.startsWith('Bearer ')"))
  ok('6b. bearer 只作 defaultApiKey 传入(不越过 args 优先级)', has(ROUTE, 'defaultApiKey: bearer'))
  ok('6c. L1 注入点:args 无 api_key 才注入', has(L1, "opts.defaultApiKey && (args as Record<string, unknown>).api_key == null"))
  ok('6d. stdio 入口仍走 buildMcpServer(同一工具面)', has(L1, 'const server = buildMcpServer()') && has(L1, 'new StdioServerTransport()'))
  ok('6e. route 模块不打印 args/Authorization(T8)', !/console\.(log|error)\([^)]*(args|authorization|bearer)/i.test(ROUTE.replace('REFUSING to mount', '')))
  ok('6f. pwa server 注册了远程路由', has(SERVER, 'registerRemoteMcpRoutes(app,'))

  // ── 7. 发现面:sandbox-aware gate(P2 修复)+ 仅开启时披露(不广告 404)──
  ok('7a. integration-contract 用 remoteMcpEnabled() gate(含 sandbox 检查)', has(IC, 'remoteMcpEnabled()') && has(IC, 'remote_mcp') && !has(IC, "process.env.WEBAZ_REMOTE_MCP === '1' ? { remote_mcp"))
  ok('7b. protocol-status 用 remoteMcpEnabled() gate', has(PU, 'remoteMcpEnabled()') && has(PU, "remote_mcp: 'https://webaz.xyz/mcp'"))

  // ── 8. 凭证隔离(修 Codex 两个 P0)— 直接 eval 真实函数,不靠字符串匹配 ──
  process.env.WEBAZ_MODE = 'network'
  const L1mod = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
  // 8a-c. resolveMcpApiKey:显式 envKey 参数测隔离逻辑(module const 在 import 时固化,故显式传更确定)
  const HOST = 'wz_host_env_key_MUST_NOT_LEAK'
  ok('8a. isolated 匿名 → 忽略宿主 env key(→ 空 → readonly)', L1mod.resolveMcpApiKey({ __isolated__: true }, HOST) === '')
  ok('8b. isolated + 显式 bearer(注入 args.api_key)→ 用 bearer', L1mod.resolveMcpApiKey({ __isolated__: true, api_key: 'wz_caller_bearer' }, HOST) === 'wz_caller_bearer')
  ok('8c. 非隔离(stdio)→ 用宿主 env key 回退(本地行为不变)', L1mod.resolveMcpApiKey({}, HOST) === HOST)
  // 8d. resolveGrantCredential:隔离态绝不读宿主存储 grant
  ok('8d. isolated → resolveGrantCredential(args) 返回 null(不继承宿主 grant)', L1mod.resolveGrantCredential({ __isolated__: true }) === null)
  // 8e. handlePair:隔离态禁 pairing(修跨请求竞态 P0)
  const pairRes = await L1mod.handlePair({ __isolated__: true, action: 'start' })
  ok('8e. isolated → webaz_pair 禁用(PAIRING_LOCAL_ONLY,不触碰宿主 pairing 文件)', pairRes?.error_code === 'PAIRING_LOCAL_ONLY')
  // 8f. 源码守卫:远程路由强制 isolated:true + 拦截器服务端强制标记(覆盖伪造)
  ok('8f. 远程路由强制 isolated:true', has(ROUTE, 'buildMcpServer({') && /buildMcpServer\(\{\s*isolated: true/.test(ROUTE))
  ok('8g. 拦截器服务端强制 __isolated__(覆盖调用方伪造),stdio 清除', has(L1, "if (opts.isolated) (args as Record<string, unknown>).__isolated__ = true") && has(L1, "else delete (args as Record<string, unknown>).__isolated__"))
  ok('8h. apiCall fallback 走 ALS isIsolated()(单一权威,覆盖所有调用点)', has(L1, "const key = opts.apiKey || (isIsolated() ? '' : WEBAZ_API_KEY)"))
  ok('8i. recentCalls ring buffer 隔离态不写(防跨请求元数据 bleed)', has(L1, "name !== 'webaz_feedback' && !isIsolated()"))
  ok('8j. webaz_feedback 隔离态不读进程级 recentCalls(读侧镜像守卫)', has(L1, 'scene: isIsolated() ? [] : recentCalls.slice(-8)'))

  // ── 9. 端到端证明:即使宿主设了 WEBAZ_API_KEY,匿名远程的出站请求也不带它(ALS 隔离真生效)──
  const { base: rbase, http: rhttp } = await boot({ WEBAZ_REMOTE_MCP: '1', WEBAZ_MODE: 'network' })
  outboundAuth.length = 0
  // 匿名(无 Bearer)调 webaz_search(公开读 → apiCall → 出站 webaz.xyz)
  await rpc(rbase, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'webaz_search', arguments: { query: 'x' } } })
  ok('9a. 匿名远程:出站请求确有发生(经 fetch spy)', outboundAuth.length >= 1)
  ok('9b. ★匿名远程出站【不带】宿主 env key(修 P0:apiCall 不泄漏 WEBAZ_API_KEY)', outboundAuth.every(a => a == null))
  // 关键不变量:即便带 Bearer 的远程请求,出站也【绝不】携带宿主 env key(只会是调用方自己的 bearer 或无 auth)
  outboundAuth.length = 0
  await rpc(rbase, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'webaz_search', arguments: { query: 'x' } } }, { Authorization: 'Bearer wz_caller_bearer_XYZ' })
  ok('9c. ★宿主 env key 绝不出现在任何远程出站请求里(匿名或 bearer 都不泄漏宿主身份)',
    outboundAuth.every(a => a !== 'Bearer wz_HOST_ENV_KEY_MUST_NOT_LEAK'))
  rhttp.close()

  // ── 10. IP 限流(T2/T3:公开端点防刷 / 暴力猜 key / DoS)──
  {
    const { base: lb, http: lh } = await boot({ WEBAZ_REMOTE_MCP: '1', WEBAZ_MODE: undefined }, 2)   // 配额=2
    const r1 = await rpc(lb, { jsonrpc: '2.0', id: 1, method: 'ping' })
    const r2 = await rpc(lb, { jsonrpc: '2.0', id: 2, method: 'ping' })
    const r3 = await rpc(lb, { jsonrpc: '2.0', id: 3, method: 'ping' })   // 超配额
    ok('10a. 配额内请求正常(非 429)', r1.status !== 429 && r2.status !== 429)
    ok('10b. 超配额 → 429 rate limited', r3.status === 429)
    ok('10c. 429 前不建 MCP server(限流在装配之前)', ROUTE.indexOf('deps.rateLimitOk(') < ROUTE.indexOf('buildMcpServer({'))
    lh.close()
  }
  ok('10d. 注册需 rateLimitOk dep(server.ts 已注入)', has(SERVER, 'registerRemoteMcpRoutes(app, { rateLimitOk })'))
  ok('10e. 命名空间桶 remote_mcp:(修 P2,不与 telemetry 裸-IP 桶串)', has(ROUTE, "'remote_mcp:' + clientIp(req)"))
  ok('10f. 客户端 IP 真相源优先 CF-Connecting-IP(修 P1,CF 覆盖不可伪造)', has(ROUTE, "req.headers['cf-connecting-ip']") && has(ROUTE, 'req.ip'))
  ok('10g. CF-Connecting-IP 需过 IP 形态校验(拒任意字符串桶键,P2 收窄)', has(ROUTE, 'IP_RE.test(cf)'))
  ok('10h. 直连-origin DoS 残余已显式文档化(RFC/docs 诚实)', readFileSync('docs/REMOTE-MCP.md','utf8').includes('bypasses Cloudflare') && readFileSync('docs/REMOTE-MCP.md','utf8').includes('CF_ORIGIN_GUARD_MODE=enforce'))

  // ── 11. 发现面:顶层 remote_mcp 公告(陌生 agent 一眼可见)+ 完整 shape ──
  process.env.WEBAZ_REMOTE_MCP = '1'; delete process.env.WEBAZ_MODE
  const { remoteMcpManifest } = await import('../src/pwa/routes/mcp-remote.js')
  const man = remoteMcpManifest()
  ok('11a. remoteMcpManifest 返回完整 shape(端点开时)', !!man && man.transport === 'streamable_http' && man.endpoint === 'https://webaz.xyz/mcp' && man.status === 'live')
  ok('11b. shape 含 authentication.anonymous / .bearer', !!(man as Record<string, Record<string, unknown>>)?.authentication?.anonymous && !!(man as Record<string, Record<string, unknown>>)?.authentication?.bearer)
  ok('11c. shape 含 protocol_version + stdio 区分', man?.protocol_version === '2025-03-26' && String(man?.stdio_alternative || '').includes('npx -y @seasonkoh/webaz'))
  const ICsrc = readFileSync('src/pwa/integration-contract.ts', 'utf8')
  const PUsrc = readFileSync('src/pwa/routes/public-utils.ts', 'utf8')
const PUsrc2 = PUsrc
  ok('11d. integration.json 顶层公告 remote_mcp(via builder)', ICsrc.includes('{ remote_mcp: remoteMcpManifest() }'))
  ok('11e. protocol.json 顶层公告 remote_mcp(via builder)', PUsrc.includes('{ remote_mcp: remoteMcpManifest() }'))
  ok('11f. strict 0-命中指向远程可达浏览(recovery + acp-feed,不只 PWA #discover)', L1.includes('见 recovery') && L1.includes('acp-feed.json'))
  ok('11g. REMOTE-MCP.md 在 PUBLIC_DOCS 白名单(manifest 广告的 docs 链接不能 404)', PUsrc2.includes("'REMOTE-MCP.md'"))
  ok('11h. P2:search 0-命中带 recovery(catalog_sample + next_step),strict 结果仍 found:0', L1.includes("reason: 'strict_no_match'") && L1.includes('catalog_sample:') && L1.includes('next_step:') && L1.includes('found: 0,'))

  if (fail > 0) { console.error(`\n❌ remote MCP FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ remote MCP: real handshake over Streamable HTTP (stateless) + fail-closed flag + sandbox refuse + 405s + no-CORS + bearer seam\n  ✅ pass ${pass}`)
}

main().catch(e => { console.error(e); process.exit(1) })
