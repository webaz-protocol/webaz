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

  // ── Truncation contract (projectProductDetail) ───────────────────────────────────────────
  const longDesc = '规格说明'.repeat(400)      // ~4800 bytes CJK
  const bigSpecs: Record<string, string> = {}
  for (let i = 0; i < 80; i++) bigSpecs['属性' + i] = '取值内容' + i
  const longReturn = '退货条件说明'.repeat(80)   // >200 bytes, cut mid-sentence
  const d = proj.projectProductDetail({
    id: 'prd_x', title: 't', description: longDesc, specs: bigSpecs, return_condition: longReturn, ship_regions: 'SG',
  }) as Record<string, unknown>

  ok('T1. description byte-capped to <= DETAIL_DESC_MAX_BYTES (900)', bytes(String(d.description)) <= proj.DETAIL_DESC_MAX_BYTES)
  ok('T2. description_truncated flag set true when capped', d.description_truncated === true)
  ok('T3. oversized specs dropped wholesale (keys vanish) + specs_truncated=true', !('specs' in d) && d.specs_truncated === true)
  ok('T4. return_condition byte-capped to <= 200', bytes(String(d.return_condition)) <= 200)
  // FINDING lock: return_condition truncation is SILENT — there is deliberately NO return_condition_truncated flag.
  ok('T5. [finding] return_condition truncation is SILENT (no return_condition_truncated flag exists)', !('return_condition_truncated' in d))

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
