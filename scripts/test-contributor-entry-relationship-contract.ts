#!/usr/bin/env tsx
/**
 * PR6A — Contributor Entry & Relationship Graph v1 boundary guard (design-only PR; static doc check).
 *   用法:npm run test:contributor-entry-relationship-contract
 *
 * Locks the boundary as a test, not just prose: the design doc declares design-only / no reward formula /
 * no payout / no economic rights / uncommitted; carries the 13 locked invariants; cites the authoritative
 * sources; contains NO hard-coded economic numeric (percentage / currency amount / numeric reward
 * multiplier); names the anti-abuse vectors; and declares no DB/API/schema/route change.
 *
 * NOTE (PR5 lesson): we do NOT word-scan the prose for reward/payout/etc — the doc must NAME them to
 * forbid them. We assert REQUIRED phrases + the absence of hard economic NUMERIC literals + structure.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const doc = readFileSync(join(HERE, '..', 'docs', 'CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1.md'), 'utf8')

function main(): void {
  // required boundary phrases (positive assertions the doc must contain)
  ok('declares design-only', /design-only/i.test(doc))
  ok('declares no reward formula', /no reward formula/i.test(doc))
  ok('declares no payout', /no .{0,40}payout/i.test(doc))
  ok('declares no economic right(s)', /no .{0,40}economic right|not an economic right/i.test(doc))
  ok('declares uncommitted', /uncommitted/i.test(doc))
  ok('inherits the PR5A value_boundary', /value_boundary/.test(doc) && /uncommitted-value boundary/i.test(doc))
  ok('forbids inheritance-of-income', /No inheritance-of-income|never granted by relationship position alone|automatically earns/i.test(doc))

  // authority citations
  ok('cites RFC-017 I-9 (recorded + may-be-modifier, deferred)', /I-9/.test(doc))
  ok('cites RFC-017 I-12 (uncommitted boundary)', /I-12/.test(doc))
  ok('cites framework §3.1/§3.2 (position = modifier, not income source)', /§3\.1|§3\.2/.test(doc))
  ok('cites CHARTER §6 governance gate', /CHARTER §6/.test(doc))

  // invariants present (§3)
  const s3 = doc.slice(doc.indexOf('## §3'), doc.indexOf('## §4'))
  const nInv = (s3.match(/^\d+\.\s+\*\*/gm) || []).length
  ok('§3 has exactly 13 locked invariants', nInv === 13, `found ${nInv}`)

  // §8 pending / unclaimed GitHub-first invitation attribution boundary
  ok('§8 uses github:<stable_actor_id> subjects (not login)', /github:<stable_actor_id>/.test(doc) && /never.{0,30}(renameable )?GitHub login/i.test(doc))
  ok('§8 requires verifiable evidence (signed token / publication / proof)', /signed\s+invite\s+token/i.test(doc) && /gist proof|publication \(PR/i.test(doc))
  ok('§8 resolves via identity-binding overlay after claim', /resolves? to .{0,40}WebAZ account.{0,40}overlay|binding overlay at\s*\n?\s*\*\*read time\*\*|binding overlay/i.test(doc))
  ok('§8 unclaimed → no sponsor payout / binary settlement / wallet / KYC / reward eligibility', /no.{0,20}sponsor\s*\n?\s*payout/i.test(doc) && /no.{0,20}binary settlement/i.test(doc) && /no.{0,20}reward eligibility/i.test(doc))
  ok('§8 trees separate — no auto-rewrite of placement_id / sponsor_id', /MUST NOT auto-rewrite/i.test(doc) && /users\.placement_id/.test(doc) && /users\.sponsor_id/.test(doc))
  ok('§8 placement/reward effect needs a separate high-audit RFC/PR', /separate, higher-\s*\n?\s*audit RFC\/PR|higher-audit RFC\/PR/i.test(doc))

  // NO hard-coded economic numeric literal (the "no percentage / amount / multiplier" rule).
  // Section/RFC/version numbers (e.g. §3.2, RFC-017, I-12, v1, 4b, 60-day) are NOT economic literals.
  ok('no percentage literal', !/\d+(\.\d+)?\s*%/.test(doc), (doc.match(/\d+(\.\d+)?\s*%/g) || []).join(','))
  ok('no currency-amount literal', !/[$￥€]\s*\d|\b\d+(\.\d+)?\s*(USD|USDT|CNY|RMB|元|dollars?)\b/i.test(doc))
  ok('no numeric reward multiplier (N× / ×N)', !/(\b\d+(\.\d+)?\s*[x×])|([x×]\s*\d)/i.test(doc))

  // anti-abuse vectors named (§7)
  ok('§7 names self-referral', /self-referral/i.test(doc))
  ok('§7 names cyclic / reciprocal relationships', /cyclic|reciprocal/i.test(doc))
  ok('§7 names multi-account position farming', /position farming/i.test(doc))
  ok('§7 names position buying/selling', /buying\/selling|position buying/i.test(doc))
  ok('§7 names impersonation claims', /impersonation/i.test(doc))

  // §9 No post-hoc tree rewrite (registration-time placement is final)
  ok('§9 placement fixed only at WebAZ registration (users.id + permanent_code + Passkey)', /only at \*\*WebAZ account registration\*\*|only at WebAZ account registration/i.test(doc) && /permanent_code/.test(doc) && /Passkey/.test(doc))
  ok('§9 must-not: no retroactive sponsor_id/placement_id/placement_side rewrite', /retroactively modify/i.test(doc) && /placement_side/.test(doc))
  ok('§9 must-not: no reparent later account under earlier GitHub contributor', /reparent/i.test(doc))
  ok('§9 must-not: no second reward/settlement accounting tree', /second reward \/ settlement|settlement accounting tree/i.test(doc))
  ok('§9 guidance: register early + own permanent_code / invite link', /register a WebAZ account/i.test(doc) && /invite\s+link/i.test(doc))

  // §10: declares no DB/API/schema/route/economic change in this PR
  ok('§10 declares no DB table / schema / write path', /no DB table.{0,40}(schema|write path)|no DB table \/ schema \/ write path/i.test(doc))
  ok('§10 declares no API / MCP / PWA route', /no API \/ MCP \/ PWA route|no API \/ MCP/i.test(doc))
  ok('§10 declares no wallet/escrow/commission/KYC/deploy', /no wallet[\s\S]{0,20}escrow[\s\S]{0,20}commission[\s\S]{0,20}KYC[\s\S]{0,40}deploy/i.test(doc))

  console.log('\ntest:contributor-entry-relationship-contract')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ entry/relationship v1 boundary: design-only + no reward formula/payout/economic right + uncommitted + 13 invariants + authority cites + no economic numeric literal + abuse vectors named + no DB/API/schema change\n')
}

main()
