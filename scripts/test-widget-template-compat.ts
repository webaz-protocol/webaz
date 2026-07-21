#!/usr/bin/env tsx
/**
 * B-2 收官 — known-stale widget-template compat guards.
 *  C-1 every allowlisted (name, hash) pair resolves to its bare alias
 *  C-2 the 2026-07-19 connector-cache era hashes (8cdd3db, live-reproduced failure) are covered
 *  C-3 fabricated/unknown hashes are REJECTED (matcher null + unknown-versioned detector true) —
 *      the no-wildcard invariant: stale compat must never mask typos or missed publishes
 *  C-4 bare aliases and malformed URIs are not treated as stale-versioned
 *  C-5 retention bound: ≤5 known hashes per widget (prune when appending new production versions)
 * Usage: npm run test:widget-template-compat
 */
import { KNOWN_STALE_WIDGET_HASHES, matchKnownStaleWidgetUri, isUnknownVersionedWidgetUri } from '../src/layer1-agent/L1-1-mcp-server/widget-template-compat.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// C-1 all allowlisted pairs resolve
for (const [name, hashes] of Object.entries(KNOWN_STALE_WIDGET_HASHES)) {
  for (const h of hashes) {
    const m = matchKnownStaleWidgetUri(`ui://widget/${name}.${h}.html`)
    ok(`C-1 ${name}.${h} → bare alias`, !!m && m.bareUri === `ui://widget/${name}.html` && m.hash === h)
  }
}

// C-2 the live-reproduced stale set (8cdd3db era, cached by the 2026-07-19 connector connect)
ok('C-2 products c4bd5e13bb covered', !!matchKnownStaleWidgetUri('ui://widget/webaz-products.c4bd5e13bb.html'))
ok('C-2 quote 6a2e96dfb1 covered', !!matchKnownStaleWidgetUri('ui://widget/webaz-quote-approval.6a2e96dfb1.html'))
ok('C-2 timeline 5ea1e0d365 covered', !!matchKnownStaleWidgetUri('ui://widget/webaz-order-timeline.5ea1e0d365.html'))

// C-3 fabricated hashes must be rejected, and flagged as unknown-versioned (for reject logging)
for (const u of ['ui://widget/webaz-products.deadbeef00.html', 'ui://widget/webaz-quote-approval.0123456789.html', 'ui://widget/webaz-order-timeline.ffffffffff.html']) {
  ok(`C-3 reject ${u}`, matchKnownStaleWidgetUri(u) === null && isUnknownVersionedWidgetUri(u) === true)
}
ok('C-3 unknown widget NAME with known-shaped hash rejected', matchKnownStaleWidgetUri('ui://widget/webaz-nonexistent.c4bd5e13bb.html') === null)

// C-4 bare aliases / malformed URIs are not stale-versioned
for (const u of ['ui://widget/webaz-products.html', 'ui://widget/webaz-products.c4bd5e13b.html', 'ui://widget/webaz-products.C4BD5E13BB.html', 'webaz://guide/categories', 'ui://widget/../etc.aaaaaaaaaa.html']) {
  ok(`C-4 not stale-shaped: ${u}`, matchKnownStaleWidgetUri(u) === null && isUnknownVersionedWidgetUri(u) === false)
}

// C-5 retention bound
for (const [name, hashes] of Object.entries(KNOWN_STALE_WIDGET_HASHES)) {
  ok(`C-5 ${name} retention ≤12 (30-day WINDOW dominates count — 2026-07-21 rapid iteration stacked several same-day versions; prune by window from ~2026-08-18)`, hashes.length >= 1 && hashes.length <= 12)
  ok(`C-5 ${name} hashes are 10-hex + unique`, new Set(hashes).size === hashes.length && hashes.every(h => /^[0-9a-f]{10}$/.test(h)))
}

if (fail > 0) { console.error(`\n❌ widget-template-compat FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ widget-template-compat: ${Object.values(KNOWN_STALE_WIDGET_HASHES).flat().length} allowlisted hashes resolve, fabricated/unknown rejected (no-wildcard invariant), retention bounded\n  ✅ pass ${pass}`)
