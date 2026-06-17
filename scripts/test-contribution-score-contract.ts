#!/usr/bin/env tsx
/**
 * PR5 — Contribution Score v1 CONTRACT static guard (design/boundary PR; no engine to test).
 *   用法:npm run test:contribution-score-contract
 *
 * Proves the score boundary as CODE, not just prose: no economic-promise term ever enters a score's
 * user-facing field names or evidence component keys; the hard boundary flags say it decides no
 * money/rights/redemption/KYC/wallet/tree and defines no reward formula; every displayed score is tied to
 * the PR5A value_boundary; the 8 invariants are present; inputs are existing read-only models (no new
 * table / write path); and the contract module computes/reads/writes nothing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CONTRIBUTION_SCORE_V1 } from '../src/layer2-business/L2-9-contribution/contribution-score-contract.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
// economic-PROMISE terms forbidden in a score's FIELD NAMES / component keys (RFC-017 I-12 / §7).
const FORBIDDEN = /amount|currency|yield|payout|reward|\bprice\b|promise|\bclaim\b/i

function main(): void {
  const c = CONTRIBUTION_SCORE_V1

  // 1) no economic-promise term in user-facing field names or component keys
  ok('no economic-promise term in display_fields', !c.display_fields.some(f => FORBIDDEN.test(f)), JSON.stringify(c.display_fields.filter(f => FORBIDDEN.test(f))))
  ok('no economic-promise term in component_keys', !c.component_keys.some(k => FORBIDDEN.test(k)), JSON.stringify(c.component_keys.filter(k => FORBIDDEN.test(k))))
  ok('headline field is contribution_score (not reward_score)', c.display_fields.includes('contribution_score') && !c.display_fields.some(f => /reward/i.test(f)))

  // 2) hard boundary flags
  ok('score_version = v1', c.score_version === 'v1')
  ok('display_requires_value_boundary = true', c.display_requires_value_boundary === true)
  ok('decides_money_or_rights = false', c.decides_money_or_rights === false)
  ok('is_redeemable = false', c.is_redeemable === false)
  ok('defines_reward_formula = false', c.defines_reward_formula === false)
  ok('requires_or_unlocks_kyc = false', c.requires_or_unlocks_kyc === false)
  ok('affects_wallet_escrow_commission = false', c.affects_wallet_escrow_commission === false)
  ok('affects_binary_tree_position = false', c.affects_binary_tree_position === false)
  ok('gates_verifier_or_arbitrator = false', c.gates_verifier_or_arbitrator === false)
  ok('revisable_by_governance = true', c.revisable_by_governance === true)

  // 3) the 8 invariants present + display carries value_boundary
  ok('exactly 8 invariants', c.invariants.length === 8, JSON.stringify(c.invariants))
  ok('invariant: uncommitted only', c.invariants.some(i => /uncommitted only/i.test(i)))
  ok('invariant: every displayed score carries value_boundary', c.invariants.some(i => /value_boundary/i.test(i)))
  ok('display_fields includes value_boundary', c.display_fields.includes('value_boundary'))

  // 4) inputs are EXISTING read-only models; no new table / write path / funds source
  ok('inputs reference existing models only (no wallet/escrow/commission/new table)',
    !c.input_sources.some(s => /wallet|escrow|commission|new table|create table/i.test(s)), JSON.stringify(c.input_sources))
  ok('inputs include the RFC-017 fact layer', c.input_sources.some(s => /contribution_facts/.test(s)))

  // 5) the contract module itself computes/reads/writes nothing (design-only)
  const src = readFileSync(join(HERE, '..', 'src', 'layer2-business', 'L2-9-contribution', 'contribution-score-contract.ts'), 'utf8')
  ok('contract module: no DB read/write', !/\b(dbAll|dbOne|dbRun|db\.prepare|INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(src))
  ok('contract module: no reward/kyc/wallet/economic/valuation import', !/\bfrom\s+['"][^'"]*(wallet|reward|kyc|economic|payout|valuation|escrow)[^'"]*['"]/i.test(src))
  ok('contract module: ties score display to the PR5A value boundary', /UncommittedValueBoundary/.test(src) && /value_boundary/.test(src))
  ok('contract module: exports no scoring function (no compute)', !/export\s+(async\s+)?function/.test(src))

  // 6) the design doc exists and locks the boundary
  const doc = readFileSync(join(HERE, '..', 'docs', 'CONTRIBUTION-SCORE-V1-DESIGN.md'), 'utf8')
  ok('doc: lists 8 invariants section', /## §2 Invariants/.test(doc))
  ok('doc: states uncommitted boundary', /uncommitted/i.test(doc))
  ok('doc: references RFC-017 I-12', /RFC-017 I-12/.test(doc))
  ok('doc: requires value_boundary on every display', /value_boundary/.test(doc) && /every displayed score/i.test(doc))
  ok('doc: declares no scoring formula in this PR', /no scoring formula|defines\s+\*\*no scoring formula|no reward formula/i.test(doc))

  console.log('\ntest:contribution-score-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ Score v1 CONTRACT: no economic-promise field/key + boundary flags (no money/rights/redemption/KYC/wallet/tree) + 8 invariants + display tied to value_boundary + read-only existing inputs + design-only (no engine)\n')
}

main()
