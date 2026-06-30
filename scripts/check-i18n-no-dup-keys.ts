#!/usr/bin/env tsx
/**
 * i18n dictionary hygiene gate — fail if the `_EN` map in src/pwa/public/i18n.js has any duplicate key.
 *
 * Why: i18n.js is a single object literal (`const _EN = { … }`) and `t(zh) = _EN[zh] || zh`.
 *   Duplicate keys are last-wins, so an earlier translation is silently overridden by a later one —
 *   the exact class of bug that shipped in PR #144 (提交证据 button vs timeline label).
 *
 * Implementation note: we parse the `_EN` object literal via the TypeScript AST and count every
 *   property key. A line-regex misses multi-line values (key on one line, value on the next) and
 *   double-quoted values — both occur in this file — so it under-reports duplicates (the PR #146 P1 bug).
 *
 * Usage: npm run check:i18n-dup   (exit 1 on any duplicate)
 */
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const FILE = 'src/pwa/public/i18n.js'

/** Parse `_EN` and return key -> [1-based line numbers] for every property assignment. */
export function collectEnKeyLines(source: string): Map<string, number[]> {
  const sf = ts.createSourceFile(FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let obj: ts.ObjectLiteralExpression | undefined
  const findEN = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) && node.name.text === '_EN' &&
      node.initializer && ts.isObjectLiteralExpression(node.initializer)
    ) { obj = node.initializer }
    ts.forEachChild(node, findEN)
  }
  findEN(sf)
  if (!obj) throw new Error(`could not find \`const _EN = { … }\` object literal in ${FILE}`)

  const seen = new Map<string, number[]>()
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const n = prop.name
    let key: string | undefined
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) key = n.text
    else if (ts.isIdentifier(n)) key = n.text
    if (key === undefined) continue
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const arr = seen.get(key) || []
    arr.push(line)
    seen.set(key, arr)
  }
  return seen
}

/** key -> lines for keys that appear more than once. */
export function findDuplicateKeys(source: string): Map<string, number[]> {
  return new Map([...collectEnKeyLines(source)].filter(([, ls]) => ls.length > 1))
}

// ── CLI (only when run directly, not when imported by the test) ──
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const src = readFileSync(FILE, 'utf8')
  const total = collectEnKeyLines(src).size
  const dups = findDuplicateKeys(src)
  if (dups.size > 0) {
    console.error(`❌ i18n dup-key gate: ${dups.size} duplicate key(s) in ${FILE} (last-wins silently overrides earlier)`)
    for (const [k, ls] of dups) console.error(`  ✗ '${k}' @ lines ${ls.join(', ')}`)
    console.error(`\nResolve each: keep one value, or give one context a distinct key (see PR #145 提交证据→证据提交).`)
    process.exit(1)
  }
  console.log(`✅ i18n dup-key gate: ${total} keys, 0 duplicates`)
}
