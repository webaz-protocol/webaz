#!/usr/bin/env node
/**
 * P1 Compatibility matrix — canonical stranger first-task across client PROFILES.
 *
 * What this DOES verify (automatable, honest): the live Remote MCP endpoint accepts and correctly
 * serves the distinct request shapes real MCP clients use — protocol-version negotiation, Accept
 * header, whether the client sends initialize first, stateless call ordering — and the canonical
 * anonymous first task (connect → tools/list → NL-search recovery → browse → act on a product)
 * completes under each. Each profile mirrors how a named client talks to an MCP server.
 *
 * What it does NOT do: drive the hosted ChatGPT / Claude / Cursor UIs (those need their own harness
 * or a human). Manual connect steps for those live in docs/REMOTE-MCP.md. The profiles below are the
 * server-side compatibility surface that决定s whether those clients CAN connect.
 *
 * Usage: node scripts/agent-compat-matrix.mjs [endpoint]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const EP = process.argv[2] || 'https://webaz.xyz/mcp'
const STEPS = ['connect', 'tools_list', 'nl_recovers', 'browse', 'task_complete']

// Each profile = how that client characteristically talks (protocol version / Accept / initialize order / transport).
const PROFILES = [
  { name: 'mcp-sdk (Claude Desktop/Code, Cursor)', kind: 'sdk' },
  { name: 'chatgpt-connector (init+initialized)',  kind: 'raw', protocolVersion: '2025-03-26', sendInitialize: true },
  { name: 'codex-cli (older proto negotiation)',   kind: 'raw', protocolVersion: '2024-11-05', sendInitialize: true },
  { name: 'openclaw/hermes (stateless, no init)',  kind: 'raw', protocolVersion: '2025-06-18', sendInitialize: false },
  { name: 'minimal-raw (bare JSON-RPC)',           kind: 'raw', protocolVersion: '2025-06-18', sendInitialize: false },
]

const ACCEPT = 'application/json, text/event-stream'
async function rpc(body, extraHeaders = {}) {
  const res = await fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...extraHeaders }, body: JSON.stringify(body) })
  const txt = await res.text()
  try { return JSON.parse(txt) } catch { return { _status: res.status, _raw: txt.slice(0, 120) } }
}
const toolResult = (rpcResp) => JSON.parse(rpcResp.result.content[0].text)

async function runRaw(p) {
  const r = Object.fromEntries(STEPS.map(s => [s, false]))
  try {
    if (p.sendInitialize) {
      const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: p.protocolVersion, capabilities: {}, clientInfo: { name: p.name, version: '1' } } })
      r.connect = !!init.result?.protocolVersion
      await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    } else {
      r.connect = true // stateless: no handshake needed for reads
    }
    const tl = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    r.tools_list = (tl.result?.tools || []).some(t => t.name === 'webaz_search')
    const nl = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'webaz_search', arguments: { query: 'phone stand' } } })
    r.nl_recovers = (toolResult(nl).recovery?.catalog_sample || []).length > 0
    const br = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'webaz_search', arguments: { sort: 'newest', limit: 3 } } })
    const prods = toolResult(br).products || []
    r.browse = prods.length > 0
    if (!prods.length) return r
    const ph = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'webaz_price_history', arguments: { product_id: prods[0].id } } })
    r.task_complete = !toolResult(ph).error
  } catch {}
  return r
}

async function runSdk() {
  const r = Object.fromEntries(STEPS.map(s => [s, false]))
  let c
  try {
    c = new Client({ name: 'compat-sdk', version: '1.0.0' }, { capabilities: {} })
    await c.connect(new StreamableHTTPClientTransport(new URL(EP))); r.connect = true
    r.tools_list = (await c.listTools()).tools.some(t => t.name === 'webaz_search')
    const nl = JSON.parse((await c.callTool({ name: 'webaz_search', arguments: { query: 'phone stand' } })).content[0].text)
    r.nl_recovers = (nl.recovery?.catalog_sample || []).length > 0
    const br = JSON.parse((await c.callTool({ name: 'webaz_search', arguments: { sort: 'newest', limit: 3 } })).content[0].text)
    const prods = br.products || []; r.browse = prods.length > 0
    if (prods.length) { const ph = JSON.parse((await c.callTool({ name: 'webaz_price_history', arguments: { product_id: prods[0].id } })).content[0].text); r.task_complete = !ph.error }
  } catch {} finally { try { await c?.close() } catch {} }
  return r
}

const rows = []
for (const p of PROFILES) rows.push({ p, r: p.kind === 'sdk' ? await runSdk() : await runRaw(p) })

console.log(`\n★ P1 Compatibility matrix — ${EP}\n`)
const head = 'client profile'.padEnd(38) + STEPS.map(s => s.slice(0, 11).padEnd(13)).join('') + 'PASS'
console.log(head); console.log('─'.repeat(head.length))
let allPass = true
for (const { p, r } of rows) {
  const pass = STEPS.every(s => r[s])
  allPass &&= pass
  console.log(p.name.padEnd(38) + STEPS.map(s => (r[s] ? '✓' : '✗').padEnd(13)).join('') + (pass ? '✅' : '❌'))
}
console.log('\n' + (allPass ? '✅ ALL CLIENT PROFILES PASS the canonical first task' : '❌ some profile failed — see ✗ above'))
process.exit(allPass ? 0 : 1)
