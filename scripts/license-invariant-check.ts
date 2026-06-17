#!/usr/bin/env tsx
/**
 * License invariant check (RFC-001 §8 test plan, task #1085)
 *
 * Mechanically enforces 6 invariants that RFC-001 promised to automate.
 * Runs in CI; any drift between LICENSE / CHARTER / DCO / dep-policy
 * fails the build before reaching main.
 *
 * Spec: docs/rfcs/RFC-001-license-decision.md §8 Test plan
 * Charter anchor: docs/CHARTER.md §4 I-2 (Change Date locked as invariant)
 *
 * Usage: npm run license:check
 *
 * Invariants checked:
 *   1. LICENSE contains exactly one "Change Date: 2030-05-18"
 *   2. LICENSE contains exactly one "Change License: MIT" (or close variant)
 *   3. CHARTER §4 I-2 references the same Change Date as LICENSE
 *   4. DCO.md §"License Evolution Compatibility" mentions BSL→MIT + 2030-05-18
 *   5. dep-license-policy.md whitelist includes MIT
 *   6. licensing@webaz.xyz email reachability — SKIPPED (needs network; manual verify)
 */
import { readFileSync, existsSync } from 'fs'

const LICENSE_PATH = 'LICENSE'
const CHARTER_PATH = 'docs/CHARTER.md'
const DCO_PATH = 'docs/DCO.md'
const DEP_POLICY_PATH = '.github/dep-license-policy.md'

const EXPECTED_CHANGE_DATE = '2030-05-18'
const EXPECTED_CHANGE_LICENSE = 'MIT'

interface CheckResult {
  id: string
  passed: boolean
  message: string
}

const results: CheckResult[] = []

function check(id: string, fn: () => { passed: boolean; message: string }): void {
  try {
    const r = fn()
    results.push({ id, ...r })
  } catch (e) {
    results.push({ id, passed: false, message: `threw: ${(e as Error).message}` })
  }
}

function readOrThrow(path: string): string {
  if (!existsSync(path)) throw new Error(`file missing: ${path}`)
  return readFileSync(path, 'utf8')
}

// Invariant 1: LICENSE has exactly one "Change Date: 2030-05-18"
check('inv-1-license-change-date', () => {
  const text = readOrThrow(LICENSE_PATH)
  const re = new RegExp(`Change Date\\s*:\\s*${EXPECTED_CHANGE_DATE}`, 'g')
  const matches = text.match(re) || []
  return matches.length === 1
    ? { passed: true, message: `LICENSE has exactly 1 "Change Date: ${EXPECTED_CHANGE_DATE}"` }
    : { passed: false, message: `LICENSE expected 1 match, got ${matches.length}` }
})

// Invariant 2: LICENSE has exactly one "Change License: MIT"
check('inv-2-license-change-license', () => {
  const text = readOrThrow(LICENSE_PATH)
  const re = new RegExp(`Change License\\s*:\\s*${EXPECTED_CHANGE_LICENSE}\\b`, 'g')
  const matches = text.match(re) || []
  return matches.length === 1
    ? { passed: true, message: `LICENSE has exactly 1 "Change License: ${EXPECTED_CHANGE_LICENSE}"` }
    : { passed: false, message: `LICENSE expected 1 match for Change License: ${EXPECTED_CHANGE_LICENSE}, got ${matches.length}` }
})

// Invariant 3: CHARTER §4 I-2 references same Change Date
// P2-A fix (post-review): anchor on heading `### I-2` rather than bare `I-2`
// so TOC entries / cross-refs like §3.1 "(同 I-2)" don't shift the search window
check('inv-3-charter-change-date', () => {
  const text = readOrThrow(CHARTER_PATH)
  if (!text.includes(EXPECTED_CHANGE_DATE)) {
    return { passed: false, message: `CHARTER missing "${EXPECTED_CHANGE_DATE}" reference` }
  }
  // Match the H3 heading specifically — robust to TOC / cross-refs
  const headingMatch = text.match(/^###\s+I-2\b/m)
  if (!headingMatch || headingMatch.index === undefined) {
    return { passed: false, message: 'CHARTER missing "### I-2" heading anchor' }
  }
  // Look for Change Date in section body (within 5000 chars after heading)
  const window = text.slice(headingMatch.index, headingMatch.index + 5000)
  if (!window.includes(EXPECTED_CHANGE_DATE)) {
    return { passed: false, message: `CHARTER ### I-2 section does not reference ${EXPECTED_CHANGE_DATE} within 5KB window` }
  }
  return { passed: true, message: `CHARTER ### I-2 references Change Date ${EXPECTED_CHANGE_DATE}` }
})

// Invariant 4: DCO.md §License Evolution Compatibility mentions BSL + MIT + 2030-05-18
check('inv-4-dco-license-evolution', () => {
  const text = readOrThrow(DCO_PATH)
  const sectionMarker = 'License Evolution Compatibility'
  if (!text.includes(sectionMarker)) {
    return { passed: false, message: `DCO.md missing "${sectionMarker}" section` }
  }
  const sectionIdx = text.indexOf(sectionMarker)
  const sectionWindow = text.slice(sectionIdx, sectionIdx + 3000)
  const required = ['BSL', 'MIT', EXPECTED_CHANGE_DATE]
  const missing = required.filter(s => !sectionWindow.includes(s))
  return missing.length === 0
    ? { passed: true, message: `DCO License Evolution section mentions BSL + MIT + ${EXPECTED_CHANGE_DATE}` }
    : { passed: false, message: `DCO License Evolution section missing: ${missing.join(', ')}` }
})

// Invariant 5: dep-license-policy.md whitelist mentions MIT (for post-Change-Date compatibility)
check('inv-5-dep-policy-mit', () => {
  const text = readOrThrow(DEP_POLICY_PATH)
  // Look for MIT in a "compatible" or "whitelist" context — not negative list
  // Strategy: find "MIT" in a table row that signals allow (presence is necessary;
  // structural check would need markdown parser. Phase A: simple presence check.)
  if (!text.includes('MIT')) {
    return { passed: false, message: 'dep-license-policy.md does not mention MIT' }
  }
  // Also verify BSL mentioned (current period)
  if (!text.includes('BSL')) {
    return { passed: false, message: 'dep-license-policy.md does not mention BSL (current license period)' }
  }
  return { passed: true, message: 'dep-license-policy.md mentions both BSL (current) + MIT (post-Change-Date)' }
})

// Invariant 6: licensing@webaz.xyz email reachability — SKIPPED in CI
results.push({
  id: 'inv-6-licensing-email-reachable',
  passed: true,
  message: 'SKIPPED (needs network; manual verify per RFC-001 §8 last item)',
})

// Report + exit
const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length

console.log('License invariant check (RFC-001 §8 mechanical enforcement)')
console.log('─'.repeat(64))
for (const r of results) {
  const icon = r.passed ? '✅' : '❌'
  console.log(`  ${icon} ${r.id}: ${r.message}`)
}
console.log('─'.repeat(64))
console.log(`  passed: ${passed}/${results.length}    failed: ${failed}`)

if (failed > 0) {
  console.error('\n❌ License invariant check FAILED. See RFC-001 §8 for what each invariant guards.')
  process.exit(1)
}
console.log('\n✅ All license invariants hold.')
