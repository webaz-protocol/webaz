#!/usr/bin/env tsx
/**
 * PR9A — Future Task Board v1 design contract guard (design/docs-only; static check).
 *   用法:npm run test-future-task-board-design-contract
 *
 * Locks the design contract: it cites #325 case pack / AGENT-READY-TASK-SPEC / RFC-006 / RFC-017; carries
 * the complete task field set + the discovery filters; inherits the RFC-006 state machine + atomic claim /
 * TTL / WIP / human acceptance; enforces high/critical ⇒ no auto-claim, critical ⇒ not public,
 * needs_clarification (no guess); states the MCP + PWA behavior; routes high-risk to higher audit; keeps
 * done ≠ merge and sandbox ≠ participation; and implements NOTHING (no DB/schema/API/MCP/PWA/UI) while
 * staying uncommitted with no reward/economic promise.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const doc = readFileSync(join(HERE, '..', 'docs', 'FUTURE-TASK-BOARD-V1-DESIGN.md'), 'utf8')

const FIELDS = ['task_id', 'title', 'summary', 'area', 'task_type', 'source_ref', 'rfc_ref', 'version',
  'allowed_paths', 'forbidden_paths', 'prohibited_actions', 'risk_level', 'audience', 'agent_autonomy',
  'auto_claimable', 'human_confirmation_points', 'required_capabilities', 'acceptance_criteria',
  'verification_commands', 'expected_results', 'deliverables', 'definition_of_done', 'estimated_duration',
  'estimated_context_size', 'estimated_agent_budget', 'dependencies', 'blocking_conditions', 'value_state',
  'contribution_type', 'accountable_party_required', 'status']
const FILTERS = ['status', 'area', 'risk_level', 'required_capabilities', 'estimated_duration',
  'estimated_context_size', 'estimated_agent_budget', 'auto_claimable', 'audience']

function main(): void {
  // authority citations
  ok('cites #325 case pack', /#325 case-pack/.test(doc))   // public concept, not the private EXCLUDE filename — survives the Genesis doc-link prune
  ok('cites AGENT-READY-TASK-SPEC', /AGENT-READY-TASK-SPEC/.test(doc))
  ok('cites RFC-006', /RFC-006/.test(doc))
  ok('cites RFC-017', /RFC-017/.test(doc))

  // §1 full field set carried
  for (const f of FIELDS) ok(`data contract names field: ${f}`, new RegExp(`\\b${f}\\b`).test(doc))

  // §2 discovery filters
  for (const f of FILTERS) ok(`discovery filter: ${f}`, new RegExp(`\\b${f}\\b`).test(doc))

  // §3 claim rules
  ok('RFC-006 state machine open→claimed→in_review→done|abandoned', /open\s*→\s*claimed\s*→\s*in_review\s*→\s*done\s*\|\s*abandoned/i.test(doc))
  ok('atomic claim on open only', /atomic claim/i.test(doc) && /on\s*`?open/i.test(doc))
  ok('claim TTL / auto-release', /TTL/.test(doc) && /auto-release/i.test(doc))
  ok('WIP limit', /WIP limit/i.test(doc))
  ok('human acceptance (done/abandoned by maintainer)', /human acceptance/i.test(doc) && /maintainer/i.test(doc))
  ok('high/critical ⇒ auto_claimable = false', /\{high,\s*critical\}/.test(doc) && /auto_claimable`?\s*=\s*false/i.test(doc))
  ok('critical ⇒ audience not public', /risk_level[\s\S]{0,4}=[\s\S]{0,4}critical/i.test(doc) && /never\s*`?public/i.test(doc))
  ok('needs_clarification, do not guess', /needs_clarification/.test(doc) && /must not guess|not guess|don't guess/i.test(doc))

  // §4 MCP behavior
  ok('list_open returns machine-readable fields', /list_open[\s\S]{0,60}machine-readable/i.test(doc))
  ok('claim refuses to auto-claim high/critical', /claim[\s\S]{0,80}refuse[\s\S]{0,40}auto-claim/i.test(doc))
  ok('submit carries PR/ref + verification-result summary', /submit[\s\S]{0,80}PR \/ ref[\s\S]{0,40}verification-result summary|submit[\s\S]{0,80}verification/i.test(doc))
  ok('sandbox mode keeps refusing participation', /sandbox[\s\S]{0,40}refuse[\s\S]{0,30}participation|sandbox run is \*\*not\*\*/i.test(doc))

  // §5 PWA behavior
  ok('PWA: copy task to own agent', /copy a task to their own agent|copy[\s\S]{0,30}agent/i.test(doc))
  ok('PWA: no reward promise, only value boundary', /no reward promise/i.test(doc) && /value_boundary|value boundary/i.test(doc) && /uncommitted/i.test(doc))

  // §6 safety / audit
  ok('high-risk routed to higher-audit RFC/PR', /high-risk[\s\S]{0,80}higher-audit RFC\/PR/i.test(doc))
  ok('never touch real funds / prod secrets / real user data / prod DB / deploy / migration', /never[\s\S]{0,120}(real funds|production secrets|production\s*\n?\s*database)/i.test(doc) && /deploy/i.test(doc) && /migration/i.test(doc))
  ok('done ≠ merge', /`?done`?\s*(≠|!=|is not)\s*`?merge`?/i.test(doc))
  ok('merge is always a Holden/maintainer decision', /merging is always a[\s\S]{0,30}(Holden|maintainer)|merge[\s\S]{0,40}(Holden|maintainer) decision/i.test(doc))
  ok('done never triggers an automatic reward', /done never triggers an automatic reward|never triggers an automatic reward/i.test(doc))

  // §7 implementation split (this PR builds none of it)
  for (const pr of ['PR9B', 'PR9C', 'PR9D', 'PR9E']) ok(`names implementation PR: ${pr}`, new RegExp(pr).test(doc))

  // §8 not-do
  ok('no DB/schema/API/MCP/PWA/UI implementation in this PR', /No DB \/ schema \/ API \/ MCP \/ PWA \/ UI implementation in this PR/i.test(doc))
  ok('sandbox / private draft is not participation (by design)', /sandbox \/ private draft is not\s*\n?\s*participation|is not\s*\n?\s*participation/i.test(doc))
  ok('declares uncommitted', /uncommitted/i.test(doc))

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

  console.log('\ntest-future-task-board-design-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ future task board v1 design contract: full field set + filters + RFC-006 state machine + high/critical no-auto-claim + critical not public + needs_clarification + MCP/PWA behavior + high-risk→higher-audit + done≠merge + sandbox≠participation + no implementation / no reward promise\n')
}

main()
