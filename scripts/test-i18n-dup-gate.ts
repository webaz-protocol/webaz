#!/usr/bin/env tsx
/**
 * Negative tests for the i18n dup-key gate (scripts/check-i18n-no-dup-keys.ts).
 *
 * The gate parses the `_EN` object literal via the TS AST precisely BECAUSE a line-regex misses
 * multi-line values and double-quoted values (the PR #146 P1 bug — those slipped past the regex gate).
 * These fixtures prove the AST gate catches duplicates in exactly those shapes.
 *
 * Usage: npm run test:i18n-dup-gate
 */
import { findDuplicateKeys } from './check-i18n-no-dup-keys.ts'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const wrap = (body: string) => `window._lang='zh'\nconst _EN = {\n${body}\n}\nwindow.t = (zh) => _EN[zh] || zh\n`
const dupKeys = (body: string) => [...findDuplicateKeys(wrap(body)).keys()]

// 1. clean dictionary → no duplicates
ok('1. clean dict reports 0 dups', dupKeys(`  '甲': 'A',\n  '乙': 'B',`).length === 0)

// 2. single-line dup (baseline)
ok('2. single-line dup detected', dupKeys(`  '甲': 'A',\n  '甲': 'A2',`).includes('甲'))

// 3. MULTI-LINE value dup (regex gate missed this — key on one line, value on the next)
ok('3. multi-line-value dup detected', dupKeys(`  '甲': 'A',\n  '甲':\n    'A spanning the next line',`).includes('甲'))

// 4. DOUBLE-QUOTED value dup (regex gate matched only single-quoted values)
ok('4. double-quoted-value dup detected', dupKeys(`  '甲': 'A',\n  '甲': "A double quoted",`).includes('甲'))

// 5. DOUBLE-QUOTED key dup
ok('5. double-quoted-key dup detected', dupKeys(`  '甲': 'A',\n  "甲": 'A2',`).includes('甲'))

// 6. one dup among clean entries is isolated
ok('6. only the duplicated key is reported', JSON.stringify(dupKeys(`  '甲': 'A',\n  '乙': 'B',\n  '乙':\n    'B2',`)) === JSON.stringify(['乙']))

// 7. the real shipped file is clean (defense-in-depth alongside check:i18n-dup)
import { readFileSync } from 'node:fs'
ok('7. live i18n.js has 0 duplicate keys', findDuplicateKeys(readFileSync('src/pwa/public/i18n.js', 'utf8')).size === 0)

if (fail > 0) { console.error(`\n❌ i18n dup-gate tests FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ i18n dup-gate: AST detector catches single-line / multi-line-value / double-quoted dups; live file clean\n  ✅ pass ${pass}`)
