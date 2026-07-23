#!/usr/bin/env tsx
/**
 * MCP Token PR-3 — 工具面(surface bundle)+ webaz_info 资源化锁。
 *   用法:npm run test:mcp-tool-surfaces
 *
 * 锁:①buyer/seller 面成员全部真实存在(防拼写错静默缩面);②面内容精确锁(计数+关键工具);
 *    ③in-memory 服务端 listTools 按 surface 过滤,stdio 恒全量;④定义体积:buyer ≤ 50% full(基准打印);
 *    ⑤webaz_info 默认瘦身(禁重复 tools 清单)/{full:true} 与 resource webaz://guide/info 完整还原;
 *    ⑥buyer/seller 只裁可见性;公开审核的 shopping_v1 对面外 tools/call 硬拒。
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
const { SHOPPING_V1_SURFACE_TOOLS, BUYER_SURFACE_TOOLS, SELLER_SURFACE_TOOLS, resolveSurface } = await import('../src/layer1-agent/L1-1-mcp-server/tool-surfaces.js')
const { TOOL_ANNOTATIONS } = await import('../src/layer1-agent/L1-1-mcp-server/tool-annotations.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const allNames = new Set(Object.keys(TOOL_ANNOTATIONS))
const SHOPPING_V1_EXPECTED = ['webaz_search']
ok('T-0 shopping_v1 is the exact reviewed discovery-only contract',
  JSON.stringify([...SHOPPING_V1_SURFACE_TOOLS].sort()) === JSON.stringify(SHOPPING_V1_EXPECTED)
  && [...SHOPPING_V1_SURFACE_TOOLS].every(n => allNames.has(n)))
ok('T-1 every buyer-surface member is a REAL tool (typo → silent shrink forbidden)', [...BUYER_SURFACE_TOOLS].every(n => allNames.has(n)), [...BUYER_SURFACE_TOOLS].filter(n => !allNames.has(n)).join(','))
ok('T-2 every seller-surface member is a REAL tool', [...SELLER_SURFACE_TOOLS].every(n => allNames.has(n)))
ok('T-3 buyer surface count lock = 21 (core shopping chain complete)',
  BUYER_SURFACE_TOOLS.size === 21 && ['webaz_search', 'webaz_discover', 'webaz_quote_order', 'webaz_order_draft', 'webaz_submit_order_request', 'webaz_buyer_orders', 'webaz_approval_requests', 'webaz_buyer_action_request', 'webaz_order_chat', 'webaz_wallet_view', 'webaz_prepare_case'].every(n => BUYER_SURFACE_TOOLS.has(n)))
ok('T-4 seller surface count lock = 23 + no arbitration/governance', SELLER_SURFACE_TOOLS.size === 23 && !SELLER_SURFACE_TOOLS.has('webaz_dispute') && !SELLER_SURFACE_TOOLS.has('webaz_contribute'))
ok('T-5 resolveSurface precedence: explicit > api_key(full) > default buyer; supplied invalid values fail closed',
  resolveSurface('shopping_v1', 'api_key') === 'shopping_v1' && resolveSurface('seller', 'api_key') === 'seller' && resolveSurface(undefined, 'api_key') === 'full'
  && resolveSurface(undefined, 'grant') === 'buyer' && resolveSurface(undefined, 'none') === 'buyer'
  && resolveSurface('hax', 'none') === null && resolveSurface('', 'none') === null && resolveSurface(['shopping_v1'], 'none') === null)

type ListedTool = { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }
const listVia = async (opts: Record<string, unknown>): Promise<ListedTool[]> => {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer(opts).connect(st)
  const c = new Client({ name: 'surf-test', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const { tools } = await c.listTools()
  return tools as ListedTool[]
}

const stdio = await listVia({})
const full = await listVia({ isolated: true, surface: 'full' })
const shopping = await listVia({ isolated: true, surface: 'shopping_v1' })
const buyer = await listVia({ isolated: true, surface: 'buyer' })
const seller = await listVia({ isolated: true, surface: 'seller' })
ok('T-6 stdio (no surface) = full local set (55)', stdio.length === 55, String(stdio.length))
ok('T-7 remote full = 54 (webaz_pair hidden)', full.length === 54, String(full.length))
ok('T-7a remote shopping_v1 = exact reviewed set in deterministic registry order',
  shopping.length === 1 && JSON.stringify(shopping.map(t => t.name).sort()) === JSON.stringify(SHOPPING_V1_EXPECTED), shopping.map(t => t.name).join(','))
ok('T-7b every reviewed tool carries complete annotations',
  shopping.every(t => ['readOnlyHint', 'destructiveHint', 'openWorldHint'].every(k => typeof t.annotations?.[k] === 'boolean')))
ok('T-7c the sole reviewed tool renders the existing product card',
  JSON.stringify(shopping.filter(t => typeof t._meta?.['openai/outputTemplate'] === 'string').map(t => t.name).sort())
    === JSON.stringify(['webaz_search']))
{
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await mcp.buildMcpServer({ isolated: true, surface: 'shopping_v1' }).connect(st)
  const c = new Client({ name: 'shopping-call-boundary', version: '0' }, { capabilities: {} })
  await c.connect(ct)
  const blocked = await c.callTool({ name: 'webaz_quote_order', arguments: {} }) as Record<string, unknown>
  const text = (blocked.content as Array<{ text?: string }> | undefined)?.map(item => item.text ?? '').join('') ?? ''
  ok('T-7d cached out-of-scope calls are rejected before their handler',
    /TOOL_NOT_AVAILABLE_ON_SURFACE/.test(text), text.slice(0, 160))
}
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
  const uiRes = res.resources.find(r => r.mimeType === 'text/html+skybridge' && r.uri.startsWith('ui://widget/webaz-products.'))   // BUG-04: versioned URI, match by base
  ok('U-1 ui://widget/webaz-products.html advertised (text/html+skybridge)', !!uiRes && uiRes.mimeType === 'text/html+skybridge')
  const widget = await c.readResource({ uri: 'ui://widget/webaz-products.html' })
  const html = (widget.contents as Array<{ text: string }>)[0].text
  // 词元存在即禁(Codex round-2:与空白/属性赋值/括号访问形式无关 —— document['write'] 也含 write 词元)。
  // 残余边界(诚实声明):字符串拼接构造('wr'+'ite')不可静态锁 —— widget 是一方代码,由 review+审计守。
  // A3-2b:ProductResults 获得与审批卡同级的 LINK compat(打开审批页)—— href 词元仅经 safeWebazHref 白名单面出现;其余请求词元照禁,零 URL 字面量锁不变。
  const REQUEST_TOKENS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import|src|location)\b/
  const SINK_TOKENS = /\b(innerHTML|outerHTML|insertAdjacentHTML|write|writeln|eval|Function)\b/
  ok('U-2 widget self-contained (reads window.openai.toolOutput; zero request-capability TOKENS present in any form)',
    html.includes('window.openai') && html.includes('toolOutput')
    && !/["'\`](https?:)?\/\//.test(html) && !REQUEST_TOKENS.test(html) && html.includes('safeWebazHref'))
  ok('U-2b widget handles ALL THREE structuredContent shapes (search page / detail / zero-hit recovery)',
    html.includes('webaz.product_detail.model.v1') && html.includes('related_products') && html.includes('more_url'))
  ok('U-2e widget fx line: reads fx table, USDC sample labels via price_display, stale marker, and a visible non-settlement disclosure',
    html.includes('out.fx') && html.includes('≈') && html.includes('price_display') && html.includes('stale') && html.includes('非结算') && !html.includes(' WAZ'))
  ok('U-2c widget has NO executable/HTML sink TOKENS in any form (incl bracket access) and economic entry returns to the conversation flow',
    !SINK_TOKENS.test(html) && html.includes('sendFollowupTurn') && html.includes('Passkey'))
  const widgetMeta = ((widget.contents as Array<{ _meta?: Record<string, unknown> }>)[0]._meta ?? {}) as Record<string, unknown>
  const listMeta = ((uiRes ?? {}) as { _meta?: Record<string, unknown> })._meta ?? {}
  const csp = (widgetMeta['openai/widgetCSP'] ?? {}) as Record<string, unknown>
  ok('U-2d widget CSP declares BOTH empty domain sets + unique domain, IDENTICAL on resources/list and resources/read',
    JSON.stringify(csp.connect_domains) === '[]' && JSON.stringify(csp.resource_domains) === '[]'
    && widgetMeta['openai/widgetDomain'] === 'https://webaz.xyz'
    && JSON.stringify(listMeta) === JSON.stringify(widgetMeta))
}
{
  // U-3 走 WIRE:in-memory client 拿到的 webaz_search 描述符必须携带 outputTemplate _meta(非源码 grep)
  const searchTool = full.find(t => t.name === 'webaz_search') as (Record<string, unknown> & { _meta?: Record<string, unknown> }) | undefined
  // A3(B-2 v2):outputTemplate 回版本化(宿主模板缓存击穿);过期 URI 走 allowlist 兜底。
  ok('U-3 webaz_search WIRE descriptor carries openai/outputTemplate → VERSIONED ui://widget/webaz-products.<hash>.html (A3)',
    /^ui:\/\/widget\/webaz-products\.[0-9a-f]{10}\.html$/.test(String(searchTool?._meta?.['openai/outputTemplate'] ?? '')), JSON.stringify(searchTool?._meta ?? null))
  // U-4 残留扫全部注册面文件(不只 server.ts)+ 权威文档
  const fs2 = await import('node:fs')
  const residue = ['src/layer1-agent/L1-1-mcp-server/server.ts', 'src/layer1-agent/L1-1-mcp-server/tool-annotations.ts',
    'src/layer1-agent/L1-1-mcp-server/tool-surfaces.ts', 'src/layer1-agent/L1-1-mcp-server/network-mode.ts',
    'src/layer1-agent/L1-1-mcp-server/tool-security-schemes.ts', 'src/agent-model-projection.ts', 'docs/REMOTE-MCP.md']
    .filter(f => fs2.readFileSync(f, 'utf8').includes('webaz_ui_spike'))
  ok('U-4 spike fully retired across ALL registry surfaces + docs (zero residue)', residue.length === 0, residue.join(','))
}

if (fail > 0) { console.error(`\n❌ mcp-tool-surfaces FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-tool-surfaces: surface bundle(可见性≠授权)+ webaz_info 资源化 — 全绿\n  ✅ pass ${pass}`)
