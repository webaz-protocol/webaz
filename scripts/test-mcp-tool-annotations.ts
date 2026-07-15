#!/usr/bin/env tsx
/**
 * PR-1 — MCP tool annotations: completeness + classification lock + no stdio/remote drift.
 *
 * Reads the ACTUAL tools/list descriptors returned by the shared buildMcpServer() — the exact assembly
 * BOTH the stdio server (startMCPServer → buildMcpServer) and the Remote MCP route (mcp-remote →
 * buildMcpServer) use — via an in-memory MCP client. Not a source grep, not the raw annotation map.
 *
 * Usage: npm run test:mcp-tool-annotations
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// server.js opens $HOME/.webaz at module load — relocate HOME BEFORE importing it → hermetic DB.
process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-annot-'))

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

async function main(): Promise<void> {
  const { buildMcpServer } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
  const { TOOL_ANNOTATIONS } = await import('../src/layer1-agent/L1-1-mcp-server/tool-annotations.js')

  // Exercise the REAL shared assembly via an in-memory MCP client.
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const server = buildMcpServer()
  await server.connect(serverT)
  const client = new Client({ name: 'annot-test', version: '0' }, { capabilities: {} })
  await client.connect(clientT)
  const { tools } = await client.listTools()

  const names = tools.map(t => t.name).sort()
  const mapKeys = Object.keys(TOOL_ANNOTATIONS).sort()
  type Hints = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }
  const byName = Object.fromEntries(tools.map(t => [t.name, t.annotations])) as Record<string, Hints | undefined>
  const a = (n: string): Hints => byName[n] as Hints

  // 1. every RETURNED descriptor carries all three boolean hints
  ok('1. every tools/list descriptor has 3 boolean hints (no null/undefined/missing)', tools.every(t => {
    const an = t.annotations as Hints | undefined
    return !!an && typeof an.readOnlyHint === 'boolean' && typeof an.destructiveHint === 'boolean' && typeof an.openWorldHint === 'boolean'
  }))

  // 2. annotation coverage exactly equals the live tool set — no missing, no extra
  ok('2. TOOL_ANNOTATIONS keys exactly match live tool names', JSON.stringify(names) === JSON.stringify(mapKeys))

  // 3. count derived from the actual surface; asserted to be 42 right now (not a permanent hardcode)
  ok('3. current tool count == 42 (derived from live tools + map)', tools.length === mapKeys.length && tools.length === 42)

  // 4. representative classification locks — read from the RETURNED descriptors
  ok('4a. pure read (webaz_search): readOnly=true, destructive=false', a('webaz_search').readOnlyHint === true && a('webaz_search').destructiveHint === false)
  ok('4b. first-party write (webaz_default_address): readOnly=false, destructive=false, openWorld=false', a('webaz_default_address').readOnlyHint === false && a('webaz_default_address').destructiveHint === false && a('webaz_default_address').openWorldHint === false)
  ok('4c. public-state write (webaz_place_order): readOnly=false, destructive=true, openWorld=true', a('webaz_place_order').readOnlyHint === false && a('webaz_place_order').destructiveHint === true && a('webaz_place_order').openWorldHint === true)
  ok('4d. multi-action w/ delete (webaz_list_product): readOnly=false, destructive=true', a('webaz_list_product').readOnlyHint === false && a('webaz_list_product').destructiveHint === true)
  ok('4e. multi-action irreversible confirm (webaz_update_order): destructive=true', a('webaz_update_order').destructiveHint === true)
  ok('4f. read-only account tool (webaz_wallet): readOnly=true', a('webaz_wallet').readOnlyHint === true)
  ok('4g. dispute arbitrate is destructive (webaz_dispute)', a('webaz_dispute').destructiveHint === true)

  // 5. no-drift: both transports go through buildMcpServer (which we just exercised) → same annotations
  const L1 = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  const ROUTE = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
  ok('5a. single ListTools handler returns the annotated surface', L1.includes('ListToolsRequestSchema') && L1.includes('tools: TOOLS_ANNOTATED'))
  ok('5b. stdio entry uses buildMcpServer', L1.includes('const server = buildMcpServer()'))
  ok('5c. Remote MCP route uses buildMcpServer', /buildMcpServer\(\{/.test(ROUTE))

  await client.close(); await server.close()

  if (fail > 0) { console.error(`\n❌ mcp tool annotations FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ mcp tool annotations: ${tools.length}/${tools.length} carry 3 boolean hints · map==live names · classification locks · stdio+remote share buildMcpServer (no drift)\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
