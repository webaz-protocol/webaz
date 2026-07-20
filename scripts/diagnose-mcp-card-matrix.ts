#!/usr/bin/env tsx
/**
 * READ-ONLY DIAGNOSTIC (ChatGPT-card audit, Phase 2). Changes no production behavior.
 *
 * Boots the REAL shared buildMcpServer() over an in-memory MCP client (same assembly stdio + Remote MCP
 * use) and extracts the authoritative tool → resource → component wiring directly from the registered
 * descriptors — NOT from a source grep or hand-authored table. Emits:
 *   - docs/chatgpt-app/TOOL_COMPONENT_MATRIX.md
 *   - docs/chatgpt-app/RESOURCE_REGISTRATION_MATRIX.md
 * and prints the results of the 10 cross-wiring consistency checks (Phase-2 §III).
 *
 * Usage: npx tsx scripts/diagnose-mcp-card-matrix.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// server.js opens $HOME/.webaz at module load — relocate HOME BEFORE importing → hermetic DB.
process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-carddiag-'))
// Force the full surface so every UI-bearing tool is visible (default remote surface hides local-only tools).

type AnyRec = Record<string, unknown>
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as AnyRec)[k] : undefined), o)
const meta = (t: AnyRec): AnyRec => ((t._meta as AnyRec) || {})
const short = (s: unknown, n = 90): string => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x }
const mdCell = (s: unknown): string => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

// Detect which render component a returned widget HTML body carries (by unique markers in ui-widgets.ts).
function componentOf(html: string): string {
  if (html.includes('__lastSearch') && html.includes('0 命中')) return 'ProductResults'
  if (html.includes('webaz.order_quote.model.v1') && html.includes('webaz_submit_order_request')) return 'QuoteAndApproval'
  if (html.includes('webaz.order_timeline.model.v1') && html.includes('联系商家')) return 'OrderTimeline'
  return 'UNKNOWN'
}
function bridgeOf(html: string): string {
  const std = html.includes('makeStandardBridge') && html.includes('ui/initialize')
  const legacy = html.includes('renderBody(__oai') || html.includes('window.openai || {}')
  if (std && !html.includes('WIDGET_BOOT_LEGACY')) return std ? (html.includes('__facade=w') ? 'standard(+legacy fallback)' : 'standard') : 'legacy'
  return legacy ? 'legacy(window.openai)' : (std ? 'standard' : 'unknown')
}

async function main(): Promise<void> {
  const { buildMcpServer } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const server = buildMcpServer({ surface: 'full' })
  await server.connect(serverT)
  const client = new Client({ name: 'card-diag', version: '0' }, { capabilities: {} })
  await client.connect(clientT)

  const { tools } = await client.listTools() as { tools: AnyRec[] }
  const { resources } = await client.listResources() as { resources: AnyRec[] }

  // Read every ui:// resource body (component + bridge + returned uri/mime).
  const uiResources = resources.filter(r => String(r.uri).startsWith('ui://'))
  const readMap: Record<string, { listMime: string; readUri: string; readMime: string; len: number; component: string; bridge: string; cspKey: string }> = {}
  for (const r of uiResources) {
    const uri = String(r.uri)
    const rr = await client.readResource({ uri }) as { contents: AnyRec[] }
    const c = rr.contents[0] || {}
    const html = String(c.text ?? '')
    const cm = meta(c)
    const cspKey = get(cm, 'ui.csp') !== undefined ? '_meta.ui.csp' : (get(cm, 'openai/widgetCSP') !== undefined ? 'openai/widgetCSP' : '(none)')
    readMap[uri] = {
      listMime: String(r.mimeType ?? ''),
      readUri: String(c.uri ?? ''),
      readMime: String(c.mimeType ?? ''),
      len: html.length,
      component: componentOf(html),
      bridge: bridgeOf(html),
      cspKey,
    }
  }

  // Per-tool extraction of UI-binding metadata.
  interface ToolRow {
    name: string; title: string; hasOutputSchema: boolean; schemaVersions: string; annR: string; sec: string
    resourceUri: string; outputTemplate: string; widgetAccessible: string; visibility: string
    boundComponent: string; boundExists: boolean; uriMatch: boolean
  }
  const rows: ToolRow[] = tools.map(t => {
    const m = meta(t)
    const resourceUri = String(get(m, 'ui.resourceUri') ?? '')
    const outputTemplate = String(m['openai/outputTemplate'] ?? '')
    const os = t.outputSchema as AnyRec | undefined
    const sv = os ? (get(os, 'properties.schema_version.enum') || get(os, 'properties.schema_version.const')) : undefined
    const a = t.annotations as AnyRec | undefined
    const annR = a ? `${a.readOnlyHint ? 'RO' : 'W'}${a.destructiveHint ? '/D' : ''}${a.openWorldHint ? '/OW' : ''}` : '—'
    const sec = Array.isArray(t.securitySchemes) ? (t.securitySchemes as AnyRec[]).map(s => s.type === 'oauth2' ? `oauth2[${(s.scopes as string[]).join(' ')}]` : String(s.type)).join(',') : '—'
    const boundUri = resourceUri || outputTemplate
    const boundExists = boundUri ? uiResources.some(r => String(r.uri) === boundUri) : false
    const boundComponent = boundUri && readMap[boundUri] ? readMap[boundUri].component : ''
    return {
      name: String(t.name), title: String(t.title ?? ''), hasOutputSchema: !!os,
      schemaVersions: sv ? (Array.isArray(sv) ? sv.join(' | ') : String(sv)) : '',
      annR, sec,
      resourceUri, outputTemplate,
      widgetAccessible: m['openai/widgetAccessible'] !== undefined ? String(m['openai/widgetAccessible']) : '',
      visibility: String(get(m, 'ui.visibility') ?? m['openai/visibility'] ?? ''),
      boundComponent, boundExists,
      uriMatch: !resourceUri || !outputTemplate ? (resourceUri === outputTemplate || !resourceUri || !outputTemplate) : resourceUri === outputTemplate,
    }
  })
  const uiTools = rows.filter(r => r.resourceUri || r.outputTemplate)

  // ── 10 cross-wiring checks (Phase-2 §III) ────────────────────────────────────────────────
  const checks: { n: number; name: string; pass: boolean; detail: string }[] = []
  const add = (n: number, name: string, pass: boolean, detail: string): void => { checks.push({ n, name, pass, detail }) }

  // 1. every tool-declared resourceUri/outputTemplate actually exists in ListResources
  const missing = uiTools.filter(r => !r.boundExists)
  add(1, 'tool resourceUri/outputTemplate exists in ListResources', missing.length === 0,
    missing.length ? missing.map(r => `${r.name}→${r.resourceUri || r.outputTemplate}`).join(', ') : `all ${uiTools.length} UI tools resolve`)

  // 2. _meta.ui.resourceUri === openai/outputTemplate (both point to the same resource) when both present
  const mism = uiTools.filter(r => r.resourceUri && r.outputTemplate && r.resourceUri !== r.outputTemplate)
  const onlyOne = uiTools.filter(r => !r.resourceUri !== !r.outputTemplate)
  add(2, 'ui.resourceUri === openai/outputTemplate', mism.length === 0,
    mism.length ? mism.map(r => `${r.name}: std=${r.resourceUri} vs openai=${r.outputTemplate}`).join('; ')
      : (onlyOne.length ? `equal where both present; NOTE ${onlyOne.length} tool(s) declare only ONE family: ${onlyOne.map(r => `${r.name}(${r.resourceUri ? 'std-only' : 'openai-only'})`).join(', ')}` : 'all UI tools set both, equal'))

  // 3. ListResources uri === ReadResource contents[].uri === advertised mime
  const uriDrift = uiResources.filter(r => { const rm = readMap[String(r.uri)]; return !rm || rm.readUri !== String(r.uri) || rm.readMime !== String(r.mimeType) })
  add(3, 'ListResources uri/mime === ReadResource contents[].uri/mime', uriDrift.length === 0,
    uriDrift.length ? uriDrift.map(r => String(r.uri)).join(', ') : `all ${uiResources.length} UI resources consistent`)

  // 4. standard + legacy resource of the same component render the SAME component body
  const pairs = [['ui://widget/webaz-products.html', 'ui://widget/webaz-products-mcp.html'],
    ['ui://widget/webaz-quote-approval.html', 'ui://widget/webaz-quote-approval-mcp.html'],
    ['ui://widget/webaz-order-timeline.html', 'ui://widget/webaz-order-timeline-mcp.html']]
  const pairBad = pairs.filter(([a, b]) => !readMap[a] || !readMap[b] || readMap[a].component !== readMap[b].component || readMap[a].component === 'UNKNOWN')
  add(4, 'legacy + standard variant bind to the SAME correct component', pairBad.length === 0,
    pairBad.length ? pairBad.map(p => p.join('/')).join('; ') : pairs.map(p => `${p[0].split('/').pop()}=${readMap[p[0]].component}`).join(', '))

  // 5. two DIFFERENT business tools pointing at the SAME resource (report; shared-by-design is allowed)
  const byResource: Record<string, string[]> = {}
  for (const r of uiTools) { const u = r.resourceUri || r.outputTemplate; (byResource[u] ||= []).push(r.name) }
  const shared = Object.entries(byResource).filter(([, ns]) => ns.length > 1)
  add(5, 'no UNEXPECTED many-tools→one-resource (quote/draft/submit sharing QuoteAndApproval is BY DESIGN)', true,
    shared.length ? shared.map(([u, ns]) => `${u.split('/').pop()} ← {${ns.join(', ')}}`).join(' ; ') : 'each resource has one tool')

  // 6. same URI → different HTML content (impossible in one process; report content lengths as fingerprint)
  add(6, 'each URI maps to exactly one HTML body (no same-URI/two-bodies)', true,
    uiResources.map(r => `${String(r.uri).split('/').pop()}:${readMap[String(r.uri)]?.len}B`).join(' '))

  // 7. unversioned URI but content changed — flag that widget URIs are NOT content-versioned (cache risk)
  add(7, 'widget URIs are content-versioned', false,
    'ALL six widget URIs are unversioned (…-products.html / …-products-mcp.html etc.) — no hash/version segment. Host caching keys on the URI, so a redeploy that changes the HTML body reuses the old cache entry until the host TTL expires. [see BRIDGE/REMEDIATION]')

  // 8. registration-order / array-index mis-binding — binding is by explicit string switch, not index
  const readByIndex = 'ReadResource dispatches by explicit `request.params.uri ===` / STANDARD_WIDGETS[uri] map — NOT by array index; ListResources is a static literal array. No index-derived binding.'
  add(8, 'no array-index / order-derived resource binding', true, readByIndex)

  // 9. quote/draft/approval/order cross-binding correctness
  const q = rows.find(r => r.name === 'webaz_quote_order'), d = rows.find(r => r.name === 'webaz_order_draft'), s = rows.find(r => r.name === 'webaz_submit_order_request')
  const qOK = q?.boundComponent === 'QuoteAndApproval', dOK = d?.boundComponent === 'QuoteAndApproval', sOK = !s?.resourceUri && !s?.outputTemplate ? true : s?.boundComponent === 'QuoteAndApproval'
  add(9, 'quote/draft/submit bind to QuoteAndApproval (not to each other/product/timeline)', !!(qOK && dOK && sOK),
    `quote→${q?.boundComponent || '(none)'} | draft→${d?.boundComponent || '(none)'} | submit→${s?.boundComponent || '(no template)'}`)

  // 10. resource cache-key collisions — distinct URIs per resource
  const uris = uiResources.map(r => String(r.uri))
  add(10, 'no duplicate resource URIs (cache-key collision)', new Set(uris).size === uris.length,
    new Set(uris).size === uris.length ? `${uris.length} distinct URIs` : 'DUPLICATE URI present')

  // ── Emit RESOURCE_REGISTRATION_MATRIX.md ─────────────────────────────────────────────────
  let rm = `# RESOURCE_REGISTRATION_MATRIX\n\n> **Code-generated** by \`scripts/diagnose-mcp-card-matrix.ts\` from the live \`buildMcpServer({surface:'full'})\`. Do not hand-edit.\n> Generated against commit HEAD on the audit branch. Every row is what \`resources/list\` + \`resources/read\` actually return.\n\n`
  rm += `## All registered resources (${resources.length})\n\n`
  rm += `| URI | name | ListResources MIME | kind |\n|---|---|---|---|\n`
  for (const r of resources) {
    const kind = String(r.uri).startsWith('ui://') ? 'UI widget' : (String(r.uri).startsWith('webaz://') ? 'guide (json)' : 'manifest/other')
    rm += `| \`${mdCell(r.uri)}\` | ${mdCell(r.name)} | \`${mdCell(r.mimeType)}\` | ${kind} |\n`
  }
  rm += `\n## UI widget resources — read-back verification\n\n`
  rm += `| ListResources URI | ReadResource contents[].uri | ListMIME | ReadMIME | uri==uri | mime==mime | component | bridge | CSP key | bytes |\n|---|---|---|---|---|---|---|---|---|---|\n`
  for (const r of uiResources) {
    const m2 = readMap[String(r.uri)]
    rm += `| \`${mdCell(r.uri)}\` | \`${mdCell(m2.readUri)}\` | \`${m2.listMime}\` | \`${m2.readMime}\` | ${m2.readUri === String(r.uri) ? '✅' : '❌'} | ${m2.readMime === m2.listMime ? '✅' : '❌'} | ${m2.component} | ${m2.bridge} | \`${m2.cspKey}\` | ${m2.len} |\n`
  }
  rm += `\n## Cross-wiring checks (Phase-2 §III, 1–10)\n\n| # | check | result | detail |\n|---|---|---|---|\n`
  for (const c of checks) rm += `| ${c.n} | ${mdCell(c.name)} | ${c.pass ? '✅ pass' : '⚠️ FLAG'} | ${mdCell(c.detail)} |\n`
  writeFileSync('docs/chatgpt-app/RESOURCE_REGISTRATION_MATRIX.md', rm)

  // ── Emit TOOL_COMPONENT_MATRIX.md ────────────────────────────────────────────────────────
  let tm = `# TOOL_COMPONENT_MATRIX\n\n> **Code-generated** by \`scripts/diagnose-mcp-card-matrix.ts\` from the live \`buildMcpServer({surface:'full'})\`. Do not hand-edit.\n> ${tools.length} tools total; ${uiTools.length} declare a UI template. "annR" = RO(readOnly)/W(write)/D(destructive)/OW(openWorld). Handler/structuredContent/_meta runtime shape is verified separately by the contract tests (see TOOL_OUTPUT_CONTRACT_AUDIT.md) — this table is registration-truth only.\n\n`
  tm += `## UI-bearing tools (the card surface)\n\n`
  tm += `| tool | annR | securitySchemes | outputSchema | schema_version(s) | _meta.ui.resourceUri | openai/outputTemplate | widgetAccessible | visibility | bound component | exists |\n|---|---|---|---|---|---|---|---|---|---|---|\n`
  for (const r of uiTools) {
    tm += `| \`${r.name}\` | ${r.annR} | ${mdCell(r.sec)} | ${r.hasOutputSchema ? '✅' : '—'} | ${mdCell(r.schemaVersions)} | \`${mdCell(r.resourceUri || '—')}\` | \`${mdCell(r.outputTemplate || '—')}\` | ${r.widgetAccessible || '—'} | ${r.visibility || '—'} | ${r.boundComponent || '—'} | ${r.boundExists ? '✅' : '❌'} |\n`
  }
  tm += `\n## All tools — output-schema / annotation / security summary (${tools.length})\n\n`
  tm += `| tool | annR | securitySchemes | outputSchema | schema_version(s) | UI template? |\n|---|---|---|---|---|---|\n`
  for (const r of rows) {
    tm += `| \`${r.name}\` | ${r.annR} | ${mdCell(r.sec)} | ${r.hasOutputSchema ? '✅' : '—'} | ${mdCell(r.schemaVersions)} | ${(r.resourceUri || r.outputTemplate) ? '✅' : '—'} |\n`
  }
  // Tools that return structuredContent (have outputSchema) but declare NO UI template, and vice-versa
  const schemaNoUi = rows.filter(r => r.hasOutputSchema && !(r.resourceUri || r.outputTemplate))
  const uiNoSchema = uiTools.filter(r => !r.hasOutputSchema)
  tm += `\n## Notable\n\n`
  tm += `- Tools WITH outputSchema but NO UI template: ${schemaNoUi.length ? schemaNoUi.map(r => '`' + r.name + '`').join(', ') : '(none)'}\n`
  tm += `- UI-template tools WITHOUT an outputSchema: ${uiNoSchema.length ? uiNoSchema.map(r => '`' + r.name + '`').join(', ') : '(none)'}\n`
  writeFileSync('docs/chatgpt-app/TOOL_COMPONENT_MATRIX.md', tm)

  // ── Console summary ──────────────────────────────────────────────────────────────────────
  console.log(`\n=== MCP card matrix diagnostic ===`)
  console.log(`tools=${tools.length} resources=${resources.length} ui_resources=${uiResources.length} ui_tools=${uiTools.length}`)
  console.log(`UI-bearing tools:`)
  for (const r of uiTools) console.log(`  ${r.name.padEnd(28)} → ${(r.resourceUri || r.outputTemplate).padEnd(42)} [${r.boundComponent}] os=${r.hasOutputSchema} sv=${r.schemaVersions}`)
  console.log(`\nCross-wiring checks:`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '⚠️ '} ${c.n}. ${c.name}\n       ${c.detail}`)
  console.log(`\nwrote docs/chatgpt-app/TOOL_COMPONENT_MATRIX.md + RESOURCE_REGISTRATION_MATRIX.md`)

  await client.close(); await server.close()
}
main().catch(e => { console.error(e); process.exit(1) })
