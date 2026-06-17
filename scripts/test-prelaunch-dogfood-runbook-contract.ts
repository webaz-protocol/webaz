#!/usr/bin/env tsx
/**
 * PR8A — Private Contribution Dogfood Runbook boundary guard (design/docs-only; static check).
 *   用法:npm run test-prelaunch-dogfood-runbook-contract
 *
 * Locks the runbook's boundary as a test: it is a private / non-production / uncommitted flow experiment;
 * it teaches GitHub-first → Passkey claim, agent-as-executor + accountable human + DCO, sandbox/private
 * draft ≠ participation, register-early for permanent_code/invite link, no post-hoc tree rewrite; it names
 * the high-risk forbidden zones (wallet/escrow/KYC/secrets/prod-DB/deploy/migration); it is honest that
 * "recognized flow" ≠ "auto-recorded" (deferred). It prints no economic numeric literal and makes no
 * positive guaranteed-reward/payout claim (those may appear only in a no/not/never/forbidden context).
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
  doc = readFileSync(join(HERE, '..', 'docs', 'PRELAUNCH-CONTRIBUTION-DOGFOOD-RUNBOOK.md'), 'utf8')
} catch {
  // Internal dogfood doc, excluded from the public Genesis tree (present in the private archive).
  console.log('SKIP: docs/PRELAUNCH-CONTRIBUTION-DOGFOOD-RUNBOOK.md absent (excluded from public tree); contract n/a')
  process.exit(0)
}

function main(): void {
  // nature of the dogfood
  ok('private, pre-public, non-production experiment', /private[\s\S]{0,30}pre-public[\s\S]{0,30}non-production|non-production experiment/i.test(doc))
  ok('declares uncommitted', /uncommitted/i.test(doc))
  ok('validates the flow, not reward (no reward/right/payout/settlement/economic commitment)', /no reward.{0,80}(payout|settlement|economic commitment)|validates? the \*?flow/i.test(doc))

  // entry mechanics (inherited boundaries)
  ok('GitHub-first', /GitHub-first/i.test(doc))
  ok('Passkey claim', /Passkey/.test(doc) && /claim/i.test(doc))
  ok('agent = executor + accountable human + DCO', /agent[\s\S]{0,20}execut/i.test(doc) && /accountable/i.test(doc) && /DCO/.test(doc))
  ok('agent declares provenance in PR body', /agent[\s\S]{0,20}provenance/i.test(doc))
  ok('sandbox / private draft is NOT participation', /sandbox[\s\S]{0,60}not participation|private draft[\s\S]{0,40}not[\s\S]{0,20}participation|is not participation/i.test(doc))
  ok('register early → permanent_code / invite link', /permanent_code/.test(doc) && /invite\s+link/i.test(doc) && /register/i.test(doc))
  ok('no post-hoc tree rewrite + sponsor_id/placement_id/placement_side', /no post-hoc tree rewrite/i.test(doc) && /sponsor_id/.test(doc) && /placement_id/.test(doc) && /placement_side/.test(doc))

  // honesty: recognized flow != auto-recorded (deferred). Ingestion is an internal ENGINE with NO automatic
  // trigger surface — a merged PR is a CANDIDATE, not auto-recorded (Codex P1 — don't overclaim ingestion).
  ok('"recognized flow" ≠ "auto-recorded" / deferred', /recognized flow[\s\S]{0,30}(≠|not)[\s\S]{0,30}auto-recorded|deferred/i.test(doc) && /deferred/i.test(doc))
  ok('honesty: ingestion ENGINE implemented but NO automatic trigger (deferred)', /ingestion \*\*engine is implemented\*\*|ingestion engine[\s\S]{0,30}implemented/i.test(doc) && /no automatic trigger/i.test(doc))
  ok('honesty: merged PR is an eligible candidate, NOT auto-recorded', /eligible[\s\S]{0,30}candidate|candidate for ingestion/i.test(doc) && !/auto-records a contribution fact/i.test(doc) && !/auto-recorded today/i.test(doc) && !/implemented and auto-recorded/i.test(doc))
  ok('honesty: claimable only after a trusted ingestion job / operator run', /(claimable|fact)[\s\S]{0,80}(trusted ingestion (job|run)|ingestion job \/ operator run|operator run)/i.test(doc))

  // expected artifacts named
  ok('expected artifacts: PR/issue/task/RFC + DCO + verification command + review result + claim note', /verification command/i.test(doc) && /review result/i.test(doc) && /(future-claim|claim later|claim\/future-claim)/i.test(doc) && /DCO/.test(doc))

  // high-risk forbidden zones
  for (const [label, re] of [
    ['wallet/balance', /wallet/i], ['escrow', /escrow/i], ['KYC/admin', /KYC/],
    ['API key/secrets', /API key|secrets/i], ['production database', /production database/i],
    ['migration', /migration/i], ['deploy', /deploy/i],
  ] as Array<[string, RegExp]>) {
    ok(`§5 names high-risk zone: ${label}`, re.test(doc))
  }
  ok('§5 agent must NEVER directly touch funds / prod secrets / real user data / prod DB', /never[\s\S]{0,80}(real funds|production secrets|production database)/i.test(doc))

  // assurance checklist (checklist only, no dashboard/API)
  ok('§6 assurance checklist: CI green + review + known limitations + risk tier + human confirmation', /CI all green/i.test(doc) && /known limitations/i.test(doc) && /risk tier/i.test(doc) && /human confirmation/i.test(doc))
  ok('§6 checklist only — no dashboard / no API / no new route', /no dashboard, no API, no new route|checklist only/i.test(doc))

  // no hard-coded economic numeric literal
  ok('no percentage literal', !/\d+(\.\d+)?\s*%/.test(doc), (doc.match(/\d+(\.\d+)?\s*%/g) || []).join(','))
  ok('no currency-amount literal', !/[$￥€]\s*\d|\b\d+(\.\d+)?\s*(USD|USDT|CNY|RMB|元|dollars?)\b/i.test(doc))
  ok('no numeric reward multiplier (N× / ×N)', !/(\b\d+(\.\d+)?\s*[x×])|([x×]\s*\d)/i.test(doc))

  // no POSITIVE guaranteed-reward/payout phrasing — promise verb + economic noun must sit in a negation context
  const PROMISE = /\b(guaranteed|guarantees|automatic|entitle[ds]?|inherits?|earns?|will\s+(earn|receive|get))\b[\s\S]{0,25}?\b(reward|payout|income|settlement|dividend|return|commission|yield|right)\b/gi
  const NEG = /\b(no|not|never|without|cannot|can't|won't|forbidden|nor|neither|isn't|aren't|don't|doesn't|refuse[ds]?)\b/i
  const bad: string[] = []
  let m: RegExpExecArray | null
  while ((m = PROMISE.exec(doc)) !== null) {
    const ctx = doc.slice(Math.max(0, m.index - 48), m.index + m[0].length)
    if (!NEG.test(ctx)) bad.push(ctx.replace(/\s+/g, ' '))
  }
  ok('no positive guaranteed-reward/payout phrasing (only in no/not/forbidden context)', bad.length === 0, bad.join(' | '))

  // cross-references
  ok('cross-refs CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1 + PUBLIC-CONTRIBUTOR-ENTRY', /CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1/.test(doc) && /PUBLIC-CONTRIBUTOR-ENTRY/.test(doc))

  console.log('\ntest-prelaunch-dogfood-runbook-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ dogfood runbook: private/non-production/uncommitted + GitHub-first→Passkey + agent-executor/accountable+DCO + sandbox≠participation + register-early/invite-link + no post-hoc tree rewrite + high-risk forbidden zones + recognized-flow≠auto-recorded(deferred) + no economic numeric / no positive reward promise\n')
}

main()
