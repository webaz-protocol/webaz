#!/usr/bin/env tsx
/**
 * Agent/API Security Gateway — Task S1d test: principal classification (threat-model §3.1/§3.2/§6).
 *
 * Pure truth-table over classifyGatewayPrincipal: an unverified registry client is ALWAYS anonymous_agent
 * (§3.2 — no self-reported basis elevates it); only a 'verified' client + active user grant + sender-
 * constrained token reaches verified_partner_agent. Plus a source guard that proof.ts no longer hardcodes
 * the single-literal tier.
 *
 * Usage: npm run test:agent-gateway-principal
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { classifyGatewayPrincipal } = await import('../src/runtime/agent-gateway-principal.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const cls = classifyGatewayPrincipal

try {
  // 1. verified ladder
  ok('1a verified + grant + sender-constrained → verified_partner_agent',
    cls({ registry_status: 'verified', has_active_user_grant: true, sender_constrained: true }) === 'verified_partner_agent')
  ok('1b verified + grant + NOT sender-constrained → user_authorized_agent',
    cls({ registry_status: 'verified', has_active_user_grant: true, sender_constrained: false }) === 'user_authorized_agent')
  ok('1c verified + NO grant → registered_agent (public-read quota only, no user authority)',
    cls({ registry_status: 'verified', has_active_user_grant: false, sender_constrained: true }) === 'registered_agent' &&
    cls({ registry_status: 'verified', has_active_user_grant: false, sender_constrained: false }) === 'registered_agent')

  // 2. §3.2 fail-closed: a NON-verified registry status is anonymous no matter what else it presents
  for (const rs of ['unverified', 'suspended', 'revoked', '', 'VERIFIED', 'verified ', 'bogus']) {
    let anonAll = true
    for (const g of [true, false]) for (const s of [true, false]) {
      if (cls({ registry_status: rs, has_active_user_grant: g, sender_constrained: s }) !== 'anonymous_agent') anonAll = false
    }
    ok(`2.${rs || 'empty'} registry_status=${JSON.stringify(rs)} → anonymous_agent for ALL grant/sender combos`, anonAll)
  }

  // 3. exhaustive: no combination of a non-'verified' status ever exceeds anonymous (belt-and-suspenders)
  {
    const tiers = { anonymous_agent: 0, registered_agent: 1, user_authorized_agent: 2, verified_partner_agent: 3 } as const
    let maxNonVerified = 0
    for (const rs of ['unverified', 'suspended', 'revoked', 'x']) for (const g of [true, false]) for (const s of [true, false]) {
      maxNonVerified = Math.max(maxNonVerified, tiers[cls({ registry_status: rs, has_active_user_grant: g, sender_constrained: s })])
    }
    ok('3 non-verified never exceeds anonymous (max tier === 0)', maxNonVerified === 0)
  }

  // 4. source guard: proof.ts wires the classifier, not the old single literal
  {
    const src = readFileSync(join(process.cwd(), 'src/runtime/agent-gateway-proof.ts'), 'utf8')
    ok('4a proof.ts imports classifyGatewayPrincipal', /classifyGatewayPrincipal/.test(src))
    ok('4b proof.ts no longer hardcodes trust_tier: \'user_authorized_agent\' as const', !/trust_tier:\s*'user_authorized_agent'\s+as const/.test(src))
    ok('4c the DPoP context classifies from client.registry_status (real fact, not literal)', /trust_tier:\s*classifyGatewayPrincipal\(\{[\s\S]*registry_status:\s*client\.registry_status/.test(src))
  }

  if (fail > 0) { console.error(`\n❌ agent-gateway-principal FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ agent-gateway-principal (S1d): §3.1 taxonomy · fail-closed (unverified→anonymous for all combos) · verified ladder → registered/user_authorized/verified_partner · proof.ts wired\n  ✅ pass ${pass}`)
} catch (e) {
  console.error('❌ test error:', (e as Error).message); process.exit(1)
}
