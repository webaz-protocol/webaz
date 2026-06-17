#!/usr/bin/env tsx
/**
 * PR7A — Public Contributor Entry + Agent Quickstart boundary guard (design/docs-only; static check).
 *   用法:npm run test-public-contributor-entry-contract
 *
 * Locks the onboarding doc's boundary as a test: it teaches GitHub-first → Passkey claim, register-early
 * for permanent_code / invite link, agent-as-executor + DCO accountability, and sandbox/local-only ≠
 * participation — while NEVER promising a reward (no reward formula / no payout / uncommitted / no post-hoc
 * tree rewrite) and never printing a hard-coded economic numeric.
 *
 * NOTE (PR5/6A lesson): we assert REQUIRED phrases + absence of economic NUMERIC literals + structure — we
 * do NOT word-scan prose for "reward"/"payout" (the doc must NAME them to forbid them).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const doc = readFileSync(join(HERE, '..', 'docs', 'PUBLIC-CONTRIBUTOR-ENTRY.md'), 'utf8')

function main(): void {
  // entry mechanics
  ok('teaches GitHub-first', /GitHub-first/i.test(doc))
  ok('teaches Passkey claim', /Passkey/.test(doc) && /claim/i.test(doc))
  ok('"Contribute first, bind later"', /Contribute first, bind later/i.test(doc))
  ok('register early → permanent_code / invite link', /permanent_code/.test(doc) && /invite\s+link/i.test(doc) && /register\s+early/i.test(doc))

  // uncommitted boundary
  ok('declares uncommitted', /uncommitted/i.test(doc))
  ok('declares no reward formula', /no reward formula/i.test(doc))
  ok('declares no payout', /no .{0,30}payout/i.test(doc))
  ok('metering / display is not a reward promise', /not[\s\S]{0,30}a reward promise|metering \/ display is \*\*not\*\*/i.test(doc))

  // no post-hoc tree rewrite + pre-registration referral = evidence not position
  ok('declares No post-hoc tree rewrite', /No post-hoc tree rewrite/i.test(doc))
  ok('pre-registration referral = evidence, not a formal binary-tree position', /not[\s\S]{0,20}a formal binary-tree position/i.test(doc) && /promises no future\s*\n?\s*income/i.test(doc))
  ok('never rewrites sponsor_id/placement_id/placement_side', /sponsor_id/.test(doc) && /placement_id/.test(doc) && /placement_side/.test(doc) && /retroactively rewrite|never[\s\S]{0,20}retroactively/i.test(doc))

  // agent accountability + DCO
  ok('agent = executor; accountable party = real human/org', /agent is only an executor|agent[\s\S]{0,20}executor/i.test(doc) && /accountable party/i.test(doc))
  ok('requires DCO sign-off', /DCO sign-off/i.test(doc) && /git commit -s/.test(doc))

  // sandbox / local-only is not formal participation
  ok('sandbox / local-only is NOT participation', /sandbox[\s\S]{0,60}not participation|local sandbox[\s\S]{0,60}is not participation/i.test(doc))
  ok('only recognized-flow PR/issue/task/RFC enters the record', /recognized flow[\s\S]{0,80}(PR \/ issue \/ task \/ RFC|contribution record)/i.test(doc))

  // big-company employees guidance
  ok('guidance: own time + employer IP policy + no former-employer code', /own[\s\S]{0,6}time/i.test(doc) && /IP policy/i.test(doc) && /former employer/i.test(doc))

  // no hard-coded economic numeric literal (percentage / currency amount / multiplier)
  ok('no percentage literal', !/\d+(\.\d+)?\s*%/.test(doc), (doc.match(/\d+(\.\d+)?\s*%/g) || []).join(','))
  ok('no currency-amount literal', !/[$￥€]\s*\d|\b\d+(\.\d+)?\s*(USD|USDT|CNY|RMB|元|dollars?)\b/i.test(doc))
  ok('no numeric reward multiplier (N× / ×N)', !/(\b\d+(\.\d+)?\s*[x×])|([x×]\s*\d)/i.test(doc))

  // cross-references to the authoritative boundary docs
  ok('cross-refs CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1', /CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1/.test(doc))
  ok('cross-refs RFC-017', /RFC-017/.test(doc))

  console.log('\ntest-public-contributor-entry-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ public entry + agent quickstart: GitHub-first→Passkey claim + register-early/invite-link + agent-as-executor+DCO + sandbox≠participation + uncommitted/no reward formula/no payout/no post-hoc tree rewrite + no economic numeric literal\n')
}

main()
