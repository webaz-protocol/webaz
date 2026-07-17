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

  // 3. count derived from the actual surface; asserted to the current value (not a permanent hardcode)
  ok('3. current tool count == 52 (derived from live tools + map; +webaz_order_chat RFC-026 PR-4)', tools.length === mapKeys.length && tools.length === 52)

  // 4. classification locks — read from the RETURNED descriptors. Rule: destructive = delete/overwrite/
  //    fund-move (additive-only inserts are NOT destructive); readOnly = no DOMAIN state write (the
  //    append-only agent_grant_auth_log authorization audit fires for EVERY grant-authenticated call,
  //    read or write, and is exempt from this classification — RFC-020 §3.7 invariant);
  //    openWorld = touches marketplace/other users/orders/public objects (else own-account/static).
  const eq = (n: string, ro: boolean, d: boolean, ow: boolean): boolean => a(n).readOnlyHint === ro && a(n).destructiveHint === d && a(n).openWorldHint === ow
  // pure reads
  ok('4a. webaz_search read (T,F,T)', eq('webaz_search', true, false, true))
  ok('4b. webaz_wallet own-account read (T,F,F)', eq('webaz_wallet', true, false, false))
  ok('4c. webaz_info static first-party read (T,F,F) [acceptance-pack §2]', eq('webaz_info', true, false, false))
  ok('4c3. webaz_connection_status own-account identity read (T,F,F)', eq('webaz_connection_status', true, false, false))
  ok('4c2. webaz_pair additive pairing/scope requests (F,F,T) [acceptance-pack §2]', eq('webaz_pair', false, false, true))
  // instruction-only tools are READ-ONLY (no DB write / no execution)
  ok('4d. webaz_revoke_key instructions-only (T,F,F)', eq('webaz_revoke_key', true, false, false))
  ok('4e. webaz_rotate_key instructions-only (T,F,F)', eq('webaz_rotate_key', true, false, false))
  ok('4f. webaz_share_link read+compute, reads a marketplace product (T,F,T)', eq('webaz_share_link', true, false, true))
  // additive-only writes are NOT destructive
  ok('4g. webaz_feedback additive submit (F,F,T)', eq('webaz_feedback', false, false, true))
  ok('4h. webaz_register additive create (F,F,T)', eq('webaz_register', false, false, true))
  ok('4i. webaz_order_action_request additive queue submit (F,F,T)', eq('webaz_order_action_request', false, false, true))
  ok('4j. webaz_mykey credential-hint read only (T,F,F) [acceptance-pack §2]', eq('webaz_mykey', true, false, false))
  // overwrite writes ARE destructive (even if business-reversible)
  ok('4k. webaz_default_address set overwrites own record (F,T,F)', eq('webaz_default_address', false, true, false))
  ok('4l. webaz_auto_bid overwrite config, changes market bidding (F,T,T) [acceptance-pack §2]', eq('webaz_auto_bid', false, true, true))
  ok('4m. webaz_notifications mark_read overwrite, own inbox (F,T,F)', eq('webaz_notifications', false, true, false))
  ok('4n. webaz_profile switch_role overwrite (F,T,T)', eq('webaz_profile', false, true, true))
  // delete / fund-move are destructive
  ok('4o. webaz_place_order moves funds (F,T,T)', eq('webaz_place_order', false, true, true))
  ok('4p. webaz_update_order confirm settles (F,T,T)', eq('webaz_update_order', false, true, true))
  ok('4q. webaz_list_product delete (F,T,T)', eq('webaz_list_product', false, true, true))
  ok('4r. webaz_blocklist unblock DELETE (F,T,T)', eq('webaz_blocklist', false, true, true))
  ok('4s. webaz_follows unfollow DELETE (F,T,T)', eq('webaz_follows', false, true, true))
  ok('4t. webaz_nearby clear/set (F,T,T)', eq('webaz_nearby', false, true, true))
  ok('4u. webaz_like toggle-remove DELETE (F,T,T)', eq('webaz_like', false, true, true))
  ok('4v. webaz_dispute arbitrate (F,T,T)', eq('webaz_dispute', false, true, true))

  // 5. no-drift: both transports go through buildMcpServer (which we just exercised) → same annotations
  const L1 = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  const ROUTE = readFileSync('src/pwa/routes/mcp-remote.ts', 'utf8')
  ok('5a. single ListTools handler returns the annotated surface (transport-aware: full local, remote hides local-only)', L1.includes('ListToolsRequestSchema') && L1.includes('toolsForTransport(opts.isolated === true)') && L1.includes('TOOLS_ANNOTATED.filter(t => !LOCAL_ONLY_TOOLS.has(t.name))'))
  ok('5b. stdio entry uses buildMcpServer', L1.includes('const server = buildMcpServer()'))
  ok('5c. Remote MCP route uses buildMcpServer', /buildMcpServer\(\{/.test(ROUTE))

  // 6. connection-status routing: "which account am I connected as?" must route to webaz_connection_status,
  //    and webaz_profile must NOT be presented as the connection-status tool (it's api_key business identity).
  const desc = Object.fromEntries(tools.map(t => [t.name, (t.description as string) || ''])) as Record<string, string>
  ok('6a. connection_status is the STANDARD entry for "which account am I connected as / scopes"',
    /which WebAZ account am I connected as/i.test(desc['webaz_connection_status']) && /STANDARD, canonical entry point/i.test(desc['webaz_connection_status']))
  ok('6b. webaz_profile description routes connection-status queries to webaz_connection_status', desc['webaz_profile'].includes('webaz_connection_status'))
  ok('6c. webaz_profile explicitly states view is NOT OAuth-reachable (api_key business identity)', /NOT reachable through an OAuth token|api_key business-identity/i.test(desc['webaz_profile']))
  // 6d — connection_status is a zero-param tool; its inputSchema must match the LOADABLE shape of webaz_info
  //   exactly ({type:'object',properties:{}} with NO `required`). A stray `required: []` on empty properties
  //   can make a strict client (ChatGPT connector) drop the tool from its registry.
  const schemaOf = (n: string): unknown => tools.find(t => t.name === n)?.inputSchema
  ok('6d. connection_status inputSchema == webaz_info shape (zero-param, no stray `required: []`)',
    JSON.stringify(schemaOf('webaz_connection_status')) === JSON.stringify(schemaOf('webaz_info')))

  await client.close(); await server.close()

  if (fail > 0) { console.error(`\n❌ mcp tool annotations FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ mcp tool annotations: ${tools.length}/${tools.length} carry 3 boolean hints · map==live names · classification locks · stdio+remote share buildMcpServer (no drift)\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
