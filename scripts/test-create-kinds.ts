#!/usr/bin/env tsx
/**
 * Unified create entry (app-create-kinds.js) — secondhand #1.
 *
 * WebAZ had two isolated create surfaces: the seller new-goods form (inline in the #seller 商品 tab) and the
 * standalone #secondhand/publish page. A seller in one never saw the other. createKindChooserHtml renders a
 * "全新商品 ⇄ 二手闲置" segmented chooser injected at the top of BOTH forms, so each surfaces the other kind.
 * The two backends (/api/products vs /api/secondhand) are NOT merged — only the entry is unified.
 *
 * Usage: npm run test:create-kinds
 */
import { readFileSync } from 'node:fs'

const KINDS = readFileSync('src/pwa/public/app-create-kinds.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// 1. BEHAVIORAL — eval the real chooser (pure: only needs a fake window with a passthrough t())
const w: Record<string, unknown> = { t: (s: string) => s } as never
;(new Function('window', KINDS))(w)
const chooser = w.createKindChooserHtml as (c: string) => string
const asNew = chooser('new')
const asSh = chooser('secondhand')

ok('1a. new-view: 全新商品 pill is the inert active <span> (no navigation)', /全新商品<\/span>/.test(asNew))
ok('1b. new-view: 二手闲置 pill navigates to #secondhand/publish', asNew.includes("location.hash='#secondhand/publish'") && asNew.includes('二手闲置</button>'))
ok('1c. secondhand-view: 二手闲置 pill is the inert active <span>', /二手闲置<\/span>/.test(asSh))
ok('1d. secondhand-view: 全新商品 pill uses the goCreateListingFromBuy smart entry', asSh.includes('onclick="goCreateListingFromBuy()"') && asSh.includes('全新商品</button>'))
ok('1e. active pill never carries an onclick (inert)', !/(<span[^>]*onclick)/.test(asNew) && !/(<span[^>]*onclick)/.test(asSh))
ok('1f. always emits exactly two pills', (asNew.match(/全新商品|二手闲置/g) || []).length === 2 && (asSh.match(/全新商品|二手闲置/g) || []).length === 2)

// 2. both create surfaces inject the chooser (guarded so a stale cached app-create-kinds.js just no-ops)
ok('2a. new-goods form injects chooser(new)', has(APP, "window.createKindChooserHtml('new')"))
ok('2b. secondhand publish injects chooser(secondhand)', has(APP, "window.createKindChooserHtml('secondhand')"))
ok('2c. injection is null-guarded (window.createKindChooserHtml ? …)', has(APP, 'window.createKindChooserHtml ?'))

// 3. i18n bilingual parity for the new strings
ok('3a. 全新商品 has an EN entry', /'全新商品':\s*'New goods'/.test(I18N))
ok('3b. 二手闲置 has an EN entry', /'二手闲置':\s*'Secondhand'/.test(I18N))

// 4. wiring: load order + Guard B (check:pwa-syntax + LOC_CEILINGS) + test registered
ok('4a. index.html loads app-create-kinds.js before app.js', HTML.indexOf('/app-create-kinds.js') > 0 && HTML.indexOf('/app-create-kinds.js') < HTML.indexOf('/app.js'))
ok('4b. app-create-kinds.js in check:pwa-syntax', has(PKG, 'node --check src/pwa/public/app-create-kinds.js'))
ok('4c. app-create-kinds.js has a LOC ceiling', /'src\/pwa\/public\/app-create-kinds\.js':/.test(RATCHET))
ok('4d. test:create-kinds registered in package.json', has(PKG, '"test:create-kinds"'))

if (fail > 0) { console.error(`\n❌ create-kinds FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ unified create entry: 全新商品 ⇄ 二手闲置 chooser (behavioral) injected into both create forms + bilingual + wired\n  ✅ pass ${pass}`)
