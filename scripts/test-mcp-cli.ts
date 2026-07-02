#!/usr/bin/env tsx
/**
 * MCP CLI 标志 (audit Claim 6) —— --version / --help / --mode / --doctor,不启动 stdio server 即可验证安装。
 * 验 cliQuickResponse(纯)+ resolveMode(单一真相源,与 server.ts 同)+ runDoctor(注入 fetch,可达/不可达/降级/sandbox)
 *   + mcp.ts 接线(无标志才启动 server)。
 * Usage: npm run test:mcp-cli
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

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
ok('mcp.ts calls cliQuickResponse before loading server', mcp.indexOf('cliQuickResponse') < mcp.indexOf('startMCPServer('))
ok('mcp.ts handles --doctor', /runDoctor\(/.test(mcp) && /--doctor/.test(mcp))
ok('mcp.ts does NOT statically import server.js (no DB side-effect on flags)', !/^\s*import\s+[^\n]*from\s+['"][^'"]*server\.js['"]/m.test(mcp))
ok('mcp.ts dynamically imports server.js only to start', /await import\(['"][^'"]*server\.js['"]\)/.test(mcp) && /startMCPServer\(/.test(mcp))

// ── real-bin spawn: flags must NOT load server.js / init a DB / pollute stdout (ESM import side-effect; #186 audit P1) ──
const TSX = join('node_modules', '.bin', 'tsx')
function runBin(flag: string): { code: number; stdout: string; stderr: string; dbCreated: boolean } {
  const home = mkdtempSync(join(tmpdir(), 'mcp-cli-'))
  try {
    const r = spawnSync(TSX, ['src/mcp.ts', flag], { encoding: 'utf8', env: { ...process.env, HOME: home, WEBAZ_MODE: '', WEBAZ_API_KEY: '' }, timeout: 60000 })
    return { code: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: r.stderr || '', dbCreated: existsSync(join(home, '.webaz', 'webaz.db')) }
  } finally { rmSync(home, { recursive: true, force: true }) }
}
const rv = runBin('--version')
ok('spawn --version: exit 0', rv.code === 0)
ok('spawn --version: stdout is ONLY the version (clean, no init log)', rv.stdout === SOFTWARE_VERSION, JSON.stringify(rv.stdout))
ok('spawn --version: did NOT load server (no L0-1 init log on stderr)', !/L0-1|数据库初始化/.test(rv.stderr))
ok('spawn --version: did NOT create a local .webaz DB (no side effect)', rv.dbCreated === false)
const rm = runBin('--mode')
ok('spawn --mode: exit 0, clean stdout network_readonly', rm.code === 0 && rm.stdout === 'network_readonly')
ok('spawn --mode: no DB side effect', rm.dbCreated === false)
const rh = runBin('--help')
ok('spawn --help: exit 0, usage on stdout, no DB', rh.code === 0 && /Usage:/.test(rh.stdout) && rh.dbCreated === false)

if (fail > 0) { console.error(`\n❌ MCP CLI FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ MCP CLI: --version/--help/--mode/--doctor (no server boot) · resolveMode single-source · doctor reachable/degraded/unreachable/sandbox · no-flag still starts server\n  ✅ pass ${pass}`)
