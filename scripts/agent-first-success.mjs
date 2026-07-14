#!/usr/bin/env node
/**
 * ★ North Star harness — Agent First Task Success Rate.
 *
 * Simulates a stranger third-party agent that has never seen WebAZ: for each run it uses a FRESH
 * MCP client, connects anonymously to the live Remote MCP endpoint, and attempts the canonical
 * first task — discover a real product — with NO human help and NO api_key:
 *
 *   connect (initialize) → tools/list (find webaz_search) → browse (webaz_search, no query)
 *   → pick a product → fetch a detail (webaz_price_history) = "first task complete"
 *
 * Reports per-step pass rate + the overall Agent First Task Success Rate. This is the metric every
 * adoption optimization is judged against; it also seeds the P1 cross-client compatibility suite.
 *
 * Usage: node scripts/agent-first-success.mjs [endpoint] [runs]
 *   node scripts/agent-first-success.mjs                       # prod, 5 runs
 *   node scripts/agent-first-success.mjs https://webaz.xyz/mcp 10
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ENDPOINT = process.argv[2] || 'https://webaz.xyz/mcp'
const RUNS = Number(process.argv[3] || 5)

// Canonical first-task steps. Each returns true/false; a run succeeds only if the LAST step (task
// complete) succeeds — earlier steps are diagnostics telling you WHERE a stranger agent fails.
const STEPS = ['connect', 'tools_list', 'find_search', 'nl_search_recovers', 'browse_products', 'task_complete']

async function oneRun() {
  const res = Object.fromEntries(STEPS.map(s => [s, false]))
  let client
  try {
    const t = new StreamableHTTPClientTransport(new URL(ENDPOINT))
    client = new Client({ name: 'stranger-agent-nstar', version: '1.0.0' }, { capabilities: {} })
    await client.connect(t); res.connect = true                              // 1. handshake
    const tools = await client.listTools(); res.tools_list = tools.tools.length > 0   // 2. list
    res.find_search = tools.tools.some(x => x.name === 'webaz_search')        // 3. discover the tool
    if (!res.find_search) return res
    // 4. 陌生 agent 最自然的第一动作 = 自然语言搜;strict 返 0,但 recovery 应给可动样本(北极星真缺口)
    const nl = await client.callTool({ name: 'webaz_search', arguments: { query: 'phone stand' } })
    const nlj = JSON.parse(nl.content[0].text)
    res.nl_search_recovers = (nlj.recovery?.catalog_sample || []).length > 0
    const browse = await client.callTool({ name: 'webaz_search', arguments: { sort: 'newest', limit: 5 } })
    const bj = JSON.parse(browse.content[0].text)
    const products = bj.products || []
    res.browse_products = products.length > 0                                // 4. find real products
    if (!products.length) return res
    // 5. "first task complete" = act on a discovered product (anonymous, read-only)
    const ph = await client.callTool({ name: 'webaz_price_history', arguments: { product_id: products[0].id } })
    const pj = JSON.parse(ph.content[0].text)
    res.task_complete = !pj.error                                            // got a structured, non-error result
    return res
  } catch { return res }
  finally { try { await client?.close() } catch {} }
}

const runs = []
for (let i = 0; i < RUNS; i++) runs.push(await oneRun())

const rate = step => (runs.filter(r => r[step]).length / RUNS * 100).toFixed(0) + '%'
console.log(`\n★ Agent First Task Success — ${ENDPOINT} (${RUNS} fresh stranger clients)\n`)
for (const s of STEPS) console.log(`  ${s.padEnd(18)} ${rate(s)}`)
const success = runs.filter(r => r.task_complete).length
console.log(`\n  ═══ Agent First Task Success Rate: ${(success / RUNS * 100).toFixed(0)}%  (${success}/${RUNS}) ═══\n`)
process.exit(success === RUNS ? 0 : 1)
