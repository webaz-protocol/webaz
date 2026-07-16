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
  'src/pwa/public/app.js': 25761,
  'src/pwa/public/app-cart-actions.js': 121,
  'src/pwa/public/app-edit-product-images.js': 107,
  'src/pwa/public/app-create-product-images.js': 29,
  'src/pwa/public/app-admin.js': 608,
  'src/pwa/public/app-seller.js': 199,
  'src/pwa/public/app-agents.js': 63,
  'src/pwa/public/app-agent-pair.js': 127,
  'src/pwa/public/app-agent-approvals.js':            93,
  'src/pwa/public/app-agent-approvals-order.js':      18,
  'src/pwa/public/app-agent-approvals-submit.js':     38,   // RFC-025 PR-5a 下单审批卡(新文件基线;Codex BLOCKER-3 两轮定稿)
  'src/pwa/public/app-grant-duration.js':             20,
  'src/pwa/public/app-agent-appeal.js':               90,
  'src/pwa/public/app-direct-pay.js': 226,
  'src/pwa/public/app-direct-pay-paymodal.js':        32,
  'src/pwa/public/app-direct-pay-readiness.js': 38,
  'src/pwa/public/app-direct-pay-deferral.js': 61,
  'src/pwa/public/app-direct-pay-deferral-admin.js': 72,
  'src/pwa/public/app-direct-pay-deferral-adjust.js': 35,
  'src/pwa/public/app-direct-pay-product-verify.js': 103,
  'src/pwa/public/app-direct-pay-store-verify.js': 100,
  'src/pwa/public/app-direct-pay-compliance.js':       67,
  'src/pwa/public/app-direct-pay-fee-ops.js':         112,
  'src/pwa/public/app-direct-pay-fee-center.js':      33,
  'src/pwa/public/app-direct-pay-sales-report.js':    70,
  'src/pwa/public/app-gmv-rail-split.js':             12,
  'src/pwa/public/app-direct-pay-accounts.js':       141,
  'src/pwa/public/app-direct-pay-buyer.js':           72,
  'src/pwa/public/app-direct-pay-pay.js':             15,
  'src/pwa/public/app-direct-pay-reveal.js':          82,
  'src/pwa/public/app-direct-pay-memo.js':            14,
  'src/pwa/public/app-direct-pay-copy.js':            12,
  'src/pwa/public/app-direct-pay-negotiation.js':     35,
  'src/pwa/public/app-mutual-cancel.js':              54,
  'src/pwa/public/app-dispute-close-ui.js':           38,
  'src/pwa/public/app-direct-pay-cancel-refund.js':   72,
  'src/pwa/public/app-direct-pay-returns.js':         56,
  'src/pwa/public/app-order-accept-ui.js':           158,
  'src/pwa/public/app-order-rail-filter.js':          26,
  'src/pwa/public/app-sale-regions-ui.js':            40,
  'src/pwa/public/app-free-shipping-ui.js':           29,
  'src/pwa/public/app-trade-tax-ui.js':               33,
  'src/pwa/public/app-purchase-terms-ui.js':          68,
  'src/pwa/public/app-listing-commerce-ui.js':        72,
  'src/pwa/public/app-bond-terms-ui.js':             23,
  'src/pwa/public/app-bond-ui.js':                   108,
  'src/pwa/public/app-bond-refund-ui.js':            66,
  'src/pwa/public/app-bond-slash-ui.js':             74,
  'src/pwa/public/app-bond-deferral-ui.js':          9,
  'src/pwa/public/app-direct-pay-reconcile.js':       19,
  'src/pwa/public/app-notif-templates.js':            22,
  'src/pwa/public/app-notif-templates-orders.js':     43,
  'src/pwa/public/app-order-errors.js':               50,
  'src/pwa/public/app-arbitrator-entry.js':           10,
  'src/pwa/public/app-arbitrator-admin.js':           87,
  'src/pwa/public/app-decline-contest-ui.js':         44,
  'src/pwa/public/app-decline-contest-ruling.js':     53,
  'src/pwa/public/app-contribution-hub.js':           23,
  'src/pwa/public/app-platform-receive-accounts.js': 140,
  'src/pwa/public/app-direct-pay-fee-request.js':     81,
  'src/pwa/public/app-direct-pay-fee-requests-admin.js': 70,
  'src/pwa/public/app-direct-pay-fee-history.js':        39,
  'src/pwa/public/app-escrow-waz-sim.js':              39,
  'src/pwa/public/app-chat-poll.js':                   29,
  'src/pwa/public/app-poll-governor.js':               22,
  'src/pwa/public/app-listings.js': 226,
  'src/pwa/public/app-external-links.js': 32,
  'src/pwa/public/app-product-media.js':       15,
  'src/pwa/public/app-product-gallery.js':     30,
  'src/pwa/public/app-connect.js':             60,
  'src/pwa/public/app-oauth-consent.js':       80,
  'src/pwa/public/app-oauth-consent-badge.js':       29,
  'src/pwa/public/app-product-image-ui.js':    35,
  'src/pwa/public/app-create-kinds.js':        17,
  'src/pwa/public/app-price.js':               55,
  'src/pwa/public/app-order-labels.js':        19,
  'src/pwa/public/app-shop.js': 1145,
  'src/pwa/public/app-account.js': 977,
  'src/pwa/public/app-profile.js': 1692,
  'src/pwa/public/app-discover.js': 1296,
  'src/pwa/public/app-discover-new-filters.js': 39,
  'src/pwa/public/app-contribution.js': 836,
  'src/pwa/public/app-admin-disputes.js': 55,
  'src/pwa/public/app-ai.js': 2162,
  'src/pwa/routes/orders-create.ts': 485,
  'src/cart-checkout.ts': 165,
  'src/agent-spend-cap.ts': 52,
  'src/price-session-consume.ts': 9,
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
