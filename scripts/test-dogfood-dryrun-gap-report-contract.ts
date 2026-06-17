#!/usr/bin/env tsx
/**
 * PR8C — Private Dogfood Dry-run Gap Report guard (design/docs-only; static check).
 *   用法:npm run test-dogfood-dryrun-gap-report-contract
 *
 * Locks the gap report's conclusions so PR9C-1/9C-2 build to them: it cites #325 case pack / #326 design
 * contract / the PR9B satellite; names the minimal LIST + DETAIL fields and the PR9C-1 required filters;
 * defers write (create/claim/submit) to PR9C-2; restates sandbox≠participation, value_state uncommitted,
 * needs_clarification (no guess), done≠merge; and contains no economic numeric / no reward promise.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
let doc: string
try {
  doc = readFileSync(join(HERE, '..', 'docs', 'PRELAUNCH-DOGFOOD-DRYRUN-GAP-REPORT.md'), 'utf8')
} catch {
  // Internal dogfood doc, excluded from the public Genesis tree (present in the private archive).
  console.log('SKIP: docs/PRELAUNCH-DOGFOOD-DRYRUN-GAP-REPORT.md absent (excluded from public tree); contract n/a')
  process.exit(0)
}
const has = (f: string): boolean => new RegExp(`\\b${f}\\b`).test(doc)

// §3 list (discovery/triage) fields
const LIST_FIELDS = ['task_id', 'title', 'area', 'task_type', 'status', 'risk_level', 'audience',
  'agent_autonomy', 'auto_claimable', 'required_capabilities', 'estimated_duration', 'estimated_context_size',
  'estimated_agent_budget', 'dependencies', 'blocking_conditions', 'value_state']
// §4 detail-extra (execution + acceptance) fields
const DETAIL_FIELDS = ['source_ref', 'version', 'allowed_paths', 'forbidden_paths', 'prohibited_actions',
  'human_confirmation_points', 'acceptance_criteria', 'verification_commands', 'expected_results',
  'deliverables', 'definition_of_done', 'contribution_type', 'accountable_party_required']
const REQUIRED_FILTERS = ['status', 'area', 'risk_level', 'audience', 'auto_claimable']

function main(): void {
  // authority citations
  ok('cites #325 case pack', /PRELAUNCH-DOGFOOD-CASE-PACK/.test(doc))
  ok('cites #326 design contract', /FUTURE-TASK-BOARD-V1-DESIGN/.test(doc))
  ok('cites PR9B satellite (build_task_agent_metadata)', /build_task_agent_metadata/.test(doc) && /PR9B/.test(doc))

  // §3 list fields
  for (const f of LIST_FIELDS) ok(`LIST field named: ${f}`, has(f))
  ok('§3 LIST view section present', /LIST view MUST return/i.test(doc))
  // §4 detail fields
  for (const f of DETAIL_FIELDS) ok(`DETAIL field named: ${f}`, has(f))
  ok('§4 DETAIL view section present', /DETAIL view MUST return/i.test(doc))

  // §5 PR9C-1 required filters
  ok('§5 PR9C-1 required filters section', /Filters PR9C-1 MUST support/i.test(doc) && /Required/i.test(doc))
  for (const f of REQUIRED_FILTERS) ok(`required filter named: ${f}`, has(f))
  ok('filter: status=open required', /status=open/i.test(doc))

  // §6 writes deferred to PR9C-2
  ok('§6 defers write to PR9C-2', /Deferred to PR9C-2/i.test(doc) && /PR9C-1 is \*\*read\/filter only\*\*|read\/filter only/i.test(doc))
  ok('§6 names deferred writes: create / claim / submit', /claim/.test(doc) && /submit/.test(doc) && /creating a task|create/i.test(doc))

  // §7 findings
  ok('finding: list vs detail split required', /List vs detail split is required|list vs detail/i.test(doc))
  ok('finding: satellite JOINed to build_tasks core', /JOINed to[\s\S]{0,20}build_tasks|join.{0,20}by\s*`?task_id/i.test(doc))
  ok('finding: every response carries the uncommitted value_boundary', /value_boundary/.test(doc) && /uncommitted/i.test(doc))
  ok('finding: needs_clarification triggers on the read side', /needs_clarification[\s\S]{0,40}(trigger|ambiguous|missing)/i.test(doc))

  // §8 invariants
  ok('sandbox / private draft is not participation', /sandbox \/ private draft is not participation|is not participation/i.test(doc))
  ok('value_state uncommitted, no economic promise', /value_state[\s\S]{0,12}uncommitted/i.test(doc) && /no.{0,20}(reward|economic promise)/i.test(doc))
  ok('needs_clarification, not guess', /needs_clarification/.test(doc) && /does\s*\*?\*?not\*?\*?\s*guess|not guess|don't guess/i.test(doc))
  ok('done ≠ merge', /`?done`?\s*(≠|!=|is not)\s*`?merge`?/i.test(doc))

  // §9 not-do
  ok('no DB/schema/API/MCP/PWA/UI change in this PR', /No DB \/ schema \/ API \/ MCP \/ PWA \/ UI change/i.test(doc))
  ok('no task created/claimed/submitted', /no task created\/claimed\/submitted|nothing claimed/i.test(doc))

  // no hard-coded economic numeric literal
  ok('no percentage literal', !/\d+(\.\d+)?\s*%/.test(doc), (doc.match(/\d+(\.\d+)?\s*%/g) || []).join(','))
  ok('no currency-amount literal', !/[$￥€]\s*\d|\b\d+(\.\d+)?\s*(USD|USDT|CNY|RMB|元|dollars?)\b/i.test(doc))
  ok('no numeric reward multiplier (N× / ×N)', !/(\b\d+(\.\d+)?\s*[x×])|([x×]\s*\d)/i.test(doc))

  // no POSITIVE guaranteed-reward phrasing (promise verb + economic noun must sit in a negation context)
  const PROMISE = /\b(guaranteed|guarantees|entitle[ds]?|inherits?|earns?|will\s+(earn|receive|get))\b[\s\S]{0,25}?\b(reward|payout|income|settlement|dividend|return|commission|yield)\b/gi
  const NEG = /\b(no|not|never|without|cannot|can't|won't|forbidden|nor|neither|isn't|aren't|don't|doesn't|refuse[ds]?)\b/i
  const bad: string[] = []
  let m: RegExpExecArray | null
  while ((m = PROMISE.exec(doc)) !== null) {
    const ctx = doc.slice(Math.max(0, m.index - 48), m.index + m[0].length)
    if (!NEG.test(ctx)) bad.push(ctx.replace(/\s+/g, ' '))
  }
  ok('no positive guaranteed-reward/payout phrasing (only in no/not/forbidden context)', bad.length === 0, bad.join(' | '))

  console.log('\ntest-dogfood-dryrun-gap-report-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ dogfood dry-run gap report: LIST + DETAIL fields + PR9C-1 required filters + PR9C-2 deferred writes + list/detail split + satellite JOIN + value_boundary + needs_clarification + sandbox≠participation + done≠merge + no economic numeric/reward promise\n')
}

main()
