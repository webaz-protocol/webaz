#!/usr/bin/env tsx
/**
 * MCP UI PR-A — 标准 MCP Apps 元数据 + 跨 Host Bridge:双轨一致性 + 桥选择/安全锁。
 *   用法:npm run test:mcp-apps-standard
 *
 * 覆盖(任务书 §十三):
 *   [T] 工具描述符:五 UI 工具标准 _meta.ui.resourceUri + legacy openai/outputTemplate 并存且 URI 不同;
 *       visibility 逐工具精确映射;widgetAccessible 在 widget 实际调用的 5 工具(Phase-3A:准备下单 DIRECT_TOOL 后 quote_order 加 app);匿名面仍 21。
 *   [R] 资源:legacy 3 个 skybridge 原值不动;standard 3 个 profile=mcp-app + ui.csp 四空数组 +
 *       无 ui.domain;URI 全局唯一;standard HTML 自包含(零请求词元/零 sink/零 WAZ)且单桥(legacy
 *       HTML 无标准桥词元)。
 *   [B] 桥(node:vm 驱动真实代码):标准握手成功→只用标准桥;超时→window.openai;全无→只读;
 *       pinned-origin 之外的消息被忽略;非 parent source 被忽略。
 *   [C] compat:safeWebazHref 拒绝矩阵;sendFollowUpCompat 优先级/单发/双缺失 false;onceGuard 防重。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-appstd-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY
process.env.WEBAZ_API_URL = 'http://127.0.0.1:1'   // 本套件只测 list/read 面,不打真路由

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const { __WIDGET_COMPAT_JS, __WIDGET_BRIDGE_STANDARD_JS, __WIDGET_BOOT_STANDARD_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { buildMcpServer: (o?: { surface?: string }) => { connect: (t: unknown) => Promise<void> } }
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

mkdirSync(join(tmpHome, '.webaz'), { recursive: true })
writeFileSync(join(tmpHome, '.webaz', 'credentials'), '{}', { mode: 0o600 })

// 匿名默认面 = buyer(21)—— 与生产 /mcp 匿名连接一致
const [ct, st] = InMemoryTransport.createLinkedPair()
await mcp.buildMcpServer({ surface: 'buyer' }).connect(st)
const c = new Client({ name: 'appstd-test', version: '0' }, { capabilities: {} })
await c.connect(ct)

try {
  // ── [T] 工具描述符 ────────────────────────────────────────────────────────────────────────
  const tools = (await c.listTools()).tools as Array<{ name: string; outputSchema?: unknown; _meta?: Record<string, unknown> }>
  ok('T-0. 匿名工具面仍 21(本 PR 零工具增减)', tools.length === 21, `n=${tools.length}`)
  // BUG-04: URIs are content-versioned. Assert per-tool std/legacy templates by COMPONENT BASE (version-agnostic),
  // both present in ListResources, std≠legacy, versioned pattern holds. Bare aliases resolve in R-5.
  const res = (await c.listResources()).resources as Array<{ uri: string; mimeType?: string; _meta?: Record<string, unknown> }>
  const uris = res.map(r => r.uri)
  const VER = /^ui:\/\/widget\/[a-z-]+\.[0-9a-f]{8,}\.html$/
  const baseOf = (u: string): string => u.replace(/\.[0-9a-f]{8,}\.html$/, '').replace(/-mcp$/, '')
  const legacyUris = res.filter(r => r.mimeType === 'text/html+skybridge').map(r => r.uri)
  const stdUris = res.filter(r => r.mimeType === 'text/html;profile=mcp-app').map(r => r.uri)
  const EXPECT: Record<string, { base: string; vis: string[]; app: boolean }> = {
    webaz_search:               { base: 'ui://widget/webaz-products',       vis: ['model', 'app'], app: true },
    webaz_quote_order:          { base: 'ui://widget/webaz-quote-approval', vis: ['model', 'app'], app: true },   // Phase-3A: 准备下单 DIRECT_TOOL → app-visible
    webaz_order_draft:          { base: 'ui://widget/webaz-quote-approval', vis: ['model', 'app'], app: true },
    webaz_submit_order_request: { base: 'ui://widget/webaz-quote-approval', vis: ['model', 'app'], app: true },
    webaz_buyer_orders:         { base: 'ui://widget/webaz-order-timeline', vis: ['model', 'app'], app: true },
  }
  for (const [name, e] of Object.entries(EXPECT)) {
    const t = tools.find(x => x.name === name)
    const m = (t?._meta ?? {}) as Record<string, unknown>
    const ui = (m.ui ?? {}) as Record<string, unknown>
    const ru = String(ui.resourceUri ?? ''), ot = String(m['openai/outputTemplate'] ?? '')
    ok(`T-1. ${name} 标准/legacy 双轨(版本化)+ base 一致 + visibility 精确`,
      VER.test(ru) && VER.test(ot) && ru !== ot
      && baseOf(ru) === e.base && baseOf(ot) === e.base
      && stdUris.includes(ru) && legacyUris.includes(ot)
      && JSON.stringify(ui.visibility) === JSON.stringify(e.vis)
      && (e.app ? m['openai/widgetAccessible'] === true : !('openai/widgetAccessible' in m))
      && !!t?.outputSchema, JSON.stringify(m).slice(0, 200))
  }
  const uiToolCount = tools.filter(t => (t._meta as Record<string, unknown> | undefined)?.ui).length
  ok('T-2. 只有 5 个工具带标准 ui meta(不外溢)', uiToolCount === 5, `n=${uiToolCount}`)

  // ── [R] 资源双轨(版本化 URI + 裸别名)────────────────────────────────────────────────────
  ok('R-0. 资源共 10 个且 URI 全局唯一', res.length === 10 && new Set(uris).size === 10, uris.join(','))
  ok('R-0b. 3 legacy(skybridge)+ 3 standard(mcp-app),全部内容版本化', legacyUris.length === 3 && stdUris.length === 3 && [...legacyUris, ...stdUris].every(u => VER.test(u)), `L=${legacyUris.length} S=${stdUris.length}`)
  for (const u of legacyUris) {
    const r = res.find(x => x.uri === u)!
    const m = (r._meta ?? {}) as Record<string, unknown>
    ok(`R-1. legacy ${u.slice(12)} skybridge + widgetCSP/domain 原值不动`, r.mimeType === 'text/html+skybridge'
      && JSON.stringify((m['openai/widgetCSP'] as Record<string, unknown>)?.connect_domains) === '[]'
      && m['openai/widgetDomain'] === 'https://webaz.xyz' && !('ui' in m))
  }
  for (const u of stdUris) {
    const r = res.find(x => x.uri === u)!
    const m = (r._meta ?? {}) as Record<string, unknown>
    const ui = (m.ui ?? {}) as Record<string, unknown>
    const csp = (ui.csp ?? {}) as Record<string, unknown>
    ok(`R-2. standard ${u.slice(12)} profile=mcp-app + csp 四空数组 + 无 ui.domain`,
      r.mimeType === 'text/html;profile=mcp-app'
      && ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'].every(k => JSON.stringify(csp[k]) === '[]')
      && !('domain' in ui) && ui.prefersBorder === true && !('openai/widgetDomain' in m))
  }
  const REQUEST_TOKENS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|src)\b/
  const SINK_TOKENS = /\b(innerHTML|outerHTML|insertAdjacentHTML|write|writeln|eval|Function)\b/
  for (const u of stdUris) {
    const rr = await c.readResource({ uri: u })
    const ct0 = (rr.contents as Array<{ uri?: string; mimeType?: string; text: string; _meta?: Record<string, unknown> }>)[0]
    const html = ct0.text
    ok(`R-3. read ${u.slice(12)}:contents.uri 一致 + 标准 MIME + 桥词元 + 自包含 + 零 WAZ`,
      ct0.uri === u && ct0.mimeType === 'text/html;profile=mcp-app'
      && html.includes('ui/initialize') && html.includes('ui/notifications/tool-result')
      && html.includes("'ui/open-link'") && html.includes("role:'user'")
      && html.includes("content:{type:'text'") && !html.includes('content:[{')   // 2026-01-26 冻结版:单 ContentBlock
      && !REQUEST_TOKENS.test(html) && !SINK_TOKENS.test(html) && !html.includes(' WAZ')
      && !!(ct0._meta as Record<string, unknown>)?.ui)
  }
  for (const u of legacyUris) {
    const rr = await c.readResource({ uri: u })
    const html = (rr.contents as Array<{ text: string }>)[0].text
    const needLink = baseOf(u) !== 'ui://widget/webaz-products'   // products 无深链面 → 不注入 link 片段
    ok(`R-4. legacy ${u.slice(12)} 单桥(无标准桥词元)+ compat 守卫在场`,
      !html.includes('ui/initialize') && html.includes('window.openai') && html.includes('sendFollowUpCompat')
      && (needLink ? html.includes('safeWebazHref') : !html.includes('safeWebazHref')))
  }
  // R-5 (BUG-04): 旧裸 URI 作为只读别名仍可 Read(历史消息里的卡片不失效);contents.uri = 请求的裸 URI。
  const BARE = ['ui://widget/webaz-products.html', 'ui://widget/webaz-products-mcp.html', 'ui://widget/webaz-quote-approval.html', 'ui://widget/webaz-quote-approval-mcp.html', 'ui://widget/webaz-order-timeline.html', 'ui://widget/webaz-order-timeline-mcp.html']
  for (const u of BARE) {
    const rr = await c.readResource({ uri: u })
    const ct0 = (rr.contents as Array<{ uri?: string; mimeType?: string; text: string }>)[0]
    const expectMime = u.includes('-mcp.') ? 'text/html;profile=mcp-app' : 'text/html+skybridge'
    ok(`R-5. bare alias ${u.slice(12)} 仍可读 + contents.uri=请求URI + MIME 正确`, ct0.uri === u && ct0.mimeType === expectMime && ct0.text.length > 100)
  }

  // ── [T2] 主题双轨(PR-0 深色修复):6 个资源全部带 token 化主题 + 三层信号 + 按钮显式字色 ──
  for (const u of [...legacyUris, ...stdUris]) {
    const rr = await c.readResource({ uri: u })
    const html = (rr.contents as Array<{ text: string }>)[0].text
    ok(`T2. ${u.slice(12)} 主题 token + prefers-color-scheme + data-theme 双向 + 按钮显式字色`,
      html.includes('color-scheme:light dark')
      && html.includes('@media (prefers-color-scheme: dark)')
      && html.includes(':root[data-theme="dark"]') && html.includes(':root[data-theme="light"]')
      && html.includes('button{color:var(--btn-ink)}')
      && html.includes("document.documentElement.setAttribute('data-theme'")
      && html.includes('color:var(--ink)') && !/body\{[^}]*color:#/.test(html))
  }

  // ── [C] compat 函数矩阵(vm,真实代码)──────────────────────────────────────────────────
  const compat = vm.runInNewContext(`${__WIDGET_COMPAT_JS}; ({safeWebazHref:safeWebazHref, sendFollowUpCompat:sendFollowUpCompat, canFollowUp:canFollowUp, onceGuard:onceGuard})`, { setTimeout, URL }) as {
    safeWebazHref: (h: unknown) => string | null
    sendFollowUpCompat: (o: unknown, t: string) => boolean
    canFollowUp: (o: unknown) => boolean
    onceGuard: (fn: () => void, ms?: number) => () => void
  }
  const BAD = ['javascript:alert(1)', 'data:text/html,x', '//webaz.xyz/x', 'https://webaz.xyz@evil.example/', 'http://webaz.xyz/', 'https://evil.example/https://webaz.xyz', 'https://webaz.xyz.evil.example/', null, undefined, 42]
  ok('C-1. safeWebazHref 拒绝矩阵全拒', BAD.every(b => compat.safeWebazHref(b) === null), JSON.stringify(BAD.map(b => compat.safeWebazHref(b))))
  ok('C-2. safeWebazHref 放行合法 deep link', compat.safeWebazHref('https://webaz.xyz/#order/ord_1') === 'https://webaz.xyz/#order/ord_1'
    && compat.safeWebazHref('https://webaz.xyz/approve?id=1') === 'https://webaz.xyz/approve?id=1')
  let nNew = 0, nOld = 0
  const both = { sendFollowUpMessage: () => { nNew++ }, sendFollowupTurn: () => { nOld++ } }
  ok('C-3. sendFollowUpCompat 双名并存 → 只调现名一次', compat.sendFollowUpCompat(both, 'x') === true && nNew === 1 && nOld === 0)
  let nOld2 = 0
  ok('C-4. 只有旧名 → 降级调用', compat.sendFollowUpCompat({ sendFollowupTurn: () => { nOld2++ } }, 'x') === true && nOld2 === 1)
  ok('C-5. 双缺失 → false(调用点禁用/改文案,不静默)', compat.sendFollowUpCompat({}, 'x') === false && compat.canFollowUp({}) === false)
  let nG = 0
  const g = compat.onceGuard(() => { nG++ }, 60_000)
  g(); g(); g()
  ok('C-6. onceGuard 忙时防重(一次窗口一次调用)', nG === 1, `n=${nG}`)

  // ── [B] 标准桥行为(vm,真实握手)────────────────────────────────────────────────────────
  type Msg = Record<string, unknown>
  function makeCtx(withOpenai: boolean) {
    const posted: Msg[] = []
    const listeners: Array<(e: { source: unknown; origin: string; data: unknown }) => void> = []
    const renders: Array<unknown[]> = []
    const parent = { postMessage: (m: Msg) => { posted.push(m) } }
    const win: Record<string, unknown> = {
      parent,
      addEventListener: (_t: string, fn: (e: never) => void) => { listeners.push(fn as never) },
      removeEventListener: (_t: string, fn: (e: never) => void) => { const i = listeners.indexOf(fn as never); if (i >= 0) listeners.splice(i, 1) },
    }
    if (withOpenai) win.openai = { toolOutput: { schema_version: 'legacy.shape' }, callTool: () => {} }
    const ctx: Record<string, unknown> = { window: win, setTimeout, Promise, URL, renderBody: (...a: unknown[]) => { renders.push(a) } }
    vm.createContext(ctx)
    // COMPAT_LINK 一并注入:标准 facade 的 openExternal 依赖 safeWebazHref(与 quote/timeline 标准资源同构)
    vm.runInContext(`${__WIDGET_COMPAT_JS}\n${__WIDGET_BRIDGE_STANDARD_JS}\n${__WIDGET_BOOT_STANDARD_JS}`, ctx)
    const dispatch = (e: { source: unknown; origin: string; data: unknown }) => { listeners.slice().forEach(fn => fn(e)) }
    return { posted, listeners, renders, parent, win, dispatch, ctx }
  }
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  // B-1 标准路径:握手 → initialized → tool-result 渲染;window.openai 从未被读
  const h1 = makeCtx(true)
  await sleep(20)
  const init = h1.posted.find(m => m.method === 'ui/initialize') as Msg
  ok('B-1a. boot 即发 ui/initialize(appInfo/protocolVersion 齐)', !!init
    && (init.params as Record<string, unknown>)?.protocolVersion === '2026-01-26', JSON.stringify(init).slice(0, 160))
  h1.dispatch({ source: h1.parent, origin: 'https://host-a.example', data: { jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'h' }, hostCapabilities: {}, hostContext: {} } } })
  await sleep(20)
  ok('B-1b. 握手成功 → 发 ui/notifications/initialized', h1.posted.some(m => m.method === 'ui/notifications/initialized'))
  h1.dispatch({ source: h1.parent, origin: 'https://host-a.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { schema_version: 'std.shape' } } } })
  await sleep(10)
  ok('B-1c. tool-result → renderBody(标准桥,legacy toolOutput 未被用)', h1.renders.length === 1
    && (h1.renders[0][1] as Record<string, unknown>)?.schema_version === 'std.shape')
  // pinned origin:异源注入被忽略
  h1.dispatch({ source: h1.parent, origin: 'https://evil.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { schema_version: 'evil' } } } })
  h1.dispatch({ source: { not: 'parent' }, origin: 'https://host-a.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { schema_version: 'evil2' } } } })
  await sleep(10)
  ok('B-1d. pinned-origin 外 + 非 parent source 消息全被忽略', h1.renders.length === 1)

  // B-4(Codex R1-3):真实 facade 线上行为 —— __facade 是 boot 脚本顶层 var → vm context 属性可达
  const fac1 = h1.ctx.__facade as { callTool: (n: string, a: unknown) => void; sendFollowUpMessage: (o: { prompt: string }) => void; openExternal: (o: { href: string }) => void }
  ok('B-4a. 握手后 facade 就位', !!fac1 && typeof fac1.callTool === 'function')
  fac1.callTool('webaz_search', { cursor: 'c1' })
  await sleep(10)
  const tc = h1.posted.find(m => m.method === 'tools/call') as Msg
  ok('B-4b. facade.callTool → 线上 tools/call {name,arguments}', !!tc && (tc.params as Record<string, unknown>)?.name === 'webaz_search')
  // 宿主对同一执行【既回 response 又发 tool-result 通知】(规范要求通知统一必发)→ 只渲染一次(通知路径)
  h1.dispatch({ source: h1.parent, origin: 'https://host-a.example', data: { jsonrpc: '2.0', id: tc.id, result: { content: [], structuredContent: { schema_version: 'r2' } } } })
  h1.dispatch({ source: h1.parent, origin: 'https://host-a.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { schema_version: 'r2' } } } })
  await sleep(10)
  ok('B-4c. response+通知双到达 → 恰一次新渲染(单渲染源=通知)', h1.renders.length === 2, `renders=${h1.renders.length}`)
  fac1.sendFollowUpMessage({ prompt: '你好' })
  await sleep(10)
  const um = h1.posted.find(m => m.method === 'ui/message') as Msg
  const ump = (um?.params ?? {}) as Record<string, unknown>
  ok('B-4d. ui/message 冻结版 wire shape(role:user + content 单 ContentBlock 非数组)',
    ump.role === 'user' && !Array.isArray(ump.content) && (ump.content as Record<string, unknown>)?.type === 'text'
    && (ump.content as Record<string, unknown>)?.text === '你好', JSON.stringify(um).slice(0, 160))
  fac1.openExternal({ href: 'javascript:alert(1)' })
  fac1.openExternal({ href: 'https://webaz.xyz/#order/o1' })
  await sleep(10)
  const links = h1.posted.filter(m => m.method === 'ui/open-link')
  ok('B-4e. facade.openExternal:非法拒发,合法 → ui/open-link {url}', links.length === 1
    && ((links[0].params as Record<string, unknown>)?.url) === 'https://webaz.xyz/#order/o1', JSON.stringify(links))

  // B-2 超时降级 window.openai(单桥:降级后标准监听已拆)
  const h2 = makeCtx(true)
  await sleep(700)
  ok('B-2a. 握手超时 → 降级 legacy(renderBody 收到 window.openai.toolOutput)', h2.renders.length === 1
    && (h2.renders[0][1] as Record<string, unknown>)?.schema_version === 'legacy.shape')
  ok('B-2b. 降级后标准监听已拆(单桥)', h2.listeners.length === 0)
  h2.dispatch({ source: h2.parent, origin: 'https://host-a.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { schema_version: 'late' } } } })
  await sleep(10)
  ok('B-2c. 迟到的标准消息不再触发渲染(无双桥双发)', h2.renders.length === 1)

  // B-3 双缺失 → 只读降级
  const h3 = makeCtx(false)
  await sleep(700)
  ok('B-3. 无桥 → renderBody({}, null) 只读降级', h3.renders.length === 1 && h3.renders[0][1] === null)
} finally { /* in-memory transport,无需清理 */ }

if (fail > 0) { console.error(`\n❌ mcp-apps-standard FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-apps-standard: 标准/legacy 双轨元数据 + 桥选择/降级/origin 锁 + URL/follow-up 安全 — 全绿\n  ✅ pass ${pass}`)
process.exit(0)
