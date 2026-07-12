#!/usr/bin/env tsx
/**
 * AGENTS.md title invariant
 *
 * AGENTS.md is the canonical agent-onboarding entry point (CLAUDE.md defers
 * to it as single source of truth). Tooling and readers treat the first
 * heading as the document identity, so nothing may sit above the real title
 * and the document must have exactly one H1.
 *
 * Regression guard for the remote-dev smoke-test line that landed as a
 * second H1 above the title (PR #313 audit finding).
 *
 * Usage: npm run test:agents-md-title
 */
import { readFileSync, existsSync } from 'fs'

const AGENTS_PATH = 'AGENTS.md'
const CANONICAL_TITLE_PREFIX = '# AGENTS.md'

interface CheckResult {
  id: string
  passed: boolean
  message: string
}

const results: CheckResult[] = []

if (!existsSync(AGENTS_PATH)) {
  console.error(`❌ ${AGENTS_PATH} missing`)
  process.exit(1)
}

const lines = readFileSync(AGENTS_PATH, 'utf8').split('\n')

// Invariant 1: line 1 IS the canonical title — nothing above it
const firstLine = lines[0] ?? ''
results.push(
  firstLine.startsWith(CANONICAL_TITLE_PREFIX)
    ? { id: 'inv-1-title-first-line', passed: true, message: `line 1 starts with "${CANONICAL_TITLE_PREFIX}"` }
    : { id: 'inv-1-title-first-line', passed: false, message: `line 1 is "${firstLine}" — expected the canonical "${CANONICAL_TITLE_PREFIX} …" title with nothing above it` }
)

// Invariant 2: exactly one H1 (fenced code blocks excluded)
let inFence = false
const h1Lines: number[] = []
lines.forEach((line, i) => {
  if (/^```/.test(line)) { inFence = !inFence; return }
  if (!inFence && /^# /.test(line)) h1Lines.push(i + 1)
})
results.push(
  h1Lines.length === 1
    ? { id: 'inv-2-single-h1', passed: true, message: 'exactly one H1' }
    : { id: 'inv-2-single-h1', passed: false, message: `expected exactly 1 H1, found ${h1Lines.length} (lines ${h1Lines.join(', ')})` }
)

const failed = results.filter(r => !r.passed)
console.log('AGENTS.md title invariant check')
console.log('─'.repeat(64))
for (const r of results) console.log(`  ${r.passed ? '✅' : '❌'} ${r.id}: ${r.message}`)
console.log('─'.repeat(64))

if (failed.length > 0) {
  console.error('\n❌ AGENTS.md title invariant FAILED — the first line must be the canonical H1 title and the only H1 in the document.')
  process.exit(1)
}
console.log('\n✅ AGENTS.md title invariants hold.')
