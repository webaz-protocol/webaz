#!/usr/bin/env tsx
/**
 * A1 widget sourcing — build parity + determinism + import-path + content-pin guards.
 *  P-1 parity:      checked-in widget-js.generated.ts must equal a fresh build (no hand edits / stale artifact)
 *  P-2 determinism: two consecutive builds are byte-identical (no timestamps/randomness)
 *  P-3 importable:  compat-core pure functions are directly importable (the A1 unit-test contract)
 *  P-4 content pin: the 6 widget HTML content hashes are EXACTLY the A2 build hashes —
 *                   any unintended drift is a regression. When a PR intentionally changes widget
 *                   content, update these pins AND append the superseded hashes to
 *                   KNOWN_STALE_WIDGET_HASHES (widget-template-compat.ts).
 * Usage: npm run test:widget-source-parity
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildWidgetJsModule, GENERATED_PATH } from './gen-widget-js.js'
import { etaDisplay, webazConsume } from '../src/layer1-agent/L1-1-mcp-server/widgets/src/compat-core.js'
import {
  PRODUCT_RESULTS_WIDGET_HTML, PRODUCT_RESULTS_WIDGET_MCP_HTML,
  QUOTE_APPROVAL_WIDGET_HTML, QUOTE_APPROVAL_WIDGET_MCP_HTML,
  ORDER_TIMELINE_WIDGET_HTML, ORDER_TIMELINE_WIDGET_MCP_HTML,
} from '../src/layer1-agent/L1-1-mcp-server/ui-widgets.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// P-1 + P-2
const build1 = buildWidgetJsModule()
const build2 = buildWidgetJsModule()
ok('P-1 checked-in generated artifact matches fresh build (run npm run gen:widgets if red)', build1 === readFileSync(GENERATED_PATH, 'utf8'))
ok('P-2 build is deterministic (two builds byte-identical)', build1 === build2)

// P-3 direct import of pure functions
ok('P-3 etaDisplay importable + region map (locale-tolerant; i18n verified in test:widget-i18n)', /^(约12天|~12 days)$/.test(etaDisplay({ SG: 12, all: 12 }, 'SG')))
ok('P-3 etaDisplay JSON-string (B-1)', /^(约12天|~12 days)$/.test(etaDisplay('{"SG":12,"all":12}')))
ok('P-3 webazConsume unwraps structuredContent', JSON.stringify(webazConsume({ structuredContent: { a: 1 } })) === '{"a":1}')

// P-4 content pins (round1b == A1; see header before touching)
const uiVer = (html: string): string => createHash('sha256').update(html).digest('hex').slice(0, 10)
const PINS: Array<[string, string, string]> = [
  ['PRODUCT_RESULTS_WIDGET_HTML', uiVer(PRODUCT_RESULTS_WIDGET_HTML), 'bef81e60b3'],
  ['PRODUCT_RESULTS_WIDGET_MCP_HTML', uiVer(PRODUCT_RESULTS_WIDGET_MCP_HTML), '950e881d2a'],
  ['QUOTE_APPROVAL_WIDGET_HTML', uiVer(QUOTE_APPROVAL_WIDGET_HTML), '394429e5e0'],
  ['QUOTE_APPROVAL_WIDGET_MCP_HTML', uiVer(QUOTE_APPROVAL_WIDGET_MCP_HTML), '77c75b6890'],
  ['ORDER_TIMELINE_WIDGET_HTML', uiVer(ORDER_TIMELINE_WIDGET_HTML), '143b11a502'],
  ['ORDER_TIMELINE_WIDGET_MCP_HTML', uiVer(ORDER_TIMELINE_WIDGET_MCP_HTML), '5a7bb703e3'],
]
for (const [name, got, want] of PINS) ok(`P-4 ${name} content hash pinned ${want} (got ${got})`, got === want)

if (fail > 0) { console.error(`\n❌ widget-source-parity FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ widget-source-parity: artifact parity + deterministic build + importable compat-core + 6 content-hash pins\n  ✅ pass ${pass}`)
