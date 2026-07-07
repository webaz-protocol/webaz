#!/usr/bin/env tsx
/**
 * webaz_info surfaces an MCP update nudge (mcp_version / latest_version / update_available) so agents don't
 *   have to reason out a stale connector by hand. npm is the source of truth (the live server version can lag
 *   a publish). Tests the NUMERIC semver comparator (the risky bit) + that the nudge is wired into handleInfo,
 *   network-gated + fail-safe.
 * Usage: npm run test:mcp-version-nudge
 */
import { readFileSync } from 'node:fs'
process.env.WEBAZ_MODE = 'sandbox'   // avoid a live npm/registry call in CI (checkMcpVersion is network-gated)

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
const SRC = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// ── NUMERIC semver compare (must not string-compare) ──
ok('0.1.30 < 0.1.31', mcp.isOlderVersion('0.1.30', '0.1.31') === true)
ok('0.1.31 is not older than itself', mcp.isOlderVersion('0.1.31', '0.1.31') === false)
ok('0.1.31 not older than 0.1.30', mcp.isOlderVersion('0.1.31', '0.1.30') === false)
ok('0.2.0 not older than 0.1.99 (minor beats patch)', mcp.isOlderVersion('0.2.0', '0.1.99') === false)
ok('NUMERIC not lexical: 0.1.9 < 0.1.10', mcp.isOlderVersion('0.1.9', '0.1.10') === true)
ok('1.0.0 newer than 0.9.9', mcp.isOlderVersion('1.0.0', '0.9.9') === false)

// ── wiring: webaz_info exposes the mcp block; network-gated; fail-safe; npm is the source ──
ok('handleInfo wires a checkMcpVersion() call', /const mcp = await checkMcpVersion\(\)/.test(SRC) && /\n\s*mcp,\s/.test(SRC))
ok('nudge fields present (mcp_version / latest_version / update_available)', /mcp_version:/.test(SRC) && /latest_version:/.test(SRC) && /update_available:/.test(SRC))
ok('npm registry is the source of truth (not the live server version)', /registry\.npmjs\.org\/@seasonkoh\/webaz\/latest/.test(SRC))
ok('network-gated (skipped in sandbox) + short timeout + never throws', /if \(!isNetworkMode\(\)\) return[\s\S]{0,120}sandbox/.test(SRC) && /AbortSignal\.timeout/.test(SRC) && /catch \(e\)[\s\S]{0,80}update_check/.test(SRC))
ok('update_note tells the agent to update connector + FULLY restart + NEW conversation', /Update your connector[\s\S]{0,160}NEW conversation/.test(SRC))

if (fail > 0) { console.error(`\n❌ mcp-version-nudge FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp version nudge: numeric semver compare (not lexical) + webaz_info exposes mcp_version/latest_version/update_available from npm (source of truth), network-gated + fail-safe, with a restart/new-conversation update_note\n  ✅ pass ${pass}`)
