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
  PRODUCT_RESULTS_BODY_JS,
  QUOTE_APPROVAL_BODY_JS,
  ORDER_TIMELINE_BODY_JS,
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

// ── Syntax guard: every widget body must vm-compile with the shared blob (catches stray-paren-in-template bugs) ──
for (const [name, body] of [['ProductResults', PRODUCT_RESULTS_BODY_JS], ['QuoteApproval', QUOTE_APPROVAL_BODY_JS], ['OrderTimeline', ORDER_TIMELINE_BODY_JS]] as const) {
  let compiled = false
  try {
    const c: Record<string, unknown> = { document: { getElementById: () => null, createElement: () => ({ style: {}, classList: { toggle() {} }, appendChild: (x: unknown) => x, setAttribute() {}, addEventListener() {} }) }, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, Date, Math, console, String, Object, Array, JSON, Number, isFinite }
    vm.createContext(c)
    vm.runInContext(`${__WIDGET_COMPAT_JS}\n${body}\nthis.__r=renderBody`, c)
    compiled = typeof (c as { __r?: unknown }).__r === 'function'
  } catch { compiled = false }
  ok(`syntax: ${name} body compiles with shared blob (renderBody defined)`, compiled)
}

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
// B-1(Round1b): JSON-string region map (as quote projection sends it) must parse, not render raw JSON
ok('B-1 JSON-string region map → 约12天 (not raw JSON)', etaDisplay('{"SG":12,"all":12}') === '约12天')
ok('B-1 JSON-string region map honors dest region', etaDisplay('{"SG":9,"all":12}', 'SG') === '约9天')
ok('B-1 JSON-string range object → dash', etaDisplay('{"estimated_min_days":3,"estimated_max_days":5}') === '3–5天')
ok('B-1 invalid JSON string → safe return original (no throw)', etaDisplay('{oops not json') === '{oops not json')
ok('B-1 JSON-string never emits raw brace/[object Object]', !/[{}]|\[object Object\]/.test(etaDisplay('{"SG":12,"all":12}')))

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
ok('F4 QuoteApproval draft consumes+renders', /callWebazTool\(oai,'webaz_order_draft'[\s\S]{0,320}renderBody\(oai,res\.structuredContent\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F4 QuoteApproval submit consumes+renders', /callWebazTool\(oai,'webaz_submit_order_request'[\s\S]{0,340}renderBody\(oai,res\.structuredContent\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F4 submit keeps withTrace (money args unchanged)', /callWebazTool\(oai,'webaz_submit_order_request',withTrace\(\{draft_id:out\.draft_id\}\)\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F4 standard bridge dedupes notification during inline consume', /__inlineConsuming>0\) return/.test(__WIDGET_BOOT_STANDARD_JS))
ok('F4 normal path does NOT sendFollowUp for quote (only when no callTool)', !/正在获取报价[\s\S]{0,40}sendFollowUpCompat/.test(PRODUCT_RESULTS_WIDGET_HTML))

// ── F3 wiring + F5 label in built HTML ──
ok('F3 product card uses etaDisplay fallback behind display_eta', /预计送达 '\+\(p\.display_eta\|\|etaDisplay\(p\.estimated_days/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('F3 quote card uses etaDisplay fallback behind display_eta', /'预计送达',out\.display_eta\|\|etaDisplay\(s\.estimated_days/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('F5 shown-count label present', /精确匹配 · 本卡展示 /.test(PRODUCT_RESULTS_WIDGET_HTML))

// ── B-4 copy fallback: clipboard → execCommand → auto-select, wired into both widgets ──
ok('B-4 webazCopy present in ProductResults + QuoteApproval', /webazCopy\(/.test(PRODUCT_RESULTS_WIDGET_HTML) && /webazCopy\(/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('B-4 execCommand copy fallback present', /execCommand\('copy'\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('B-4 auto-select fallback present (getSelection + createRange)', /getSelection\(\)/.test(PRODUCT_RESULTS_WIDGET_HTML) && /createRange\(\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('B-4 old silent "复制失败,请手选" removed', !/复制失败,请手选/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('B-4 copy path introduces NO business tool call (no callTool inside webazCopy)', !/function webazCopy\([\s\S]{0,600}callTool/.test(PRODUCT_RESULTS_WIDGET_HTML))

// ── A2:display_* 首选 + 详情就地消费 + 一键续链 + 徽标去重 ──
ok('A2 grid ETA prefers server display_eta', /p\.display_eta\|\|etaDisplay\(p\.estimated_days/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2 quote panel prefers display_eta + display_expires_at', /qs\.display_eta\|\|etaDisplay/.test(PRODUCT_RESULTS_WIDGET_HTML) && /qs\.display_expires_at\|\|qs\.expires_at/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2 R2-1 detail consumes via callWebazTool (no fire-and-forget)', /callWebazTool\(oai,'webaz_search',\{result_handle/.test(PRODUCT_RESULTS_WIDGET_HTML) && !/try\{ oai\.callTool\('webaz_search',\{result_handle/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2 R2-1 detail renders detail model in place', /webaz\.product_detail\.model\.v1'\)\{ state\.hint=null; renderBody\(oai,sc\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 in-card chain: draft consumes quote_token', /callWebazTool\(oai,'webaz_order_draft',\{action:'create',quote_token:qs\.quote_token\}\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 in-card chain: submit threads draft_id from draft result', /callWebazTool\(oai,'webaz_submit_order_request',\{draft_id:String\(ds\.draft_id\)\}\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 chain single-flight (chainBusy guard)', /if\(state\.chainBusy\) return/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 fail-stop keeps copyable phrase on draft/submit failure', /提交订单审批\(draft_id='\+String\(ds\.draft_id\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 approval panel renders server data url + copy (no source URL literal)', /'复制链接'/.test(PRODUCT_RESULTS_WIDGET_HTML) && /state\.approval\.url/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 duplicate submit surfaced honestly via FLATTENED projection keys (audit F1)', /ss\.duplicate\|\|ss\.duplicate_warning/.test(PRODUCT_RESULTS_WIDGET_HTML) && /已有同参数审批待批准/.test(PRODUCT_RESULTS_WIDGET_HTML) && !/ss\.idempotency/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 renderBody rejects non-product models (audit F2: late notifications cannot fake 0-hit)', /indexOf\('webaz\.product_'\)!==0\)\{ return \}/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 chain failures surface precise error_code (audit F3)', /ds\.error_code\|\|dr\.error/.test(PRODUCT_RESULTS_WIDGET_HTML) && /ss\.error_code\|\|sr\.error/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 copy fallback ALWAYS visible', /var qcp=el\('button','mini','复制继续'\)/.test(PRODUCT_RESULTS_WIDGET_HTML) && !/else \{\s*var qcp/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2 no sendFollowUp in quote-panel chain (host drops it — R3-1)', !/qgo[\s\S]{0,200}sendFollowUpCompat/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2.1 detail card actionable (quote consume in detail branch)', /callWebazTool\(oai,'webaz_quote_order',\{product_id:p\.id,quantity:1\}\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2.1 detail specs collapse beyond 6 rows', /展开全部规格\(/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2.1 multi-product detail defaults collapsed (explicit 展开详情)', /__multiDetail\?'none':'block'/.test(PRODUCT_RESULTS_WIDGET_HTML) && /'展开详情'/.test(PRODUCT_RESULTS_WIDGET_HTML))
// A2.2(R3-2):无卡工具回执消费三级兜底 —— content[].text JSON 解析 + 错误体明确展示(绝不吞成「未知」)
ok('A2.2 status consume falls back to content[0].text JSON', /r\.content\[0\]&&r\.content\[0\]\.text/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('A2.2 error body surfaced, never swallowed as 未知', /状态:查询失败\('\+String\(d\.error_code\|\|d\.error\)/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('A2.2 unknown status keeps webaz.xyz escape hatch', /未知 —— 可在 webaz\.xyz 审批页查看/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('A3-2 chain button disables + shows progress on click', /qgo\.disabled=true; qgo\.textContent='创建草稿中…'/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2 R2-3 stock badge deduped vs decision_flags', /lb===stockChip\) return/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A2 QuoteApproval prefers display_expires_at', /display_expires_at\|\|out\.expires_at/.test(QUOTE_APPROVAL_WIDGET_HTML))
ok('A3-2b audit P3-2: approval_url never double-prefixed (prefix-aware both sites)', (QUOTE_APPROVAL_WIDGET_HTML.match(/indexOf\('https'\)===0/g)||[]).length >= 2)

// A3-2(Holden):买家只看 USDC + 本地法币 —— 卡片绝不显示人民币
ok('A3-2 no CNY in ProductResults card', !/CNY|¥/.test(PRODUCT_RESULTS_WIDGET_HTML))

// A3-6:详情永远可回列表 + 面板持久化(宿主 widgetState)
ok('A3-6 detail always offers a way back (title re-search when no cached list)', /返回商品列表/.test(PRODUCT_RESULTS_WIDGET_HTML) && /callWebazTool\(oai,'webaz_search',\{query:String\(\(out\.products\[0\]\|\|\{\}\)\.title/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-6 quote/approval panels persist via host widgetState (probe + restore)', /oai\.widgetState/.test(PRODUCT_RESULTS_WIDGET_HTML) && /setWidgetState/.test(PRODUCT_RESULTS_WIDGET_HTML))

// A3-7(R4-1 兜底):小目录自动取齐 —— 一次性、就地合并、按 id 去重
ok('A3-9 auto-fill works WITHOUT cursor (query+sort full-page refetch, price sorts covered)', /\{query:String\(out\.query\),sort:String\(out\.sort\|\|'trending'\),limit:8\}/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-9 filtered results NEVER full-page refetched (audit F2 constraint preservation)', /out\.filtered\)\) return/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-9 🌟 recommendation carried across page replace (audit F2)', /sc\.recommendation=out\.recommendation/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-9 cross-render attempt cap (audit F1)', /__autoFillAttempts>=2\) return/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-7 small-catalog auto-fill (once, merge by id, ≤8 only)', /__autoFilled=true/.test(PRODUCT_RESULTS_WIDGET_HTML) && /tc&&tc<=8/.test(PRODUCT_RESULTS_WIDGET_HTML) && /if\(!seen\[pp\.id\]\) out\.products\.push\(pp\)/.test(PRODUCT_RESULTS_WIDGET_HTML))

// A3-8:下一页必须消费(零 fire-and-forget 终局锁 —— 全卡不允许裸 oai.callTool( 出现)
ok('A3-8 下一页 consumes via callWebazTool + page replace', /callWebazTool\(oai,'webaz_search',\{cursor:String\(out\.next_cursor\)/.test(PRODUCT_RESULTS_WIDGET_HTML) && /'加载中…'/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-8 ZERO bare fire-and-forget callTool left in ProductResults (terminal lock)', !/try\{ oai\.callTool\(/.test(PRODUCT_RESULTS_WIDGET_HTML) && !/[^.]oai\.callTool\('webaz_search',\{cursor/.test(PRODUCT_RESULTS_WIDGET_HTML) && /载入条款中…/.test(PRODUCT_RESULTS_WIDGET_HTML))

// A3-10:0 命中相关商品(标题含词)—— 完整交互页渲染 + 诚实横幅;strict 0 事实保留
ok('A3-10 related recovery renders full interactive page with honest banner', /rec\.related_products&&rec\.related_products\.length/.test(PRODUCT_RESULTS_WIDGET_HTML) && /非精确命中/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-10 F5 label swapped by related banner in related mode', /out\.__related_note\?String\(out\.__related_note\)/.test(PRODUCT_RESULTS_WIDGET_HTML))

// ── Self-containment lock: ProductResults must stay URL-literal-free + zero request-capability tokens (incl. in comments) ──
// A3-2b:ProductResults 获得与审批卡同级的 LINK compat(打开审批页)。零 URL 字面量锁【保持】;
//   请求词元锁收窄为非链接词元(href 仅允许出现在 compat-link 的 safeWebazHref/openExternal 面)。
const REQ_TOK = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import|src|location)\b/
ok('ProductResults has NO url literal (zero-URL self-containment lock)', !/["'`](https?:)?\/\//.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('ProductResults has NO request-capability token beyond vetted LINK compat', !REQ_TOK.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2b link discipline: safeWebazHref gate present + approval open uses it', /safeWebazHref/.test(PRODUCT_RESULTS_WIDGET_HTML) && /openWebaz\(oai,state\.approval\.url\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-7 slim panel: raw ids/urls behind 详情 toggle, copy failure auto-expands', /'详情'/.test(PRODUCT_RESULTS_WIDGET_HTML) && /__openDet\(\)/.test(PRODUCT_RESULTS_WIDGET_HTML) && /审批号:/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-7 copy button present (复制链接)', /'复制链接'/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-3 approval panel refresh consumes approval_requests get', /callWebazTool\(oai,'webaz_approval_requests',\{action:'get',request_id:state\.approval\.request_id\}\)/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-3 refresh prefers server display_status', /d\.display_status\|\|/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-4 panel refresh parses content[0].text JSON (card-less receipt tier-2, R3-2 class)', /d\.content\[0\]&&d\.content\[0\]\.text/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-3 executed → 打开订单页 via server order_url data (url hidden until copy-fallback needs it)', /openWebaz\(oai,String\(d\.order_url\)\)/.test(PRODUCT_RESULTS_WIDGET_HTML) && /oue\.style\.display='block'; doCopy/.test(PRODUCT_RESULTS_WIDGET_HTML))
ok('A3-2b 取消 is LOCAL-only (clears quote panel, no tool call, blocked mid-chain)', /var qx=el\('button','mini','取消'\); qx\.addEventListener\('click',function\(\)\{ if\(state\.chainBusy\) return; state\.quote=null/.test(PRODUCT_RESULTS_WIDGET_HTML))

await run().then(() => {
  if (fail > 0) { console.error(`\n❌ phase3b-ui-hotfix FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ phase3b-ui-hotfix: F3 ETA formatter (region map/range/null/malformed never [object Object]) + F4 callWebazTool consume (ok/error/throw/no-host) + button wiring (consume+render, no fire-and-forget, withTrace intact, notification dedup) + F5 shown-count label\n  ✅ pass ${pass}`)
})
