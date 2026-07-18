#!/usr/bin/env tsx
/**
 * MCP Token PR-3 — 工具面(surface bundle)+ webaz_info 资源化锁。
 *   用法:npm run test:mcp-tool-surfaces
 *
 * 锁:①buyer/seller 面成员全部真实存在(防拼写错静默缩面);②面内容精确锁(计数+关键工具);
 *    ③in-memory 服务端 listTools 按 surface 过滤,stdio 恒全量;④定义体积:buyer ≤ 50% full(基准打印);
 *    ⑤webaz_info 默认瘦身(禁重复 tools 清单)/{full:true} 与 resource webaz://guide/info 完整还原;
 *    ⑥surface 只裁可见性:CallTool 对面外工具照常分发(e2e 版在 test-remote-mcp 4f)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-surf-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'sandbox'; delete process.env.WEBAZ_API_KEY

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
initDatabase()
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { buildMcpServer: (o?: Record<string, unknown>) => { connect: (t: unknown) => Promise<void> } }
const { BUYER_SURFACE_TOOLS, SELLER_SURFACE_TOOLS, resolveSurface } = await import('../src/layer1-agent/L1-1-mcp-server/tool-surfaces.js')
const { TOOL_ANNOTATIONS } = await import('../src/layer1-agent/L1-1-mcp-server/tool-annotations.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const allNames = new Set(Object.keys(TOOL_ANNOTATIONS))
ok('T-1 every buyer-surface member is a REAL tool (typo → silent shrink forbidden)', [...BUYER_SURFACE_TOOLS].every(n => allNames.has(n)), [...BUYER_SURFACE_TOOLS].filter(n => !allNames.has(n)).join(','))
ok('T-2 every seller-surface member is a REAL tool', [...SELLER_SURFACE_TOOLS].every(n => allNames.has(n)))
ok('T-3 buyer surface count lock = 21 (core shopping chain complete)',
  BUYER_SURFACE_TOOLS.size === 21 && ['webaz_search', 'webaz_discover', 'webaz_quote_order', 'webaz_order_draft', 'webaz_submit_order_request', 'webaz_buyer_orders', 'webaz_approval_requests', 'webaz_buyer_action_request', 'webaz_order_chat', 'webaz_wallet_view', 'webaz_prepare_case'].every(n => BUYER_SURFACE_TOOLS.has(n)))
ok('T-4 seller surface count lock = 23 + no arbitration/governance', SELLER_SURFACE_TOOLS.size === 23 && !SELLER_SURFACE_TOOLS.has('webaz_dispute') && !SELLER_SURFACE_TOOLS.has('webaz_contribute'))
ok('T-5 resolveSurface precedence: explicit > api_key(full) > default buyer; invalid → fallback',
  resolveSurface('seller', 'api_key') === 'seller' && resolveSurface(undefined, 'api_key') === 'full'
  && resolveSurface(undefined, 'grant') === 'buyer' && resolveSurface(undefined, 'none') === 'buyer' && resolveSurface('hax', 'none') === 'buyer')

const listVia = async (opts: Record<string, unknown>): Promise<Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }>> => {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer(opts).connect(st)
  const c = new Client({ name: 'surf-test', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const { tools } = await c.listTools()
  return tools as Array<{ name: string }>
}

const stdio = await listVia({})
const full = await listVia({ isolated: true, surface: 'full' })
const buyer = await listVia({ isolated: true, surface: 'buyer' })
const seller = await listVia({ isolated: true, surface: 'seller' })
ok('T-6 stdio (no surface) = full local set (55)', stdio.length === 55, String(stdio.length))
ok('T-7 remote full = 54 (webaz_pair hidden)', full.length === 54, String(full.length))
ok('T-8 remote buyer = exact buyer set', buyer.length === 21 && buyer.every(t => BUYER_SURFACE_TOOLS.has(t.name)))
ok('T-9 remote seller = exact seller set', seller.length === 23 && seller.every(t => SELLER_SURFACE_TOOLS.has(t.name)))

const bytesOf = (t: unknown[]): number => JSON.stringify(t).length
const fullB = bytesOf(full), buyerB = bytesOf(buyer)
ok('T-10 buyer surface definition bytes ≤ 50% of full (token headline)', buyerB <= fullB * 0.5, `full=${fullB}B buyer=${buyerB}B (${(100 * buyerB / fullB).toFixed(1)}%)`)
console.log(`  [tools/list bytes] full=${fullB}B (~${Math.ceil(fullB / 4)} tok) buyer=${buyerB}B (~${Math.ceil(buyerB / 4)} tok) seller=${bytesOf(seller)}B — buyer=${(100 * buyerB / fullB).toFixed(1)}% of full`)

// webaz_info 瘦身 + 资源还原
{
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer({}).connect(st)
  const c = new Client({ name: 'surf-info', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const slim = await c.callTool({ name: 'webaz_info', arguments: {} }) as Record<string, unknown>
  const slimTxt = (slim.content as Array<{ text: string }>)[0].text
  const slimJ = JSON.parse(slimTxt) as Record<string, unknown>
  ok('I-1 default webaz_info is SLIM: no available_tools/for_end_user/for_contributors/commission_model/roles/economics/search_routing',
    ['available_tools', 'for_end_user', 'for_contributors', 'commission_model', 'roles', 'economics', 'search_routing'].every(k => !(k in slimJ)))
  ok('I-2 slim keeps the honesty core: network_state + live_stats + quick_start + full_guide pointer',
    !!slimJ.network_state && 'live_stats' in slimJ && !!slimJ.quick_start && !!(slimJ.full_guide as Record<string, unknown>)?.resource)
  ok('I-3 slim ≤5KB local (production was ~35KB)', slimTxt.length <= 5000, `len=${slimTxt.length}`)
  const fullInfo = await c.callTool({ name: 'webaz_info', arguments: { full: true } }) as Record<string, unknown>
  const fullJ = JSON.parse((fullInfo.content as Array<{ text: string }>)[0].text) as Record<string, unknown>
  ok('I-4 {full:true} restores the long form (available_tools + commission_model + roles)', !!fullJ.available_tools && !!fullJ.commission_model && !!fullJ.roles)
  const res = await c.listResources()
  const uris = res.resources.map(r => r.uri)
  ok('I-5 resources/list advertises webaz://guide/info alongside the protocol manifest', uris.includes('webaz://guide/info') && uris.some(u => u.includes('manifest')), uris.join(','))
  const guide = await c.readResource({ uri: 'webaz://guide/info' })
  const guideJ = JSON.parse((guide.contents as Array<{ text: string }>)[0].text) as Record<string, unknown>
  // 深度同一性:两条路径都出自 buildInfoFull();归一已知动态字段(实时统计/时间戳/更新检查)后逐字节相等
  const normalize = (o: Record<string, unknown>): Record<string, unknown> => {
    const c2 = JSON.parse(JSON.stringify(o)) as Record<string, unknown>
    delete c2.live_stats; delete c2.mcp; delete c2.network_state
    delete c2._mode; delete c2._sandbox_note   // CallTool 包装戳(资源路径无)
    const ec = c2.economics as Record<string, unknown> | undefined
    if (ec) delete ec.charity_fund
    return c2
  }
  ok('I-6 guide resource ≡ {full:true} long form (deep compare after normalizing dynamic fields — zero content deletion)',
    JSON.stringify(normalize(guideJ)) === JSON.stringify(normalize(fullJ)),
    `guideKeys=${Object.keys(guideJ).sort().join(',')} fullKeys=${Object.keys(fullJ).sort().join(',')}`)
  ok('I-7 long form retains EVERY moved section (roles/economics/search_routing/tools_note included)',
    ['available_tools', 'for_end_user', 'for_contributors', 'commission_model', 'roles', 'economics', 'search_routing', 'tools_note'].every(k => k in guideJ), Object.keys(guideJ).sort().join(','))
  // ProductResults(PR-4):资源在列、widget 自包含读 toolOutput、三形态渲染、textContent 纪律
  const uiRes = res.resources.find(r => r.uri === 'ui://widget/webaz-products.html')
  ok('U-1 ui://widget/webaz-products.html advertised (text/html+skybridge)', !!uiRes && uiRes.mimeType === 'text/html+skybridge')
  const widget = await c.readResource({ uri: 'ui://widget/webaz-products.html' })
  const html = (widget.contents as Array<{ text: string }>)[0].text
  ok('U-2 widget self-contained (reads window.openai.toolOutput; zero external URLs)',
    html.includes('window.openai') && html.includes('toolOutput') && !/https?:\/\//.test(html))
  ok('U-2b widget handles ALL THREE structuredContent shapes (search page / detail / zero-hit recovery)',
    html.includes('webaz.product_detail.model.v1') && html.includes('catalog_sample') && html.includes('next_cursor'))
  ok('U-2c widget never uses innerHTML (seller-controlled titles → textContent only) and economic entry returns to the conversation flow',
    !html.includes('innerHTML') && html.includes('sendFollowupTurn') && html.includes('Passkey'))
  const widgetMeta = ((widget.contents as Array<{ _meta?: Record<string, unknown> }>)[0]._meta ?? {}) as Record<string, unknown>
  ok('U-2d widget declares CSP (empty domain sets — zero external requests) + unique widget domain (ChatGPT app-submission requirement)',
    JSON.stringify((widgetMeta['openai/widgetCSP'] as Record<string, unknown>)?.connect_domains) === '[]' && widgetMeta['openai/widgetDomain'] === 'https://webaz.xyz')
}
{
  const L1src = (await import('node:fs')).readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('U-3 webaz_search descriptor carries openai/outputTemplate → ui://widget/webaz-products.html (search IS the rendered tool)',
    L1src.includes("'openai/outputTemplate': 'ui://widget/webaz-products.html'"))
  ok('U-4 spike tool fully retired (no webaz_ui_spike anywhere in the registry)', !L1src.includes('webaz_ui_spike'))
}

if (fail > 0) { console.error(`\n❌ mcp-tool-surfaces FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-tool-surfaces: surface bundle(可见性≠授权)+ webaz_info 资源化 — 全绿\n  ✅ pass ${pass}`)
