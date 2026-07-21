#!/usr/bin/env tsx
/**
 * Phase 3B Round 1 UI hotfix — unit tests for the shared widget helpers (F3 ETA formatter + F4 callWebazTool).
 * Evaluates the real stringified widget JS (__WIDGET_COMPAT_JS) in a sandbox and drives the pure logic —
 * no DOM needed. Also asserts the built widget HTML wires the new consume path (no fire-and-forget on the
 * primary buttons) and F5's shown-count label. Usage: npm run test:phase3b-ui-hotfix
 */
import vm from 'node:vm'
import {
  __WIDGET_COMPAT_JS,
  __WIDGET_BOOT_STANDARD_JS,
  PRODUCT_RESULTS_WIDGET_HTML,
  QUOTE_APPROVAL_WIDGET_HTML,
} from '../src/layer1-agent/L1-1-mcp-server/ui-widgets.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// Evaluate the shared compat blob (etaDisplay, callWebazTool, webazConsume, __inlineConsuming) in a sandbox.
const sandbox: Record<string, unknown> = { setTimeout, clearTimeout, Promise, URL, console }
vm.createContext(sandbox)
vm.runInContext(__WIDGET_COMPAT_JS + '\nthis.etaDisplay=etaDisplay; this.callWebazTool=callWebazTool; this.webazConsume=webazConsume;', sandbox)
const etaDisplay = sandbox.etaDisplay as (v: unknown, r?: unknown) => string
const callWebazTool = sandbox.callWebazTool as (oai: unknown, n: string, a: unknown) => Promise<Record<string, unknown>>

// ── F3: ETA formatter — never raw JSON ──
ok('F3 region map picks dest region (SG→12)', etaDisplay({ SG: 12, all: 12 }, 'SG') === '约12天')
ok('F3 region map falls back to all when no region', etaDisplay({ SG: 12, all: 9 }) === '约9天')
ok('F3 plain number', etaDisplay(5) === '约5天')
ok('F3 range object → dash', etaDisplay({ estimated_min_days: 3, estimated_max_days: 5 }) === '3–5天')
ok('F3 same-min-max range → 约N天', etaDisplay({ estimated_min_days: 4, estimated_max_days: 4 }) === '约4天')
ok('F3 promised_eta legacy_missing', etaDisplay({ legacy_missing: true }) === '下单时未记录预计配送时间')
ok('F3 null → unavailable', etaDisplay(null) === '暂未提供预计配送时间')
ok('F3 malformed empty object → unavailable', etaDisplay({}) === '暂未提供预计配送时间')
ok('F3 numeric string', etaDisplay('7') === '约7天')
ok('F3 range string "3-5"', etaDisplay('3-5') === '3–5天')
ok('F3 NEVER emits [object Object]', !/\[object Object\]/.test([etaDisplay({ SG: 12, all: 12 }), etaDisplay({})].join('|')))

// ── F4: callWebazTool — unified consume, no host re-render dependency ──
const run = async (): Promise<void> => {
  const good = { callTool: (): Promise<unknown> => Promise.resolve({ structuredContent: { schema_version: 'webaz.order_quote.model.v2', quote_token: 'qt_1' } }) }
  const r1 = await callWebazTool(good, 'webaz_quote_order', { product_id: 'p', quantity: 1 })
  ok('F4 consumes structuredContent (ok:true)', r1.ok === true && !!(r1.structuredContent as Record<string, unknown>)?.quote_token)

  const errTool = { callTool: (): Promise<unknown> => Promise.resolve({ structuredContent: { error: 'BAD' } }) }
  const r2 = await callWebazTool(errTool, 'x', {})
  ok('F4 error payload → ok:false + error surfaced', r2.ok === false && r2.error === 'BAD')

  const throwTool = { callTool: (): never => { throw new Error('boom') } }
  const r3 = await callWebazTool(throwTool, 'x', {})
  ok('F4 thrown callTool → ok:false (not unhandled)', r3.ok === false)

  const r4 = await callWebazTool({}, 'x', {})
  ok('F4 no callTool → HOST_COMPONENT_TOOL_CALL_UNAVAILABLE', r4.ok === false && r4.error === 'HOST_COMPONENT_TOOL_CALL_UNAVAILABLE')

  // structuredContent unwrap: bare result (no .structuredContent) passes through
  ok('F4 webazConsume unwraps .structuredContent', (sandbox.webazConsume as (r: unknown) => unknown)({ structuredContent: { a: 1 } }) as unknown && JSON.stringify((sandbox.webazConsume as (r: unknown) => unknown)({ structuredContent: { a: 1 } })) === '{"a":1}')
}

// ── F4 wiring: the built widget HTML must consume results (callWebazTool) and NOT fire-and-forget the primary buttons ──
ok('F4 ProductResults uses callWebazTool', /callWebazTool\(oai,'webaz_quote_order'/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('F4 ProductResults no fire-and-forget quote (old pattern gone)', !/oai\.callTool\('webaz_quote_order',\{product_id:pid,quantity:1\}\); fired=true/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('F4 QuoteApproval draft consumes+renders', /callWebazTool\(oai,'webaz_order_draft'[\s\S]{0,160}renderBody\(oai,res\.structuredContent\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F4 QuoteApproval submit consumes+renders', /callWebazTool\(oai,'webaz_submit_order_request'[\s\S]{0,180}renderBody\(oai,res\.structuredContent\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F4 submit keeps withTrace (money args unchanged)', /callWebazTool\(oai,'webaz_submit_order_request',withTrace\(\{draft_id:out\.draft_id\}\)\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F4 standard bridge dedupes notification during inline consume', /__inlineConsuming>0\) return/.test(__WIDGET_BOOT_STANDARD_JS))
ok('F4 normal path does NOT sendFollowUp for quote (only when no callTool)', !/正在获取报价[\s\S]{0,40}sendFollowUpCompat/.test(PRODUCT_RESULTS_WIDGET_HTML))

// ── F3 wiring + F5 label in built HTML ──
ok('F3 product card uses etaDisplay', /预计送达 '\+etaDisplay\(p\.estimated_days/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('F3 quote card uses etaDisplay', /'预计送达',etaDisplay\(s\.estimated_days/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F5 shown-count label present', /精确匹配 · 本卡展示 /.test(PRODUCT_RESULTS_WIDGET_HTML))

await run().then(() => {
  if (fail > 0) { console.error(`\n❌ phase3b-ui-hotfix FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ phase3b-ui-hotfix: F3 ETA formatter (region map/range/null/malformed never [object Object]) + F4 callWebazTool consume (ok/error/throw/no-host) + button wiring (consume+render, no fire-and-forget, withTrace intact, notification dedup) + F5 shown-count label\n  ✅ pass ${pass}`)
})
