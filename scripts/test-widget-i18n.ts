#!/usr/bin/env tsx
/**
 * Widget i18n(批0 地基)—— webazLocale() 探测瀑布 + L(zh,en) + compat-core 用户文案双语。
 * vm-eval 真实 __WIDGET_COMPAT_JS,注入不同 window.openai.locale / navigator.language,断言:
 *   - en locale → etaDisplay/copy 文案为英文(无 CJK);zh(默认)→ 与本地化前逐字一致(中文用户零感知)。
 * Usage: npm run test:widget-i18n
 */
import vm from 'node:vm'
import { __WIDGET_COMPAT_JS } from '../src/layer1-agent/L1-1-mcp-server/ui-widgets.js'

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
  vm.runInContext(__WIDGET_COMPAT_JS + '\nthis.etaDisplay=etaDisplay; this.webazLocale=webazLocale;', sandbox)
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

// navigator.language 兜底(非 ChatGPT 宿主,无 window.openai.locale)
const enNav = evalWith(undefined, 'en-GB')
ok('cross-agent: navigator.language en-GB → en (waterfall fallback)', (enNav.webazLocale as () => string)() === 'en')
const zhNav = evalWith(undefined, 'fr-FR')
ok('cross-agent: non-en (fr) → zh default', (zhNav.webazLocale as () => string)() === 'zh')

if (fail > 0) { console.error(`\n❌ widget-i18n FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ widget-i18n batch0: webazLocale waterfall (openai.locale→navigator.language→zh) + L() + compat-core etaDisplay/copy bilingual; zh output byte-unchanged\n  ✅ pass ${pass}`)
