#!/usr/bin/env tsx
/**
 * MCP Token PR-7 — 定义/响应预算 ratchet 守卫。
 *   用法:npm run test:mcp-definition-budget
 *
 * ceilings 只降不升(与 complexity-ratchet 同哲学):tools/list 面级字节、单工具描述/定义上限、
 * 全局 minify 源锁、search 默认页源锁、响应字节遥测在位。防止 token 优化被后续 PR 静默侵蚀。
 */
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-budget-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'sandbox'; delete process.env.WEBAZ_API_KEY

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
initDatabase()
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { buildMcpServer: (o?: Record<string, unknown>) => { connect: (t: unknown) => Promise<void> } }
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const listVia = async (opts: Record<string, unknown>): Promise<Array<{ name: string; description?: string }>> => {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer(opts).connect(st)
  const c = new Client({ name: 'budget-test', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  return (await c.listTools()).tools as Array<{ name: string; description?: string }>
}

// ── 面级字节 ceiling(只降不升;当前实测 buyer≈37.9KB / seller≈39KB / full≈101.7KB 本地)──
const CEILINGS = { buyer: 42_000, seller: 43_000, full: 108_000 }
for (const surface of ['buyer', 'seller', 'full'] as const) {
  const tools = await listVia({ isolated: true, surface })
  const bytes = JSON.stringify(tools).length
  ok(`B-1 ${surface} tools/list ≤ ${CEILINGS[surface]}B (ratchet — lower when you trim, never raise)`, bytes <= CEILINGS[surface], `bytes=${bytes}`)
  console.log(`  [budget] surface=${surface} tools=${tools.length} bytes=${bytes} (~${Math.ceil(bytes / 4)} tok)`)
}

// ── 单工具 ceiling:描述 ≤2600 字符 / 单定义 ≤7000B(现最大 contribute≈2475 / list_product≈6.6KB)──
const full = await listVia({ isolated: false })
const worstDesc = full.map(t => ({ n: t.name, l: (t.description ?? '').length })).sort((a, b) => b.l - a.l)[0]
const worstDef = full.map(t => ({ n: t.name, l: JSON.stringify(t).length })).sort((a, b) => b.l - a.l)[0]
ok('B-2 every tool description ≤ 2600 chars', worstDesc.l <= 2600, `${worstDesc.n}=${worstDesc.l}`)
ok('B-3 every tool definition ≤ 7000B serialized', worstDef.l <= 7000, `${worstDef.n}=${worstDef.l}`)

// ── 源锁:全局 minify + search 默认 5 + 遥测字段 ──
const L1 = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
ok('B-4 global response serialization is MINIFIED (no pretty-print JSON-in-text anywhere in the wrapper)',
  !L1.includes("text: JSON.stringify(result, null, 2)") && L1.includes('JSON.stringify(result) }'))
ok('B-5 search default page stays 5', L1.includes('Math.floor(Number(args.limit ?? 5))'))
ok('B-6 response_bytes telemetry recorded per call (mcp_tool_calls.response_bytes)',
  L1.includes('response_bytes') && L1.includes('recordToolCall(name, args, result, Date.now() - t0, responseBytes)'))

// ── 行为验证:minify 生效(任意非结构化工具输出不含缩进换行)+ 遥测行真实落库 ──
{
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer({}).connect(st)
  const c = new Client({ name: 'budget-run', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const r = await c.callTool({ name: 'webaz_get_status', arguments: {} }) as Record<string, unknown>
  const text = (r.content as Array<{ text: string }>)[0].text
  ok('B-7 non-structured tool text is minified (no two-space indent)', !text.includes('\n  "'), text.slice(0, 80))
  const { default: Database } = await import('better-sqlite3')
  const db2 = new Database(join(tmpHome, '.webaz', 'webaz.db'))
  const row = db2.prepare("SELECT response_bytes FROM mcp_tool_calls WHERE tool_name = 'webaz_get_status' ORDER BY id DESC LIMIT 1").get() as { response_bytes: number | null } | undefined
  ok('B-8 telemetry row carries response_bytes > 0', !!row && Number(row.response_bytes) > 0, JSON.stringify(row))
}

if (fail > 0) { console.error(`\n❌ mcp-definition-budget FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-definition-budget: 面级/单工具 ceiling + minify + 遥测 — 全绿\n  ✅ pass ${pass}`)
