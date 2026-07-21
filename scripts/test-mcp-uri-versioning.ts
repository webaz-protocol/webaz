#!/usr/bin/env tsx
/**
 * BUG-04 — widget resource URIs are content-versioned; old bare URIs remain read aliases.
 * Locks: ListResources URI hash === sha256(actual HTML) (so an HTML change that didn't rebuild the URI
 * would FAIL); tool _meta points at existing URIs; ReadResource(versioned)/ReadResource(bare-alias) resolve;
 * a bogus/unknown UI URI is rejected.
 * Usage: npx tsx scripts/test-mcp-uri-versioning.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-uriver-'))

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const ver = (html: string): string => createHash('sha256').update(html).digest('hex').slice(0, 10)

async function main(): Promise<void> {
  const { buildMcpServer } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
  const W = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const server = buildMcpServer({ surface: 'full' })
  await server.connect(st)
  const c = new Client({ name: 'uriver', version: '0' }, { capabilities: {} })
  await c.connect(ct)

  const res = (await c.listResources()).resources as Array<{ uri: string; mimeType?: string }>
  const uiUris = res.filter(r => r.uri.startsWith('ui://widget/')).map(r => r.uri)

  // 1. each advertised versioned URI's hash === sha256(the ACTUAL widget HTML). If the HTML changed but the
  //    URI didn't (e.g. a hardcoded literal), this fails — the core BUG-04 guard.
  const expect: Array<[string, string, string]> = [
    ['webaz-products', W.PRODUCT_RESULTS_WIDGET_HTML, 'legacy'], ['webaz-products-mcp', W.PRODUCT_RESULTS_WIDGET_MCP_HTML, 'std'],
    ['webaz-quote-approval', W.QUOTE_APPROVAL_WIDGET_HTML, 'legacy'], ['webaz-quote-approval-mcp', W.QUOTE_APPROVAL_WIDGET_MCP_HTML, 'std'],
    ['webaz-order-timeline', W.ORDER_TIMELINE_WIDGET_HTML, 'legacy'], ['webaz-order-timeline-mcp', W.ORDER_TIMELINE_WIDGET_MCP_HTML, 'std'],
  ]
  for (const [base, html, kind] of expect) {
    const want = `ui://widget/${base}.${ver(html)}.html`
    ok(`V1. ${base} advertised URI hash === sha256(actual HTML) [${kind}]`, uiUris.includes(want))
  }

  // 2. content change → version change (the mechanism): mutating the HTML yields a different hash.
  ok('V2. content change → version change (hash differs when HTML changes)', ver(W.PRODUCT_RESULTS_WIDGET_HTML) !== ver(W.PRODUCT_RESULTS_WIDGET_HTML + ' '))

  // 3. B-2(Round1b 稳定 outputTemplate):ui.resourceUri(标准桥,版本化)∈ ListResources(无悬挂引用);
  //    openai/outputTemplate(ChatGPT legacy 桥)是【稳定裸别名】(无内容哈希段)且 ReadResource 可解析 —— 改 widget 内容
  //    部署后已连接会话缓存的裸别名引用仍解析到当前 widget,不再 Failed to fetch template 需重连。
  const tools = (await c.listTools()).tools as Array<{ _meta?: Record<string, unknown> }>
  const uiSet = new Set(uiUris)
  let dangling = 0, otBad = 0
  for (const t of tools) {
    const m = t._meta as Record<string, unknown> | undefined; if (!m) continue
    const ru = (m.ui as Record<string, unknown> | undefined)?.resourceUri as string | undefined
    const ot = m['openai/outputTemplate'] as string | undefined
    if (ru && !uiSet.has(ru)) dangling++
    if (ot) {
      const isBare = /^ui:\/\/widget\/[a-z-]+\.html$/.test(ot)   // 裸别名:无 .<10hex>. 内容哈希段
      let resolves = false
      try { const rr = await c.readResource({ uri: ot }); const cnt = (rr.contents as Array<{ text?: string }>)[0]; resolves = !!(cnt && cnt.text && cnt.text.length > 100) } catch { resolves = false }
      if (!isBare || !resolves) otBad++
    }
  }
  ok('V3. no tool ui.resourceUri absent from ListResources (dangling reference)', dangling === 0)
  ok('V3b. every tool openai/outputTemplate is a STABLE bare alias that ReadResource-resolves (B-2: deploy-survivable)', otBad === 0)

  // 4. ReadResource resolves every versioned URI with the right MIME.
  let readBad = 0
  for (const u of uiUris) {
    const rr = await c.readResource({ uri: u })
    const cnt = (rr.contents as Array<{ uri?: string; mimeType?: string; text?: string }>)[0]
    const wantMime = u.includes('-mcp.') ? 'text/html;profile=mcp-app' : 'text/html+skybridge'
    if (cnt.uri !== u || cnt.mimeType !== wantMime || !(cnt.text && cnt.text.length > 100)) readBad++
  }
  ok('V4. every versioned URI ReadResource-resolves with contents.uri==uri + correct MIME', readBad === 0)

  // 5. bare aliases still resolve (historical messages) with contents.uri = the requested bare URI.
  const bare = ['ui://widget/webaz-products.html', 'ui://widget/webaz-quote-approval-mcp.html', 'ui://widget/webaz-order-timeline.html']
  let aliasBad = 0
  for (const u of bare) {
    const rr = await c.readResource({ uri: u })
    const cnt = (rr.contents as Array<{ uri?: string; text?: string }>)[0]
    if (cnt.uri !== u || !(cnt.text && cnt.text.length > 100)) aliasBad++
  }
  ok('V5. bare-URI aliases still ReadResource-resolve (historical cards do not break)', aliasBad === 0)

  // 6. an unknown/bogus UI URI is rejected (tool referencing a non-existent URI would surface here).
  let rejected = false
  try { await c.readResource({ uri: 'ui://widget/webaz-products.deadbeef00.html' }) } catch { rejected = true }
  ok('V6. unknown versioned UI URI is rejected (not silently served)', rejected)

  await c.close(); await server.close()
  if (fail > 0) { console.error(`\n❌ uri versioning FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ uri versioning: content-hash URIs === sha256(HTML), tools resolve, bare aliases read, bogus rejected\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
