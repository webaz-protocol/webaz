#!/usr/bin/env tsx
/**
 * i18n 默认语言 —— resolveInitialLang 纯函数 + setLang 持久化 (feat: default language from browser preference)。
 * 规则:saved 'zh'/'en' 永远优先;否则 navigator.languages→language,任一 zh* → zh,其余(含无 navigator)→ en。
 * 用 node:vm 在隔离沙箱里加载 i18n.js(避免碰 Node 的 navigator/localStorage 全局)。
 * Usage: npm run test:i18n-default-language
 */
import { readFileSync } from 'fs'
import vm from 'node:vm'

const code = readFileSync('src/pwa/public/i18n.js', 'utf8')

// 在沙箱里加载 i18n.js,返回其 window(含 resolveInitialLang / setLang / _lang)+ setItem 调用记录。
function loadI18n(opts: { navigator?: unknown; saved?: string | null } = {}): { win: any; setCalls: Array<[string, string]> } {
  const setCalls: Array<[string, string]> = []
  const win: Record<string, unknown> = {}
  const localStorage = { getItem: (_k: string) => opts.saved ?? null, setItem: (k: string, v: string) => { setCalls.push([k, v]) } }
  const sandbox: Record<string, unknown> = { window: win, localStorage, navigator: opts.navigator, console }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return { win, setCalls }
}

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? ` (${d})` : ''}`) } }

const { win } = loadI18n()
const R = (saved: string | null, nav: unknown): string => win.resolveInitialLang(saved, nav)

// 1–2. saved manual choice always wins
ok('1. saved="zh" → zh', R('zh', { language: 'en-US' }) === 'zh')
ok('2. saved="en" → en', R('en', { languages: ['zh-CN'] }) === 'en')
// 3. bad saved value ignored → fall to browser detection
ok('3. saved="bad-value" + navigator en-US → en', R('bad-value', { language: 'en-US' }) === 'en', R('bad-value', { language: 'en-US' }))
// 4. languages[] preferred, first zh wins
ok('4. no saved + languages=[zh-CN,en-US] → zh', R(null, { languages: ['zh-CN', 'en-US'] }) === 'zh')
// 5. single language zh-TW → zh (via .language fallback)
ok('5. no saved + language="zh-TW" → zh', R(null, { language: 'zh-TW' }) === 'zh')
// 6. English browser → en
ok('6. no saved + languages=[en-US] → en', R(null, { languages: ['en-US'] }) === 'en')
// 7. other language → en
ok('7. no saved + languages=[fr-FR] → en', R(null, { languages: ['fr-FR'] }) === 'en')
// 8. no navigator → en
ok('8. no saved + no navigator → en', R(null, null) === 'en')
ok('8b. no saved + empty navigator {} → en', R(null, {}) === 'en')
// extra edge cases (robustness)
ok('E1. zh-Hant (case/subtag) → zh', R(null, { languages: ['ZH-HANT'] }) === 'zh')
ok('E2. bare "zh" → zh', R(null, { language: 'zh' }) === 'zh')
ok('E3. languages empty array falls back to .language', R(null, { languages: [], language: 'zh-CN' }) === 'zh')
ok('E4. non-string entries ignored, no throw', R(null, { languages: [null, 42, 'fr'] }) === 'en')

// 9. setLang still persists to localStorage.webaz_lang and updates _lang
const { win: win2, setCalls } = loadI18n()
win2.setLang('en')
ok('9. setLang("en") writes localStorage.webaz_lang="en"', setCalls.some(([k, v]) => k === 'webaz_lang' && v === 'en'), JSON.stringify(setCalls))
ok('9b. setLang updates window._lang', win2._lang === 'en')

// integration: the top-level init uses resolveInitialLang (no saved, zh browser → zh; en browser → en)
ok('init. no saved + zh navigator → window._lang zh', loadI18n({ navigator: { languages: ['zh-CN'] } }).win._lang === 'zh')
ok('init. no saved + en navigator → window._lang en', loadI18n({ navigator: { languages: ['en-US'] } }).win._lang === 'en')
ok('init. saved zh + en navigator → window._lang zh (manual wins)', loadI18n({ saved: 'zh', navigator: { languages: ['en-US'] } }).win._lang === 'zh')

if (fail > 0) { console.error(`\n❌ i18n default language FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ i18n default language: saved 'zh'/'en' wins · else navigator zh* → zh / else → en · setLang persists webaz_lang · manual choice never overridden\n  ✅ pass ${pass}`)
