#!/usr/bin/env tsx
/**
 * Widget i18n(批0 地基)—— webazLocale() 探测瀑布 + L(zh,en) + compat-core 用户文案双语。
 * vm-eval 真实 __WIDGET_COMPAT_JS,注入不同 window.openai.locale / navigator.language,断言:
 *   - en locale → etaDisplay/copy 文案为英文(无 CJK);zh(默认)→ 与本地化前逐字一致(中文用户零感知)。
 * Usage: npm run test:widget-i18n
 */
import vm from 'node:vm'
import { __WIDGET_COMPAT_JS, PRODUCT_RESULTS_BODY_JS, QUOTE_APPROVAL_BODY_JS, ORDER_TIMELINE_BODY_JS } from '../src/layer1-agent/L1-1-mcp-server/ui-widgets.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const CJK = /[一-鿿]/

function evalWith(openaiLocale: string | undefined, navLang: string | undefined): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    window: { openai: openaiLocale !== undefined ? { locale: openaiLocale } : {} },
    navigator: navLang !== undefined ? { language: navLang } : {},
    document: { createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, appendChild: (x: unknown) => x }), body: { appendChild: (x: unknown) => x, removeChild: () => {} } },
    setTimeout, clearTimeout, Promise, URL, console, JSON, Math, String, Number, Object, Array, isFinite,
  }
  vm.createContext(sandbox)
  vm.runInContext(__WIDGET_COMPAT_JS + '\nthis.etaDisplay=etaDisplay; this.webazLocale=webazLocale; this.apprStatusText=apprStatusText; this.railNoteText=railNoteText;', sandbox)
  return sandbox
}

// zh 默认(无 openai.locale、navigator 中文)——回归锁:逐字与本地化前一致
const zh = evalWith(undefined, 'zh-CN')
const etaZh = zh.etaDisplay as (v: unknown, r?: unknown) => string
ok('zh: locale detected zh', (zh.webazLocale as () => string)() === 'zh')
ok('zh: etaDisplay number → 约12天 (unchanged)', etaZh(12) === '约12天')
ok('zh: etaDisplay region map → 约12天', etaZh({ SG: 12, all: 12 }, 'SG') === '约12天')
ok('zh: etaDisplay null → 暂未提供预计配送时间 (unchanged)', etaZh(null) === '暂未提供预计配送时间')
ok('zh: range → 3–5天', etaZh({ estimated_min_days: 3, estimated_max_days: 5 }) === '3–5天')

// en(ChatGPT locale=en-US)—— 无 CJK
const en = evalWith('en-US', undefined)
const etaEn = en.etaDisplay as (v: unknown, r?: unknown) => string
ok('en: locale detected en (window.openai.locale)', (en.webazLocale as () => string)() === 'en')
ok('en: etaDisplay number → ~12 days (no CJK)', etaEn(12) === '~12 days' && !CJK.test(etaEn(12)))
ok('en: etaDisplay region map → ~12 days', etaEn({ SG: 12, all: 12 }, 'SG') === '~12 days')
ok('en: etaDisplay null → English, no CJK', !CJK.test(etaEn(null)) && etaEn(null).length > 0)
ok('en: range → 3–5 days (no CJK)', etaEn({ estimated_min_days: 3, estimated_max_days: 5 }) === '3–5 days')

// apprStatusText:approval get 的 status 是裸机器码 + zh display_status(无 _en 投影)——客户端本地化锁
//   (审计 Finding-1 回归锁:QuoteApproval 实时刷新曾直接渲染裸码 'pending';现走单一 apprStatusText 双语)
const aEn = en.apprStatusText as (s: unknown, dz?: unknown) => string
const aZh = zh.apprStatusText as (s: unknown, dz?: unknown) => string
ok('appr: en bare code pending → English (no CJK, not raw code)', aEn('pending', '待批准') === 'Pending approval' && !CJK.test(aEn('pending', '待批准')))
ok('appr: en executed → English', aEn('executed', '已执行') === 'Executed — real order created')
ok('appr: zh bare code → server display_status (byte-unchanged)', aZh('pending', '待批准') === '待批准')
ok('appr: en unknown code → falls back to display_status (never blank)', aEn('weird_code', '奇怪') === '奇怪')
ok('appr: v2 object {label,label_en} → label_en under en / label under zh', aEn({ code: 'pending', label: '待批准', label_en: 'Pending approval' }) === 'Pending approval' && aZh({ code: 'pending', label: '待批准', label_en: 'Pending approval' }) === '待批准')
const rEn = en.railNoteText as (r: unknown, z?: unknown) => string
ok('rail: en direct_p2p → English no-custody note (no CJK)', /WebAZ holds no principal/.test(rEn('direct_p2p', 'zh')) && !CJK.test(rEn('direct_p2p', 'zh')))
ok('rail: zh → server zhFallback (byte-unchanged)', (zh.railNoteText as (r: unknown, z?: unknown) => string)('direct_p2p', '买家直接向卖家付款') === '买家直接向卖家付款')

// navigator.language 兜底(非 ChatGPT 宿主,无 window.openai.locale)
const enNav = evalWith(undefined, 'en-GB')
ok('cross-agent: navigator.language en-GB → en (waterfall fallback)', (enNav.webazLocale as () => string)() === 'en')
const zhNav = evalWith(undefined, 'fr-FR')
ok('cross-agent: non-en (fr) → zh default', (zhNav.webazLocale as () => string)() === 'zh')

