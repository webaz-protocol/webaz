#!/usr/bin/env tsx
/**
 * ChatGPT-card contract test (Phase-2, no side effects, no network, no DB writes).
 *
 * Locks the invariants the Phase-2 audit VERIFIED by reading the code, so a future change that breaks
 * them fails loudly:
 *   - projectProductDetail byte-caps description(900)/specs(800)/return_condition(200) and which of those
 *     carry a truncation FLAG (description_truncated / specs_truncated) vs. silently truncate (return_condition).
 *   - projectSubmitConsumer maps idempotency.duplicate → top-level duplicate + duplicate_warning + schema_version.
 *   - the envelope summary is computed on the PROJECTED object, so summarizeSubmitResult DOES surface the
 *     duplicate note (disproves the "summary misses duplicate" hypothesis).
 *   - every OUTPUT_SCHEMAS entry's schema_version const/enum equals the SCHEMA_* projection constant.
 *
 * Usage: npx tsx scripts/test-mcp-card-contract.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-cardcontract-'))

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

async function main(): Promise<void> {
  const proj = await import('../src/agent-model-projection.js')
  const { OUTPUT_SCHEMAS } = await import('../src/layer1-agent/L1-1-mcp-server/tool-output-schemas.js')

  // ── Truncation contract (projectProductDetail) — BUG-01 fixed: no silent truncation, full-terms path ──
  const longDesc = '规格说明'.repeat(400)      // ~4800 bytes CJK
  const bigSpecs: Record<string, string> = {}
  for (let i = 0; i < 80; i++) bigSpecs['属性' + i] = '取值内容' + i
  const longReturn = '退货需在七天内完好退回。'.repeat(40)   // >400 bytes, frequent 。 sentence boundaries
  const longShip = '全国除偏远地区。港澳台另计。'.repeat(30)   // >400 bytes, sentence boundaries
  const rh = 'res_' + '0'.repeat(32)
  const d = proj.projectProductDetail({
    id: 'prd_x', title: 't', description: longDesc, specs: bigSpecs, return_condition: longReturn, ship_regions: longShip, has_variants: 1,
  }, { resultHandle: rh }) as Record<string, unknown>

  ok('T1. description byte-capped to <= DETAIL_DESC_MAX_BYTES (900)', bytes(String(d.description)) <= proj.DETAIL_DESC_MAX_BYTES)
  ok('T2. description_truncated flag set true when capped', d.description_truncated === true)
  ok('T3. oversized specs dropped wholesale (keys vanish) + specs_truncated=true', !('specs' in d) && d.specs_truncated === true)
  ok('T4. return_condition byte-capped to <= DETAIL_TERMS_MAX_BYTES (400)', bytes(String(d.return_condition)) <= proj.DETAIL_TERMS_MAX_BYTES)
  ok('T5. [BUG-01 fixed] return_condition truncation is now FLAGGED (return_condition_truncated=true)', d.return_condition_truncated === true)
  ok('T6. ship_regions truncation also flagged (ship_regions_truncated=true)', d.ship_regions_truncated === true)
  ok('T7. terms_complete=false when any critical field truncated', d.terms_complete === false)
  const ft = d.full_terms_fetch as Record<string, Record<string, unknown>> | undefined
  ok('T8. full-terms fetch reference present + full_terms:true + selected_ids + result_handle threaded',
    d.full_terms_available === true && !!ft && ft.args.full_terms === true && Array.isArray(ft.args.selected_ids) && (ft.args.selected_ids as string[])[0] === 'prd_x' && ft.args.result_handle === rh)
  ok('T9. no U+FFFD — multibyte char never broken by truncation', !/�/.test(String(d.description)) && !/�/.test(String(d.return_condition)) && !/�/.test(String(d.ship_regions)))
  ok('T10. return_condition truncated at a sentence/clause boundary (ends with 。/punct)', /[。！？;；,，.!?\n]$/.test(String(d.return_condition)))
  // full mode: untruncated, no flags, terms_complete=true, specs retained
  const dfull = proj.projectProductDetail({ id: 'prd_x', title: 't', description: longDesc, specs: bigSpecs, return_condition: longReturn, ship_regions: longShip }, { full: true }) as Record<string, unknown>
  ok('T11. full mode: untruncated return_condition + terms_complete=true + no *_truncated', dfull.terms_complete === true && String(dfull.return_condition) === longReturn && !('return_condition_truncated' in dfull) && !('specs_truncated' in dfull))
  ok('T12. full mode retains full specs (not dropped)', !!dfull.specs && typeof dfull.specs === 'object')
  // short/empty fields → terms_complete=true, no truncation flags, no fetch ref
  const dshort = proj.projectProductDetail({ id: 'prd_y', title: 't', description: '短', return_condition: '可退', ship_regions: 'SG' }) as Record<string, unknown>
  ok('T13. short fields → terms_complete=true, no truncation flags, no full_terms_fetch', dshort.terms_complete === true && !('return_condition_truncated' in dshort) && !('full_terms_fetch' in dshort))

  // ── §II full-terms safety: default search never carries full terms; full mode leaks no private fields ──
  const sm = proj.projectProductModel({ id: 'prd_x', title: 't', price: 9, stock: 5, description: 'X', specs: '{"a":1}', return_condition: 'R', ship_regions: 'SG', source_price: 3.14, seller_id: 'u1', internal_note: 'secret' }) as Record<string, unknown>
  ok('FT1. default search projection excludes description/specs/return_condition/ship_regions (full terms are on-demand only)',
    !('description' in sm) && !('specs' in sm) && !('return_condition' in sm) && !('ship_regions' in sm))
  ok('FT2. search projection never leaks seller-private raw fields (source_price/internal_note/seller_id)',
    !('source_price' in sm) && !('internal_note' in sm) && !('seller_id' in sm))
  const FULL_ALLOWED = new Set(['id', 'title', 'price', 'stock_status', 'category', 'handling_hours', 'estimated_days', 'return_days', 'warranty_days', 'seller_ref', 'sales_count', 'decision_flags', 'summary', 'description', 'specs', 'return_condition', 'ship_regions', 'has_variants', 'product_type', 'fragile', 'terms_complete'])
  const dfull2 = proj.projectProductDetail({ id: 'prd_z', title: 't', price: 9, stock: 5, description: 'D', specs: '{"a":1}', return_condition: 'R', ship_regions: 'SG', source_price: 3.14, seller_id: 'u1', internal_note: 'secret', api_key: 'k' }, { full: true }) as Record<string, unknown>
  const leak = Object.keys(dfull2).filter(k => !FULL_ALLOWED.has(k))
  ok('FT3. full-mode detail output = whitelisted fields ONLY (no source_price/seller_id/internal_note/api_key leak)', leak.length === 0)
  ok('FT4. full mode carries no *_truncated flags (nothing truncated to leak-hide)', !Object.keys(dfull2).some(k => /_truncated$/.test(k)))

  // ── Duplicate mapping + summary-carries-duplicate (projectSubmitConsumer / summarizeSubmitResult) ──
  const dupRaw = { request_id: 'apr_1', draft_id: 'odr_1', approval_url: '/#agent-approvals/apr_1', idempotency: { duplicate: true } }
  const dupProj = proj.projectSubmitConsumer(dupRaw) as Record<string, unknown>
  ok('D1. submit projection stamps schema_version = order_approval', dupProj.schema_version === proj.SCHEMA_ORDER_APPROVAL)
  ok('D2. idempotency.duplicate → top-level duplicate:true', dupProj.duplicate === true)
  ok('D3. duplicate_warning object present when duplicate', !!dupProj.duplicate_warning && typeof dupProj.duplicate_warning === 'object')
  // The envelope calls summarize on the PROJECTED object (server.ts:6330-6331), so the note IS surfaced.
  ok('D4. summarizeSubmitResult(projected) surfaces the REUSED note (disproves "summary misses duplicate")',
    /REUSED an existing pending request/.test(proj.summarizeSubmitResult(dupProj)))
  const cleanRaw = { request_id: 'apr_2', draft_id: 'odr_2', approval_url: '/#agent-approvals/apr_2', idempotency: { duplicate: false } }
  const cleanProj = proj.projectSubmitConsumer(cleanRaw) as Record<string, unknown>
  ok('D5. no duplicate key on a non-duplicate submit', !('duplicate' in cleanProj) && !('duplicate_warning' in cleanProj))
  ok('D6. clean summary omits the REUSED note', !/REUSED/.test(proj.summarizeSubmitResult(cleanProj)))

  // ── outputSchema ↔ projection schema_version alignment ───────────────────────────────────
  const svOf = (name: string): unknown => {
    const s = OUTPUT_SCHEMAS[name] as Record<string, unknown>
    const p = (s.properties as Record<string, Record<string, unknown>>).schema_version
    return p.const ?? p.enum
  }
  ok('S1. webaz_quote_order outputSchema schema_version === SCHEMA_ORDER_QUOTE', svOf('webaz_quote_order') === proj.SCHEMA_ORDER_QUOTE)
  ok('S2. webaz_order_draft outputSchema schema_version === SCHEMA_ORDER_DRAFT', svOf('webaz_order_draft') === proj.SCHEMA_ORDER_DRAFT)
  ok('S3. webaz_submit_order_request outputSchema schema_version === SCHEMA_ORDER_APPROVAL', svOf('webaz_submit_order_request') === proj.SCHEMA_ORDER_APPROVAL)
  const searchEnum = svOf('webaz_search') as string[]
  ok('S4. webaz_search outputSchema enum = [product_search, product_detail]',
    Array.isArray(searchEnum) && searchEnum.includes(proj.SCHEMA_PRODUCT_SEARCH) && searchEnum.includes(proj.SCHEMA_PRODUCT_DETAIL))
  const boEnum = svOf('webaz_buyer_orders') as string[]
  ok('S5. webaz_buyer_orders outputSchema enum = [order_status, order_timeline]',
    Array.isArray(boEnum) && boEnum.includes(proj.SCHEMA_ORDER_STATUS) && boEnum.includes(proj.SCHEMA_ORDER_TIMELINE))

  if (fail > 0) { console.error(`\n❌ mcp card contract FAILED  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ mcp card contract: truncation caps/flags · duplicate mapping+summary · outputSchema↔schema_version aligned\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
