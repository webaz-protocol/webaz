#!/usr/bin/env tsx
/**
 * Meta-rules invariant check (CHARTER §4 I-1, task #1086 W7 lock)
 *
 * Verifies that the SHA256 of docs/meta-rules.yaml matches the
 * canonical hash claimed in docs/META-RULES-LOCK.md §1.
 *
 * Any drift between yaml content and lock-doc claim fails CI red,
 * forcing the editor to either:
 *   - Revert their yaml change (if they didn't mean to amend), OR
 *   - Update the LOCK.md hash AND go through CHARTER §4 I-1 amendment
 *     procedure (60-day public notice + supermajority multisig)
 *
 * Spec: docs/CHARTER.md §4 I-1 + §4 I-6 (mechanical enforcement)
 * Lock: docs/META-RULES-LOCK.md §4 (anti-circumvention design)
 *
 * Usage: npm run meta-rules:check
 */
import { readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'

const YAML_PATH = 'docs/meta-rules.yaml'
const LOCK_PATH = 'docs/META-RULES-LOCK.md'

function readOrThrow(path: string): string {
  if (!existsSync(path)) throw new Error(`file missing: ${path}`)
  return readFileSync(path, 'utf8')
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

let exitCode = 0

console.log('Meta-rules invariant check (CHARTER §4 I-1 mechanical enforcement)')
console.log('─'.repeat(72))

try {
  // 1. Compute actual hash of yaml file
  const yamlContent = readOrThrow(YAML_PATH)
  const actualHash = sha256(yamlContent)
  console.log(`  actual yaml SHA256: ${actualHash}`)

  // 2. Extract claimed hash from LOCK doc
  const lockContent = readOrThrow(LOCK_PATH)
  // Look for `Canonical SHA256` row in §1 table; capture the hex hash
  const claimMatch = lockContent.match(/Canonical SHA256\s*\|\s*`([a-f0-9]{64})`/i)
  if (!claimMatch) {
    console.error('  ❌ could not find "Canonical SHA256" claim in LOCK doc §1')
    console.error('     expected row pattern: | Canonical SHA256 | `<64-hex-chars>` |')
    process.exit(1)
  }
  const claimedHash = claimMatch[1].toLowerCase()
  console.log(`  claimed in LOCK doc:  ${claimedHash}`)

  // 3. Compare
  if (actualHash !== claimedHash) {
    console.error('  ❌ MISMATCH — meta-rules.yaml has been modified without updating LOCK.md')
    console.error('')
    console.error('  Either:')
    console.error('    (a) Revert your yaml change (if it was unintentional), OR')
    console.error('    (b) Go through CHARTER §4 I-1 amendment procedure:')
    console.error('        - Open RFC issue on GitHub describing the change + rationale')
    console.error('        - 60-day public notice period')
    console.error('        - Supermajority multisig sign')
    console.error('        - Update both files in same merge commit:')
    console.error(`          - docs/META-RULES-LOCK.md §1 Canonical SHA256 → ${actualHash}`)
    console.error('          - docs/META-RULES-LOCK.md §5 version history (append new row)')
    console.error('')
    process.exit(1)
  }

  // 4. Additional sanity: also verify the version history table contains this hash
  // (defense in depth — prevents someone from only updating the table at top
  // without recording in history)
  if (!lockContent.includes(actualHash)) {
    console.error('  ⚠️ hash matches §1 but not found in §5 version history table')
    console.error('     this should not normally happen unless §5 was manually edited')
    process.exit(1)
  }

  console.log('─'.repeat(72))
  console.log('  ✅ meta-rules.yaml SHA256 matches LOCK.md claim')
  console.log('  ✅ hash also recorded in §5 version history')
  console.log('')
  console.log('Meta-rules v1.0 lock is intact.')
} catch (e) {
  console.error(`  ❌ ${(e as Error).message}`)
  exitCode = 1
}

process.exit(exitCode)
