#!/usr/bin/env tsx
/**
 * Order-tracking timeline status i18n (i18n line, PR-A).
 *
 * The order-detail tracking timeline rendered its status labels RAW — `${STATUS_ZH[x] || x}` — so the Chinese
 * label leaked into EN mode (the "MAP[x]||x raw-render" gap class the hardcode scanner can't see). Fix: wrap the
 * render in t() AND ensure every STATUS_ZH value has an EN key (t() falls back to the Chinese key otherwise).
 *
 * NOTE (verified 2026-07-01): the order-ACTION buttons (getActions → renderActions) were already fully bilingual
 * — every label/noteLabel/placeholder is t()-wrapped at render with keys present — so no change was needed there.
 *
 * Usage: npm run test:order-status-timeline-i18n
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. the timeline render is t()-wrapped (no more raw STATUS_ZH[...] || ... leak)
ok('1a. timeline from_status render is t()-wrapped', APP.includes('${t(STATUS_ZH[h.from_status] || h.from_status)}'))
ok('1b. timeline to_status render is t()-wrapped', APP.includes('${t(STATUS_ZH[h.to_status] || h.to_status)}'))
ok('1c. no raw (un-t()) STATUS_ZH render remains', !/\$\{STATUS_ZH\[h\.(from|to)_status\] \|\| h\.(from|to)_status\}/.test(APP))

// 2. parse the STATUS_ZH map and assert EVERY value has an EN key (behavioral coverage — not a hand list)
const block = APP.slice(APP.indexOf('const STATUS_ZH = {'))
const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'))
const values = [...body.matchAll(/:\s*'([^']+)'/g)].map(m => m[1])
ok('2a. STATUS_ZH map parsed (>= 16 statuses)', values.length >= 16)
const missing = values.filter(v => !I18N.includes(`'${v}':`))
ok(`2b. every STATUS_ZH value has an EN key (missing: ${missing.join(', ') || 'none'})`, missing.length === 0)

// 3. the two newly-added direct-pay statuses map to sensible EN
ok('3a. 直付待付款 → EN', /'直付待付款':\s*'Direct pay · to pay'/.test(I18N))
ok('3b. 直付超时未确认 → EN', /'直付超时未确认':\s*'Direct pay · timed out'/.test(I18N))

if (fail > 0) { console.error(`\n❌ order-status timeline i18n FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order-status timeline i18n: render t()-wrapped + all ${values.length} STATUS_ZH values have EN keys\n  ✅ pass ${pass}`)
