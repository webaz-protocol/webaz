#!/usr/bin/env tsx
/**
 * B-3 (Round1b P0) — internal procurement/cost/source fields must NEVER reach the buyer.
 * Agent catalog-create historically wrapped source_url / purchase_total_cost etc. into
 * agent_source_evidence / agent_package_evidence and wrote them into products.specs; the buyer
 * detail projection passed specs through verbatim = leak. This test locks it at the serialization
 * layer: sanitizeBuyerSpecs + projectProductDetail (full + summary + JSON-string specs) → zero leak.
 * Usage: npm run test:buyer-specs-privacy
 */
import { sanitizeBuyerSpecs, projectProductDetail } from '../src/agent-model-projection.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const INTERNAL = {
  agent_source_evidence: { source_platform: 'pdd', source_url: 'https://mobile.pinduoduo.com/goods.html?id=SECRET', source_seller: '某供货商', source_checked_at: '2026-07-01' },
  agent_package_evidence: { purchase_unit_price: 3.5, purchase_total_cost: 35.0, listing_pricing_note: '成本×2', pre_acceptance_checklist: '验货清单' },
  source_url: 'https://mobile.pinduoduo.com/goods.html?id=SECRET2',
  purchase_total_cost: 35.0,
}
const LEGIT = { 品牌: '豪势', 系列: '纯木底部抽', 组合规格: '10提', 每提抽数: 344, 单张尺寸: '156x175mm' }
const specs = { ...LEGIT, ...INTERNAL }

// Any of these substrings in a buyer-facing serialization = a leak.
const LEAK_TOKENS = ['agent_source_evidence', 'agent_package_evidence', 'source_url', 'source_platform', 'source_seller', 'source_checked_at', 'purchase_unit_price', 'purchase_total_cost', 'listing_pricing_note', 'pre_acceptance_checklist', 'pinduoduo', 'SECRET', '某供货商', '验货清单']
const leaks = (o: unknown): string[] => { const s = JSON.stringify(o); return LEAK_TOKENS.filter(t => s.includes(t)) }

// 1. sanitizeBuyerSpecs: strip internal, keep legit
const san = sanitizeBuyerSpecs(specs) as Record<string, unknown>
ok('sanitize keeps legit specs (品牌/每提抽数)', san['品牌'] === '豪势' && san['每提抽数'] === 344)
ok('sanitize strips ALL internal keys/values', leaks(san).length === 0)

// 2. sanitize accepts a JSON string (prod stores specs as TEXT)
ok('sanitize handles JSON-string specs → zero leak', leaks(sanitizeBuyerSpecs(JSON.stringify(specs))).length === 0)
// 3. non-object / null passthrough (no throw)
ok('sanitize null → null', sanitizeBuyerSpecs(null) === null)

// 4. projectProductDetail summary mode — buyer-facing, no leak
const prod: Record<string, unknown> = { id: 'prd_x', title: '豪势抽纸', price: 19.9, currency: 'WAZ', specs: JSON.stringify(specs), description: 'd' }
const sum = projectProductDetail(prod, {})
const sumLeak = leaks(sum)
ok('projectProductDetail(summary) — buyer sees legit specs', JSON.stringify(sum).includes('豪势'))
ok('projectProductDetail(summary) — ZERO internal leak', sumLeak.length === 0)

// 5. projectProductDetail full mode — complete terms, still no leak
const full = projectProductDetail(prod, { full: true })
const fullLeak = leaks(full)
ok('projectProductDetail(full) — ZERO internal leak', fullLeak.length === 0)
ok('projectProductDetail(full) — legit spec keys preserved', JSON.stringify((full as { specs?: unknown }).specs || {}).includes('品牌'))

if (fail > 0) {
  console.error(`\n❌ buyer-specs-privacy FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}` + (sumLeak.length ? `\n  summary leaked: ${sumLeak}` : '') + (fullLeak.length ? `\n  full leaked: ${fullLeak}` : ''))
  process.exit(1)
}
console.log(`✅ buyer-specs-privacy: internal procurement/cost/source (agent_source_evidence/agent_package_evidence/source_url/purchase_total_cost/…) excised at the buyer detail projection (sanitize + full + summary + JSON-string specs) — zero leak\n  ✅ pass ${pass}`)
