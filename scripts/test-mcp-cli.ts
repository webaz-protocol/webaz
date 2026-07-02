#!/usr/bin/env tsx
/**
 * MCP CLI 标志 (audit Claim 6) —— --version / --help / --mode / --doctor,不启动 stdio server 即可验证安装。
 * 验 cliQuickResponse(纯)+ resolveMode(单一真相源,与 server.ts 同)+ runDoctor(注入 fetch,可达/不可达/降级/sandbox)
 *   + mcp.ts 接线(无标志才启动 server)。
 * Usage: npm run test:mcp-cli
 */
import { readFileSync } from 'fs'

const { cliQuickResponse, runDoctor } = await import('../src/layer1-agent/L1-1-mcp-server/cli.js')
const { resolveMode } = await import('../src/layer1-agent/L1-1-mcp-server/network-mode.js')
const { SOFTWARE_VERSION } = await import('../src/version.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? ` (${d})` : ''}`) } }

// ── cliQuickResponse ──
ok('--version → SOFTWARE_VERSION', cliQuickResponse(['--version'], {}) === SOFTWARE_VERSION)
ok('-v → SOFTWARE_VERSION', cliQuickResponse(['-v'], {}) === SOFTWARE_VERSION)
const help = cliQuickResponse(['--help'], {}) || ''
ok('--help → usage + three modes + env', /Usage:/.test(help) && /network_readonly/.test(help) && /WEBAZ_MODE=sandbox/.test(help) && /WEBAZ_API_KEY/.test(help))
ok('-h → usage', /Usage:/.test(cliQuickResponse(['-h'], {}) || ''))
ok('--mode (no key) → network_readonly', cliQuickResponse(['--mode'], {}) === 'network_readonly')
ok('--mode (key) → network', cliQuickResponse(['--mode'], { WEBAZ_API_KEY: 'k' }) === 'network')
ok('--mode (WEBAZ_MODE=sandbox) → sandbox', cliQuickResponse(['--mode'], { WEBAZ_MODE: 'sandbox' }) === 'sandbox')
ok('no flag → null (mcp.ts starts server)', cliQuickResponse([], {}) === null)
ok('--doctor → null from quick (handled async by mcp.ts)', cliQuickResponse(['--doctor'], {}) === null)
ok('unknown flag → null (proceed to start)', cliQuickResponse(['--wat'], {}) === null)

// ── resolveMode (single source of truth; must match server.ts rule) ──
ok('resolveMode {} → network_readonly', resolveMode({}) === 'network_readonly')
ok("resolveMode {key:''} → network_readonly (empty key = no key)", resolveMode({ WEBAZ_API_KEY: '' }) === 'network_readonly')
ok('resolveMode {key} → network', resolveMode({ WEBAZ_API_KEY: 'k' }) === 'network')
ok('resolveMode explicit sandbox → sandbox (even without key)', resolveMode({ WEBAZ_MODE: 'sandbox' }) === 'sandbox')
ok('resolveMode explicit network (no key) → network', resolveMode({ WEBAZ_MODE: 'network' }) === 'network')
ok('resolveMode explicit readonly beats key', resolveMode({ WEBAZ_MODE: 'network_readonly', WEBAZ_API_KEY: 'k' }) === 'network_readonly')
ok('resolveMode case-insensitive (SANDBOX)', resolveMode({ WEBAZ_MODE: 'SANDBOX' }) === 'sandbox')

// ── runDoctor (injectable fetch — hermetic) ──
const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
const badFetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
const throwFetch = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
let fetchCalls = 0
const countingFetch = (async () => { fetchCalls++; return { ok: true, status: 200 } }) as unknown as typeof fetch

const dReach = await runDoctor({}, okFetch)
ok('doctor reachable: shows mode + reachability ok + api_url', /mode:\s+network_readonly/.test(dReach) && /reachability:\s+ok/.test(dReach) && /api_url:\s+https:\/\/webaz\.xyz/.test(dReach))
ok('doctor: no-key api_key line honest', /api_key:\s+not set/.test(dReach))
const dKey = await runDoctor({ WEBAZ_API_KEY: 'k' }, okFetch)
ok('doctor (key) → mode network + api_key set', /mode:\s+network\b/.test(dKey) && /api_key:\s+set/.test(dKey))
ok('doctor degraded (HTTP 503)', /reachability:\s+degraded \(HTTP 503\)/.test(await runDoctor({}, badFetch)))
ok('doctor unreachable (fetch throws)', /reachability:\s+unreachable \(ENOTFOUND\)/.test(await runDoctor({}, throwFetch)))
const dSandbox = await runDoctor({ WEBAZ_MODE: 'sandbox' }, countingFetch)
ok('doctor sandbox: reachability skipped, no fetch call', /skipped/.test(dSandbox) && fetchCalls === 0)
ok('doctor custom WEBAZ_API_URL honored', /api_url:\s+http:\/\/localhost:3000/.test(await runDoctor({ WEBAZ_API_URL: 'http://localhost:3000/' }, okFetch)))

// ── mcp.ts wiring: flags handled before server start; no-flag path starts server ──
const mcp = readFileSync('src/mcp.ts', 'utf8')
ok('mcp.ts calls cliQuickResponse before startMCPServer', mcp.indexOf('cliQuickResponse') < mcp.indexOf('startMCPServer('))
ok('mcp.ts handles --doctor', /runDoctor\(/.test(mcp) && /--doctor/.test(mcp))
ok('mcp.ts still starts server on no-flag (else branch)', /else\s*{[\s\S]*startMCPServer\(/.test(mcp))

if (fail > 0) { console.error(`\n❌ MCP CLI FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ MCP CLI: --version/--help/--mode/--doctor (no server boot) · resolveMode single-source · doctor reachable/degraded/unreachable/sandbox · no-flag still starts server\n  ✅ pass ${pass}`)
