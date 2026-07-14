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

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

const ROUTE = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
const L1 = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
const SERVER = readFileSync('src/pwa/server.ts', 'utf8')
const IC = readFileSync('src/pwa/integration-contract.ts', 'utf8')
const PU = readFileSync('src/pwa/routes/public-utils.ts', 'utf8')

async function boot(env: Record<string, string | undefined>): Promise<{ base: string; http: HttpServer }> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const { registerRemoteMcpRoutes } = await import('../src/pwa/routes/mcp-remote.js')
  const app = express()
  app.use(express.json())
  registerRemoteMcpRoutes(app)
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
  ok('6b. bearer 只作 defaultApiKey 传入(不越过 args 优先级)', has(ROUTE, 'buildMcpServer(bearer ? { defaultApiKey: bearer } : {})'))
  ok('6c. L1 注入点:args 无 api_key 才注入', has(L1, "opts.defaultApiKey && (args as Record<string, unknown>).api_key == null"))
  ok('6d. stdio 入口仍走 buildMcpServer(同一工具面)', has(L1, 'const server = buildMcpServer()') && has(L1, 'new StdioServerTransport()'))
  ok('6e. route 模块不打印 args/Authorization(T8)', !/console\.(log|error)\([^)]*(args|authorization|bearer)/i.test(ROUTE.replace('REFUSING to mount', '')))
  ok('6f. pwa server 注册了远程路由', has(SERVER, 'registerRemoteMcpRoutes(app)'))

  // ── 7. 发现面:仅开启时披露(不广告 404)──
  ok('7a. integration-contract 条件披露 remote_mcp', has(IC, "process.env.WEBAZ_REMOTE_MCP === '1'") && has(IC, 'remote_mcp'))
  ok('7b. protocol-status 条件披露 remote_mcp', has(PU, "process.env.WEBAZ_REMOTE_MCP === '1'") && has(PU, "remote_mcp: 'https://webaz.xyz/mcp'"))

  if (fail > 0) { console.error(`\n❌ remote MCP FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ remote MCP: real handshake over Streamable HTTP (stateless) + fail-closed flag + sandbox refuse + 405s + no-CORS + bearer seam\n  ✅ pass ${pass}`)
}

main().catch(e => { console.error(e); process.exit(1) })
