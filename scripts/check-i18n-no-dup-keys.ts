#!/usr/bin/env tsx
/**
 * i18n dictionary hygiene gate — fail if src/pwa/public/i18n.js has any duplicate key.
 *
 * Why: i18n.js is a single object literal (`const _EN = { … }`) and `t(zh) = _EN[zh] || zh`.
 *   Duplicate keys are last-wins, so an earlier translation is silently overridden by a later one —
 *   the exact class of bug that shipped in PR #144 (提交证据 button vs timeline label). This gate keeps
 *   the dictionary one-entry-per-key so collisions must be resolved (pick one value, or rename a key)
 *   rather than accumulate.
 *
 * Usage: npm run check:i18n-dup   (exit 1 on any duplicate)
 */
import { readFileSync } from 'node:fs'

const FILE = 'src/pwa/public/i18n.js'
const lines = readFileSync(FILE, 'utf8').split('\n')
// match a top-level dictionary entry line: '<key>': '<value>',  (single-quoted key + value)
const KEY_LINE = /^\s*'((?:[^'\\]|\\.)*)':\s*'(?:[^'\\]|\\.)*',?\s*$/

const seen = new Map<string, number[]>()
lines.forEach((ln, i) => {
  const m = KEY_LINE.exec(ln)
  if (m) {
    const k = m[1]
    const arr = seen.get(k) || []
    arr.push(i + 1)
    seen.set(k, arr)
  }
})

const dups = [...seen.entries()].filter(([, ls]) => ls.length > 1)
if (dups.length > 0) {
  console.error(`❌ i18n dup-key gate: ${dups.length} duplicate key(s) in ${FILE} (last-wins silently overrides earlier)`)
  for (const [k, ls] of dups) console.error(`  ✗ '${k}' @ lines ${ls.join(', ')}`)
  console.error(`\nResolve each: keep one value, or give one context a distinct key (see PR #145 提交证据→证据提交).`)
  process.exit(1)
}
console.log(`✅ i18n dup-key gate: ${seen.size} keys, 0 duplicates`)
