#!/usr/bin/env tsx
/**
 * BUG-09 — remoteMcpManifest() version advertisement is honest and non-conflated.
 * Usage: npx tsx scripts/test-mcp-manifest-version.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-manifest-'))
process.env.WEBAZ_REMOTE_MCP = '1'
delete process.env.WEBAZ_MODE

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

async function main(): Promise<void> {
  const { remoteMcpManifest } = await import('../src/pwa/routes/mcp-remote.js')
  const { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = await import('@modelcontextprotocol/sdk/types.js')
  const m = remoteMcpManifest() as Record<string, unknown> | null
  ok('manifest present when WEBAZ_REMOTE_MCP=1', !!m)
  if (m) {
    ok('protocol_version === SDK LATEST_PROTOCOL_VERSION (drift-proof, not a hardcoded literal)', m.protocol_version === LATEST_PROTOCOL_VERSION)
    ok('protocol_version is the current core spec (2025-11-25), not the stale 2025-03-26 default', m.protocol_version === '2025-11-25')
    ok('protocol_versions_supported === SDK SUPPORTED_PROTOCOL_VERSIONS', JSON.stringify(m.protocol_versions_supported) === JSON.stringify([...SUPPORTED_PROTOCOL_VERSIONS]))
    ok('supported list includes the latest', Array.isArray(m.protocol_versions_supported) && (m.protocol_versions_supported as string[]).includes(LATEST_PROTOCOL_VERSION))
    const ext = m.mcp_apps_extension as Record<string, unknown> | undefined
    ok('MCP Apps extension version reported SEPARATELY (2026-01-26 / SEP-1865)', !!ext && ext.spec_version === '2026-01-26' && ext.sep === 'SEP-1865')
    ok('core protocol_version is NOT conflated with the apps-extension version', m.protocol_version !== '2026-01-26')
    ok('capability negotiation note present (handshake, not a static claim)', typeof m.protocol_negotiation === 'string' && /initialize/.test(String(m.protocol_negotiation)))
  }
  if (fail > 0) { console.error(`\n❌ manifest version FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ mcp manifest version: latest=${LATEST_PROTOCOL_VERSION}, supported list drift-proof, apps-ext (2026-01-26) not conflated\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
