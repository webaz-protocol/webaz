#!/usr/bin/env tsx
/**
 * PR8B — Private Dogfood Case Pack boundary guard (design/docs-only; static check).
 *   用法:npm run test-prelaunch-dogfood-case-pack-contract
 *
 * Parses the sample agent-ready task blocks and locks: every task carries the required fields; every task
 * is value_state: uncommitted; a high/critical task is never auto_claimable and is human_in_the_loop/
 * human_only with a human-confirmation point (mirrors AGENT-READY-TASK-SPEC.md §3); the pack shows both an
 * auto-claimable and a human-in-the-loop task; it states the needs_clarification "don't guess" rule and
 * names the high-risk forbidden zones; and it prints no economic numeric literal / no positive
 * guaranteed-reward phrasing.
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
  doc = readFileSync(join(HERE, '..', 'docs', 'PRELAUNCH-DOGFOOD-CASE-PACK.md'), 'utf8')
} catch {
  // Internal dogfood doc, excluded from the public Genesis tree (present in the private archive).
  console.log('SKIP: docs/PRELAUNCH-DOGFOOD-CASE-PACK.md absent (excluded from public tree); contract n/a')
  process.exit(0)
}

// Full future task-board acceptance field set (Codex P1 — case pack must be a complete contract).
const REQUIRED = ['title', 'summary', 'area', 'task_type', 'allowed_paths', 'forbidden_paths',
  'prohibited_actions', 'risk_level', 'audience', 'agent_autonomy', 'auto_claimable',
  'human_confirmation_points', 'required_capabilities', 'acceptance_criteria', 'verification_commands',
  'expected_results', 'deliverables', 'definition_of_done', 'estimated_duration', 'estimated_context_size',
  'estimated_agent_budget', 'dependencies', 'blocking_conditions', 'value_state', 'contribution_type',
  'accountable_party_required']
// Canonical enums (AGENT-READY-TASK-SPEC.md): keep the sample values in spec form so a future task-board
// implementation copies a CORRECT shape (Codex follow-up).
const TASK_TYPES = new Set(['docs', 'i18n', 'tests', 'code', 'governance', 'audit', 'other'])
const BUDGETS = new Set(['minimal', 'small', 'moderate', 'large', 'xlarge'])   // relative tier only
const CONTEXTS = new Set(['small', 'medium', 'large'])
// Core fields that must carry a NON-EMPTY value (the spec's †-non-empty boundary/acceptance fields + the
// scalar gates). forbidden_paths / human_confirmation_points / estimated_agent_budget / dependencies /
// blocking_conditions may legitimately be 'none', so only their presence is required.
const CORE_NONEMPTY = ['title', 'summary', 'area', 'task_type', 'allowed_paths', 'prohibited_actions',
  'risk_level', 'audience', 'agent_autonomy', 'auto_claimable', 'required_capabilities', 'acceptance_criteria',
  'verification_commands', 'expected_results', 'deliverables', 'definition_of_done', 'estimated_duration',
  'estimated_context_size', 'estimated_agent_budget', 'value_state', 'contribution_type', 'accountable_party_required']
const HIGH_AUTONOMY = new Set(['human_in_the_loop', 'human_only'])

function field(block: string, key: string): string | null {
  const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

function main(): void {
  // extract fenced task blocks (those that carry risk_level:)
  const blocks = [...doc.matchAll(/```(?:yaml)?\n([\s\S]*?)```/g)].map(m => m[1]).filter(b => /^risk_level:/m.test(b))
  ok('at least 5 sample tasks', blocks.length >= 5, `found ${blocks.length}`)

  let sawAutoTrue = false, sawAutoFalse = false, sawHighRisk = false
  blocks.forEach((b, i) => {
    const title = field(b, 'title') || `#${i + 1}`
    const tag = title.slice(0, 30)
    for (const k of REQUIRED) ok(`task "${tag}" has ${k}`, new RegExp(`^${k}:`, 'm').test(b))
    for (const k of CORE_NONEMPTY) { const v = field(b, k); ok(`task "${tag}" ${k} is non-empty`, !!v && v.length > 0, `${k}="${v ?? ''}"`) }
    ok(`task "${tag}" value_state = uncommitted`, /^value_state:\s*uncommitted\s*$/m.test(b))

    // canonical-form enums (so a future task board copies a correct sample shape)
    ok(`task "${tag}" task_type ∈ {docs,i18n,tests,code,governance,audit,other}`, TASK_TYPES.has((field(b, 'task_type') || '').toLowerCase()), `task_type=${field(b, 'task_type')}`)
    ok(`task "${tag}" estimated_agent_budget ∈ {minimal,small,moderate,large,xlarge}`, BUDGETS.has((field(b, 'estimated_agent_budget') || '').toLowerCase()), `budget=${field(b, 'estimated_agent_budget')}`)
    ok(`task "${tag}" estimated_context_size ∈ {small,medium,large}`, CONTEXTS.has((field(b, 'estimated_context_size') || '').toLowerCase()), `context=${field(b, 'estimated_context_size')}`)
    const dur = field(b, 'estimated_duration') || ''
    ok(`task "${tag}" estimated_duration has min_minutes + max_minutes`, /\bmin_minutes\b/.test(dur) && /\bmax_minutes\b/.test(dur), `estimated_duration=${dur}`)

    const risk = (field(b, 'risk_level') || '').toLowerCase()
    const auto = (field(b, 'auto_claimable') || '').toLowerCase()
    const autonomy = (field(b, 'agent_autonomy') || '').toLowerCase()
    const audience = (field(b, 'audience') || '').toLowerCase()
    const hcp = field(b, 'human_confirmation_points') || ''
    if (auto === 'true') sawAutoTrue = true
    if (auto === 'false') sawAutoFalse = true

    if (risk === 'high' || risk === 'critical') {
      sawHighRisk = true
      ok(`high/critical task "${tag}" → auto_claimable: false`, auto === 'false', `auto=${auto}`)
      ok(`high/critical task "${tag}" → agent_autonomy human_in_the_loop/human_only`, HIGH_AUTONOMY.has(autonomy), `autonomy=${autonomy}`)
      ok(`high/critical task "${tag}" → has a human_confirmation_point`, hcp.length > 0 && !/^none$/i.test(hcp))
    }
    if (risk === 'critical') {
      ok(`critical task "${tag}" → audience not public`, audience !== 'public', `audience=${audience}`)
    }
  })
  ok('shows an auto-claimable (low-risk) task', sawAutoTrue)
  ok('shows a human-in-the-loop (auto_claimable: false) task', sawAutoFalse)
  ok('includes a high-risk refusal task', sawHighRisk)

  // doc-level rules
  ok('rule: auto-claim vs human-in-the-loop', /Auto-claim vs human-in-the-loop/i.test(doc))
  ok('rule: needs_clarification, do not guess', /needs_clarification/.test(doc) && /do not guess|don't guess|not guess/i.test(doc))
  ok('references the dogfood runbook', /PRELAUNCH-CONTRIBUTION-DOGFOOD-RUNBOOK/.test(doc))
  ok('follows AGENT-READY-TASK-SPEC field set', /AGENT-READY-TASK-SPEC/.test(doc))
  ok('declares uncommitted', /uncommitted/i.test(doc))
  ok('sandbox / private draft is not participation (by design)', /local sandbox or private draft is not participation|by design/i.test(doc))

  // high-risk forbidden zones named
  for (const [label, re] of [
    ['wallet', /wallet/i], ['escrow', /escrow/i], ['KYC/admin', /KYC/], ['API key/secrets', /API key|secrets/i],
    ['production database', /production database/i], ['migration', /migration/i], ['deploy', /deploy/i],
  ] as Array<[string, RegExp]>) {
    ok(`high-risk zone named: ${label}`, re.test(doc))
  }

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

  console.log('\ntest-prelaunch-dogfood-case-pack-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ dogfood case pack: ≥5 sample tasks with full field set + value_state uncommitted + high-risk⇒no-auto-claim/human-in-loop + auto-claim/human-in-loop distinction + needs_clarification(no-guess) + high-risk zones + no economic numeric / no reward promise\n')
}

main()
