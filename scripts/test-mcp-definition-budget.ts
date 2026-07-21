#!/usr/bin/env tsx
/**
 * MCP Token PR-7 — 定义/响应预算 ratchet 守卫。
 *   用法:npm run test:mcp-definition-budget
 *
 * 面级字节【有界余量预算】(收紧靠 review 纪律,与 complexity-ratchet 同哲学):tools/list 面级字节、单工具描述/定义上限、
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

// ── 面级 UTF-8 字节【有界余量预算】(诚实定性:任何仓内常量都可被 PR 编辑,"只降不升"最终靠
//   review 纪律,与 complexity-ratchet 同哲学)。守卫职责:①膨胀 > ceiling 必红;②ceiling 距实测
//   余量 ≤9% —— 静默抬顶(不真瘦身)会立刻撞余量检查,改动必须显式且可 review。
// PR-5 显式抬顶(可 review 的正当增长):draft/submit 两个 outputSchema + QuoteAndApproval
// outputTemplate 元数据 ≈ +2.5KB(buyer 41,764 / full 106,199 实测)。余量仍 ≤9%。
const CEILINGS = { buyer: 44_300, seller: 42_500, full: 110_000 }   // 口令/anchor 直达参数(真新能力,非描述膨胀):buyer 44100→44300 登记式上调   // A3-1:+55B 为 5 个 outputTemplate 的版本化哈希段(宿主模板缓存击穿的结构性成本,非描述膨胀);buyer 顶棚 44000→44100 登记式上调
const utf8 = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')
for (const surface of ['buyer', 'seller', 'full'] as const) {
  const tools = await listVia({ isolated: true, surface })
  const bytes = utf8(tools)
  ok(`B-1 ${surface} tools/list ≤ ${CEILINGS[surface]}B UTF-8 AND ceiling ≤ actual×1.09 (bounded-headroom budget)`,
    bytes <= CEILINGS[surface] && CEILINGS[surface] <= Math.ceil(bytes * 1.09), `bytes=${bytes} ceiling=${CEILINGS[surface]}`)
  console.log(`  [budget] surface=${surface} tools=${tools.length} utf8=${bytes}B (~${Math.ceil(bytes / 4)} tok, headroom ${(100 * (CEILINGS[surface] / bytes - 1)).toFixed(1)}%)`)
}

// ── 单工具 ceiling:描述 ≤2600 字符 / 单定义 ≤7000 UTF-8 字节(现最大 contribute≈2475 / list_product≈6.6KB)──
const full = await listVia({ isolated: false })
const worstDesc = full.map(t => ({ n: t.name, l: (t.description ?? '').length })).sort((a, b) => b.l - a.l)[0]
const worstDef = full.map(t => ({ n: t.name, l: utf8(t) })).sort((a, b) => b.l - a.l)[0]
ok('B-2 every tool description ≤ 2600 chars', worstDesc.l <= 2600, `${worstDesc.n}=${worstDesc.l}`)
ok('B-3 every tool definition ≤ 7000 UTF-8 bytes serialized', worstDef.l <= 7000, `${worstDef.n}=${worstDef.l}`)

// ── 源锁:全局 minify + search 默认 5 + 遥测字段 ──
const L1 = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
ok('B-4 global response serialization is MINIFIED (no pretty/indent stringify variant anywhere in the wrapper)',
  !/text: JSON\.stringify\(result,\s*null/.test(L1) && !/JSON\.stringify\(result,\s*undefined,\s*\d/.test(L1) && L1.includes('JSON.stringify(result) }'))
ok('B-5 search page clamped ≤5 (A4 宁缺毋滥)', L1.includes('Math.floor(Number(args.limit ?? 5))') && L1.includes('if (limit > 5) limit = 5'))
ok('B-6 response_bytes telemetry recorded per call (mcp_tool_calls.response_bytes)',
  L1.includes('response_bytes') && L1.includes('recordToolCall(name, args, result, latencyMs, responseBytes)') && L1.includes("Buffer.byteLength(envelope.content[0].text, 'utf8')"))

// ── 行为验证:minify 生效(任意非结构化工具输出不含缩进换行)+ 遥测行真实落库 ──
{
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer({}).connect(st)
  const c = new Client({ name: 'budget-run', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const texts: string[] = []
  for (const tn of ['webaz_get_status', 'webaz_info', 'webaz_price_history']) {
    const r0 = await c.callTool({ name: tn, arguments: {} }) as Record<string, unknown>
    texts.push((r0.content as Array<{ text: string }>)[0].text)
  }
  ok('B-7 non-structured tool texts are minified across tools (no whitespace-indented lines at all)', texts.every(t => !/\n\s+"/.test(t)), texts[0].slice(0, 80))
  const { default: Database } = await import('better-sqlite3')
  const db2 = new Database(join(tmpHome, '.webaz', 'webaz.db'))
  const row = db2.prepare("SELECT response_bytes FROM mcp_tool_calls WHERE tool_name = 'webaz_get_status' ORDER BY id DESC LIMIT 1").get() as { response_bytes: number | null } | undefined
  ok('B-8 telemetry row = EXACT UTF-8 byte count of the wire text (measurement correctness, not just >0)',
    !!row && Number(row.response_bytes) === Buffer.byteLength(texts[0], 'utf8'), `db=${row?.response_bytes} expected=${Buffer.byteLength(texts[0], 'utf8')}`)
}

// ── 行为锁:信封构造对不可序列化/恶意 throw 的鲁棒性(遥测永不被吞)──
{
  const { buildToolEnvelope } = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { buildToolEnvelope: (n: string, r: unknown) => { content: Array<{ text: string }>; isError?: boolean } }
  const circular: Record<string, unknown> = {}; circular.self = circular
  const e1 = buildToolEnvelope('webaz_get_status', circular)
  ok('B-9 circular result → structured isError envelope (no throw, telemetry path survives)', e1.isError === true && /serialization failed/.test(e1.content[0].text), e1.content[0].text.slice(0, 100))
  const e2 = buildToolEnvelope('webaz_get_status', { toJSON() { throw null } })
  ok('B-10 non-Error throw (null) from toJSON → still a structured isError envelope', e2.isError === true && /serialization failed/.test(e2.content[0].text), e2.content[0].text.slice(0, 100))
  const hostile = { toJSON() { throw { [Symbol.toPrimitive]() { throw new Error('hostile') }, toString() { throw new Error('hostile') } } } }
  const e3 = buildToolEnvelope('webaz_get_status', hostile)
  ok('B-11 HOSTILE thrown value (String() itself throws) → still a structured isError envelope (nested fallback)', e3.isError === true && /unserializable thrown value/.test(e3.content[0].text), e3.content[0].text.slice(0, 100))
}

if (fail > 0) { console.error(`\n❌ mcp-definition-budget FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-definition-budget: 面级/单工具 ceiling + minify + 遥测 — 全绿\n  ✅ pass ${pass}`)
