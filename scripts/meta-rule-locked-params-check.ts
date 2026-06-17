#!/usr/bin/env tsx
/**
 * Meta-rule-locked protocol_params invariant check (RFC-002 PR-3, task #1090)
 *
 * Some protocol_params are flagged `metaRuleLocked: true` because lowering
 * them would weaken a meta-rule-level invariant (e.g., the Iron Rule).
 * Per CHARTER §4 I-1 their values can ONLY change through the 60-day
 * meta-rule amendment procedure — not through ordinary param tuning.
 *
 * This script asserts the seed values in `src/pwa/server.ts` RFC002_PARAMS
 * array haven't drifted from the locked baseline. If someone edits the
 * value without updating this script's expected table (and without going
 * through the amendment procedure), CI fails red.
 *
 * Spec:
 *   - docs/rfcs/RFC-002-rewards-opt-in.md §3.3 (which params are locked)
 *   - docs/CHARTER.md §4 I-1 (meta-rule amendment procedure)
 *
 * Sister-script pattern: scripts/meta-rules-invariant-check.ts (yaml + LOCK)
 *
 * Usage: npm run params:check
 */
import { readFileSync, existsSync } from 'fs'

const SERVER_PATH = 'src/pwa/server.ts'

// Locked baseline. Editing this map = editing the lock. Diff is reviewable
// in PR. To lower a value here legitimately, the PR must reference an
// approved meta-rule amendment per CHARTER §4 I-1.
const LOCKED_BASELINE: Record<string, string> = {
  'rewards_opt_in.require_passkey':       '1',  // 1 = Passkey required to apply/close — Iron Rule reinforce
  'rewards_opt_in.consent_delay_seconds': '8',  // 8s anti-induction delay on the disclosure page
}

function readOrThrow(path: string): string {
  if (!existsSync(path)) throw new Error(`file missing: ${path}`)
  return readFileSync(path, 'utf8')
}

interface ParamEntry {
  key: string
  value: string
  metaRuleLocked: boolean
}

/**
 * Extract param entries from server.ts source. Matches the RFC002_PARAMS
 * literal array; very tolerant of inner whitespace/comments but assumes
 * each entry is on its own object literal line `{ key: ..., value: ..., ..., metaRuleLocked: ... }`.
 */
function parseParamEntries(src: string): ParamEntry[] {
  const entries: ParamEntry[] = []
  const startMarker = 'const RFC002_PARAMS:'
  const startIdx = src.indexOf(startMarker)
  if (startIdx === -1) throw new Error(`RFC002_PARAMS array not found in ${SERVER_PATH}`)
  // Capture from `[` to matching `]` — naive but the array is flat object literals
  const openIdx = src.indexOf('[', startIdx)
  const closeIdx = src.indexOf(']', openIdx)
  if (openIdx === -1 || closeIdx === -1) throw new Error('malformed RFC002_PARAMS array')
  const body = src.slice(openIdx + 1, closeIdx)
  const lineRe = /\{\s*key:\s*'([^']+)'[\s\S]*?value:\s*'([^']+)'[\s\S]*?metaRuleLocked:\s*(true|false)[\s\S]*?\}/g
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(body)) !== null) {
    entries.push({ key: m[1], value: m[2], metaRuleLocked: m[3] === 'true' })
  }
  return entries
}

let exitCode = 0
console.log('Meta-rule-locked protocol_params check (CHARTER §4 I-1 enforcement)')
console.log('─'.repeat(72))

try {
  const src = readOrThrow(SERVER_PATH)
  const entries = parseParamEntries(src)
  const locked = entries.filter(e => e.metaRuleLocked)
  console.log(`  parsed ${entries.length} RFC-002 params; ${locked.length} flagged metaRuleLocked\n`)

  // 1. Every key in LOCKED_BASELINE must exist in source as metaRuleLocked
  for (const key of Object.keys(LOCKED_BASELINE)) {
    const entry = locked.find(e => e.key === key)
    if (!entry) {
      console.error(`  ❌ ${key} expected metaRuleLocked=true but not found in RFC002_PARAMS`)
      console.error(`     either restore the flag, or remove the key from this script + run meta-rule amendment per CHARTER §4 I-1`)
      exitCode = 1
      continue
    }
    if (entry.value !== LOCKED_BASELINE[key]) {
      console.error(`  ❌ ${key} value drift: source='${entry.value}' but locked baseline='${LOCKED_BASELINE[key]}'`)
      console.error(`     to change this legitimately:`)
      console.error(`       1. RFC issue describing the change + reason`)
      console.error(`       2. 60-day public notice (CHARTER §4 I-1)`)
      console.error(`       3. Supermajority multisig sign`)
      console.error(`       4. Update both src/pwa/server.ts AND scripts/meta-rule-locked-params-check.ts in same merge commit`)
      exitCode = 1
      continue
    }
    console.log(`  ✅ ${key} = ${entry.value} (locked)`)
  }

  // 2. Every metaRuleLocked param in source must be claimed in LOCKED_BASELINE
  //    (prevents quietly adding a new locked param without registering its value here)
  for (const entry of locked) {
    if (!(entry.key in LOCKED_BASELINE)) {
      console.error(`\n  ❌ ${entry.key} flagged metaRuleLocked in source but not in LOCKED_BASELINE`)
      console.error(`     add it to scripts/meta-rule-locked-params-check.ts LOCKED_BASELINE with the intended value`)
      exitCode = 1
    }
  }

  console.log('─'.repeat(72))
  if (exitCode === 0) {
    console.log(`  ✅ ${locked.length} meta-rule-locked params match baseline`)
    console.log(`  Lock is intact.`)
  } else {
    console.log(`  ❌ drift detected — see errors above`)
  }
} catch (e) {
  console.error(`  ❌ ${(e as Error).message}`)
  exitCode = 1
}

process.exit(exitCode)