// ── 综合防错漏:ProductResults 在 en locale 下真渲染,累积 textContent 扫零 widget-authored CJK ──
function renderEnAndScan(bodyJs: string, out: unknown): string {
  const texts: string[] = []
  const mkNode = (): Record<string, unknown> => {
    const n: Record<string, unknown> = { style: {}, classList: { toggle() {}, add() {} } }
    n.appendChild = (c: unknown) => c
    n.setAttribute = () => {}; n.addEventListener = () => {}; n.querySelector = () => null; n.scrollIntoView = () => {}
    let _t = ''
    Object.defineProperty(n, 'textContent', { set(v: unknown) { if (v != null) texts.push(String(v)); _t = String(v) }, get() { return _t } })
    Object.defineProperty(n, 'innerText', { set(v: unknown) { if (v != null) texts.push(String(v)) }, get() { return '' } })
    return n
  }
  const root = mkNode()
  const ctx: Record<string, unknown> = {
    window: { openai: { locale: 'en-US' }, innerWidth: 1200, pageYOffset: 0 },
    navigator: { language: 'en-US', clipboard: { writeText: () => Promise.resolve() } },
    document: { getElementById: () => root, createElement: () => mkNode(), createRange: () => ({ selectNodeContents() {} }) },
    setTimeout: (f: () => void) => { try { f() } catch { /* noop */ } return 0 }, clearTimeout, Promise, URL, Date, Math, JSON, String, Object, Array, Number, isFinite, console,
  }
  vm.createContext(ctx)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${bodyJs}\nthis.__r=renderBody`, ctx)
  ;(ctx.__r as (o: unknown, out: unknown) => void)({ callTool: () => Promise.resolve({ structuredContent: {} }), toolOutput: out }, out)
  return texts.join('')
}
const SEARCH_OUT = {
  schema_version: 'webaz.product_search.model.v1', count: 2, total_count: 6, more_url: 'https://webaz.xyz/#discover', result_handle: 'rh',
  fx: { rates: { SGD: 1.29 }, stale: false }, dest_region: 'SG', destination: { region: 'SG' },
  sellers: { s1: { name: 'Holden' } }, next_cursor: null,
  products: [
    { id: 'p1', title: 'Widget A', price: { display: '11.5 USDC', amount_minor: 11500000 }, seller_ref: 's1', stock_status: 'in_stock', estimated_days: { SG: 12, all: 12 }, display_eta: '约12天', return_days: 7, warranty_days: 0, handling_hours: 72, sales_count: 0, decision_flags: [{ code: 'NEW_SELLER', label: '新卖家(≤90 天)', label_en: 'New seller (≤90 d)', severity: 'info' }, { code: 'NO_SALES_HISTORY', label: '暂无成交记录', label_en: 'No sales yet', severity: 'warning' }], summary: 'x' },
    { id: 'p2', title: 'Widget B', price: { display: '9.2 USDC', amount_minor: 9200000 }, seller_ref: 's1', stock_status: 'in_stock', estimated_days: 12, return_days: 7, warranty_days: 0, handling_hours: 72, sales_count: 0, decision_flags: [] },
  ],
  recommendation: { product_id: 'p1', reason: 'best value' },
}
const enText = renderEnAndScan(PRODUCT_RESULTS_BODY_JS, SEARCH_OUT)
const cjkHits = enText.split('').filter(t => CJK.test(t))
ok('I18N-EN ProductResults renders ZERO CJK under en (incl. server decision_flags via label_en)', cjkHits.length === 0, 'leaked: ' + JSON.stringify(cjkHits.slice(0, 8)) + ' | text=' + enText.slice(0, 200))
ok('I18N-EN server decision_flags shown in English (label_en picked under en)', /New seller/.test(enText) && /No sales yet/.test(enText))

// ── 静态全扫锁:三张卡 body 里【每个】CJK 单引号字面量都必须是 L('zh','en') 的 zh 半边 ──
//    (无需渲染 harness 即可捕获 QuoteApproval/OrderTimeline 的任何漏译:未包裹的中文串一律不允许)
function unwrappedCJK(bodyJs: string): string[] {
  // 剥注释(// 行注释 + /* */ 块注释),避免注释里的中文误报;数据模式(.replace/.split 的实参)豁免。
  const code = bodyJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '')
  const out: string[] = []
  const re = /'((?:[^'\\]|\\.)*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    if (!/[一-鿿]/.test(m[1])) continue
    const before = code.slice(Math.max(0, m.index - 12), m.index)
    // 允许:L( 的第一个实参(zh 半边),或 .replace(/.split( 的匹配模式(数据,非展示文本)
    if (!/L\(\s*$/.test(before) && !/\.(replace|split)\(\s*$/.test(before)) out.push(m[1].slice(0, 24))
  }
  return out
}
for (const [name, body] of [['ProductResults', PRODUCT_RESULTS_BODY_JS], ['QuoteApproval', QUOTE_APPROVAL_BODY_JS], ['OrderTimeline', ORDER_TIMELINE_BODY_JS]] as const) {
  const leaked = unwrappedCJK(body)
  ok(`I18N-STATIC ${name}: every CJK literal is an L() zh-half (no unwrapped user string)`, leaked.length === 0, 'unwrapped: ' + JSON.stringify(leaked.slice(0, 8)))
}

if (fail > 0) { console.error(`\n❌ widget-i18n FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ widget-i18n batch0: webazLocale waterfall (openai.locale→navigator.language→zh) + L() + compat-core etaDisplay/copy bilingual; zh output byte-unchanged\n  ✅ pass ${pass}`)
