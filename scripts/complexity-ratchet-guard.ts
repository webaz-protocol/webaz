/**
 * Complexity ratchet guard
 *
 * A latch against complexity regrowth — NOT a quality cudgel. It does not judge
 * whether a file is "good"; it only refuses to let known complexity debt grow
 * back after we pay it down.
 *
 * Principle: each baseline below EQUALS the current debt. Future PRs may only
 * LOWER a baseline, intentionally, as the file shrinks / DDL is extracted. A PR
 * may never raise one. (route deps fan-in is deferred to v2 — it needs an
 * AST/text rule first, or formatting churn would cause false positives.)
 *
 * Two kinds of baseline:
 *   - LOC ceilings (upper-bound, wc -l semantics): the tracked large file must
 *     not EXCEED its line count. Trimming below is fine; lower the ceiling when
 *     you do, so the gain is locked in.
 *   - server.ts inline-DDL counts (strict equality): the number of `CREATE
 *     TABLE` / `ALTER TABLE` occurrences in server.ts must match EXACTLY. New
 *     DDL therefore cannot land in server.ts (count would rise → FAIL — put it
 *     in schema-init instead); extraction requires consciously lowering the
 *     number (count would fall → FAIL until you do).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// LOC ceilings — wc -l semantics (newline count). File must not exceed this.
// Lower a ceiling when you trim the file; never raise one.
const LOC_CEILINGS: Record<string, number> = {
  'src/pwa/server.ts': 8394,
  'src/pwa/public/app.js': 25856,
  'src/pwa/public/app-admin.js': 608,
  'src/pwa/public/app-seller.js': 199,
  'src/pwa/public/app-agents.js': 63,
  'src/pwa/public/app-direct-pay.js': 227,
  'src/pwa/public/app-direct-pay-readiness.js': 38,
  'src/pwa/public/app-direct-pay-deferral.js': 61,
  'src/pwa/public/app-direct-pay-deferral-admin.js': 72,
  'src/pwa/public/app-direct-pay-product-verify.js': 103,
  'src/pwa/public/app-direct-pay-store-verify.js': 100,
  'src/pwa/public/app-direct-pay-compliance.js':       67,
  'src/pwa/public/app-direct-pay-fee-ops.js':         112,
  'src/pwa/public/app-direct-pay-fee-center.js':      33,
  'src/pwa/public/app-prelaunch-waz.js':               39,
  'src/pwa/public/app-chat-poll.js':                   29,
  'src/pwa/public/app-listings.js': 226,
  'src/pwa/public/app-external-links.js': 32,
  'src/pwa/public/app-shop.js': 1145,
  'src/pwa/public/app-account.js': 977,
  'src/pwa/public/app-profile.js': 1692,
  'src/pwa/public/app-discover.js': 1296,
  'src/pwa/public/app-contribution.js': 836,
  'src/pwa/public/app-ai.js': 2162,
  'src/pwa/routes/orders-create.ts': 514,
}

// server.ts inline DDL — strict equality. Lower only as DDL moves to schema-init.
const SERVER_TS = 'src/pwa/server.ts'
const SERVER_DDL_EXACT: Record<string, number> = {
  'CREATE TABLE': 55,
  'ALTER TABLE': 234,
}

// wc -l semantics: count newline characters (a trailing newline = its line's terminator).
function wcLines(rel: string): number {
  const content = readFileSync(join(ROOT, rel), 'utf8')
  const m = content.match(/\n/g)
  return m ? m.length : 0
}

function occurrences(rel: string, needle: string): number {
  const content = readFileSync(join(ROOT, rel), 'utf8')
  const re = new RegExp(needle, 'gi')
  const m = content.match(re)
  return m ? m.length : 0
}

let failed = false

console.log('— LOC ceilings (upper-bound, wc -l) —')
for (const [rel, max] of Object.entries(LOC_CEILINGS)) {
  const n = wcLines(rel)
  if (n > max) {
    failed = true
    console.error(`  ✗ ${rel}: ${n} lines > ceiling ${max}. This file must not grow — extract instead of adding here.`)
  } else if (n < max) {
    console.log(`  ✓ ${rel}: ${n} ≤ ${max}  (trimmed ${max - n} — you may lower the ceiling to ${n})`)
  } else {
    console.log(`  ✓ ${rel}: ${n} == ${max}`)
  }
}

console.log('— server.ts inline DDL (strict equality) —')
for (const [label, want] of Object.entries(SERVER_DDL_EXACT)) {
  const n = occurrences(SERVER_TS, label)
  if (n > want) {
    failed = true
    console.error(`  ✗ server.ts ${label}: ${n} > ${want}. New DDL belongs in schema-init, not server.ts.`)
  } else if (n < want) {
    failed = true
    console.error(`  ✗ server.ts ${label}: ${n} < ${want}. You extracted DDL — lower this baseline to ${n} in scripts/complexity-ratchet-guard.ts.`)
  } else {
    console.log(`  ✓ server.ts ${label}: ${n} == ${want}`)
  }
}

if (failed) {
  console.error('\ncomplexity ratchet drift — see messages above. Baselines may only be LOWERED intentionally, never raised.')
  process.exit(1)
}
console.log('\ncomplexity ratchet OK')
