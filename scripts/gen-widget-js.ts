#!/usr/bin/env tsx
/**
 * A1 widget sourcing — deterministic generator: widgets/src/*.ts (real, typechecked, lintable,
 * unit-importable source files) → widgets/widget-js.generated.ts (the runtime JS strings that
 * buildWidgetHtml() concatenates into each widget's single <script>).
 *
 * Transform contract (byte-exactness is the whole point — the emitted strings must equal the
 * pre-A1 template literals so widget HTML content hashes DO NOT change in A1):
 *   1. strip the `export ` markers added so tests can `import { etaDisplay } from compat-core`
 *      (only line-leading `export function` forms are stripped — original code had no exports);
 *   2. strip the trailing `export {}\n` line added so script-style parts (bodies/boots) compile
 *      as isolated modules under tsc.
 * Output is emitted with JSON.stringify (stable escaping) and no timestamps/randomness:
 * same inputs → same bytes, verified by scripts/test-widget-source-parity.ts (regen + diff, twice).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WIDGETS_SRC_DIR = path.join(HERE, '../src/layer1-agent/L1-1-mcp-server/widgets/src')
export const GENERATED_PATH = path.join(HERE, '../src/layer1-agent/L1-1-mcp-server/widgets/widget-js.generated.ts')

export const WIDGET_JS_PARTS: ReadonlyArray<readonly [file: string, constName: string]> = [
  ['theme-boot.ts', 'WIDGET_THEME_JS'],
  ['compat-core.ts', 'WIDGET_COMPAT_CORE_JS'],
  ['compat-link.ts', 'WIDGET_COMPAT_LINK_JS'],
  ['boot-legacy.ts', 'WIDGET_BOOT_LEGACY_JS'],
  ['bridge-standard.ts', 'WIDGET_BRIDGE_STANDARD_JS'],
  ['boot-standard.ts', 'WIDGET_BOOT_STANDARD_JS'],
  ['product-results-body.ts', 'PRODUCT_RESULTS_BODY_JS'],
  ['quote-approval-body.ts', 'QUOTE_APPROVAL_BODY_JS'],
  ['order-timeline-body.ts', 'ORDER_TIMELINE_BODY_JS'],
] as const

/** source file text → runtime script string (see transform contract above) */
export function sourceToRuntimeJs(text: string): string {
  return text
    .replace(/^\/\/ @ts-nocheck[^\n]*\n/, '')
    .replace(/^([ \t]*)export (?=function )/gm, '$1')
    .replace(/export \{\}\n$/, '')
}

export function buildWidgetJsModule(): string {
  const parts: string[] = []
  const hashes: string[] = []
  for (const [file, constName] of WIDGET_JS_PARTS) {
    const raw = readFileSync(path.join(WIDGETS_SRC_DIR, file), 'utf8')
    const js = sourceToRuntimeJs(raw)
    hashes.push(`//   ${constName} sha256:${createHash('sha256').update(js).digest('hex').slice(0, 12)} (${file})`)
    parts.push(`export const ${constName} = ${JSON.stringify(js)}`)
  }
  return `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: src/layer1-agent/L1-1-mcp-server/widgets/src/*.ts
// Regenerate:      npm run gen:widgets
// Parity guard:    npm run test:widget-source-parity (checked-in artifact must match a fresh build)
${hashes.join('\n')}
${parts.join('\n')}
`
}

// Direct invocation: (re)write the generated module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mod = buildWidgetJsModule()
  writeFileSync(GENERATED_PATH, mod)
  console.log(`gen:widgets → ${path.relative(process.cwd(), GENERATED_PATH)} (${mod.length} bytes, sha256:${createHash('sha256').update(mod).digest('hex').slice(0, 12)})`)
}
