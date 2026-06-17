#!/usr/bin/env tsx
/**
 * PR-S — iron-rule guard for the 4b identity-claim pipeline. STATIC, FAIL-CLOSED.
 *   用法:npm run iron-rules:identity-claim
 *
 * Purpose: lock the security boundaries BEFORE PR-F adds any claim API/MCP/UI, so a future endpoint
 * cannot bypass them. This guard expresses the *statically-checkable* iron rules; the DB-level rules
 * (append-only triggers / composite FK / CHECK fail-closed) are proven by the fresh-DB test
 * scripts/test-identity-binding.ts. Documents-don't-count: this scans the ACTUAL code paths.
 * `runIronRuleGuard(root)` is exported so scripts/test-identity-claim-iron-rules-guard.ts can prove it
 * actually CATCHES violations (a guard that can't fail is worthless).
 *
 * Rules enforced here (full mapping: docs/IDENTITY-CLAIM-DESIGN.md §5):
 *   1. `admin_manual` (high-risk override marker) only in the controlled allowlist (engine + store CHECK
 *      + its test + design doc + this guard) — never in a route/MCP/API handler.
 *   2. No code issues a row UPDATE/DELETE on the append-only `identity_binding_events` log.
 *   4. No API-layer file (src/pwa/**, src/layer1-agent/**) writes the identity/contribution CORE tables
 *      directly — every write goes through the layer2 engine.
 *   5. The contribution engines don't import reward / KYC / wallet / economic modules (boundary 5).
 *   7. Test/script files carry no real-looking GitHub token (only the FAKE sentinel).
 *
 * FAIL-CLOSED: any violation → non-zero exit; a missing expected anchor file is itself a failure.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const CORE_TABLES = [
  'identity_binding_events', 'identity_bindings_active', 'contribution_facts',
  'github_fact_credentials', 'github_contribution_credentials', 'github_credential_observations',
  'identity_claim_challenges',   // PR-F1: challenge state — API must NOT write it; only the future engine may (CAS)
]
const ENGINES = [
  'src/layer2-business/L2-9-contribution/identity-binding-engine.ts',
  'src/layer2-business/L2-9-contribution/github-credential-ingestion-engine.ts',
  'src/layer2-business/L2-9-contribution/identity-claim-engine.ts',
  'src/layer2-business/L2-9-contribution/identity-claim-proof-verifier.ts',
  'src/layer2-business/L2-9-contribution/identity-claim-challenge-engine.ts',
  'src/layer2-business/L2-9-contribution/identity-claim-fact-precondition.ts',
  'src/layer2-business/L2-9-contribution/identity-claim-read.ts',
  'src/layer2-business/L2-9-contribution/contribution-display-envelope.ts',
  'src/layer2-business/L2-9-contribution/contribution-score-contract.ts',
  'src/layer2-business/L2-9-contribution/contribution-score-evidence.ts',
]
const ADMIN_MANUAL_ALLOW = new Set([
  'src/layer2-business/L2-9-contribution/identity-binding-engine.ts',
  'src/layer2-business/L2-9-contribution/identity-binding-store.ts',
  'scripts/test-identity-binding.ts',
  'docs/IDENTITY-CLAIM-DESIGN.md',
  'scripts/identity-claim-iron-rules-guard.ts',
  'scripts/test-identity-claim-iron-rules-guard.ts',
])
const ANCHORS = [...ENGINES, 'scripts/test-identity-binding.ts', 'docs/IDENTITY-CLAIM-DESIGN.md']

function walk(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p, exts))
    else if (exts.some(x => p.endsWith(x))) out.push(p)
  }
  return out
}

/** Returns the list of iron-rule violations under `root` ([] = clean). Pure: no process.exit. */
export function runIronRuleGuard(root: string): string[] {
  const rel = (p: string): string => relative(root, p).split('\\').join('/')
  const read = (p: string): string => readFileSync(p, 'utf8')
  const failures: string[] = []
  const fail = (rule: string, msg: string): void => { failures.push(`[${rule}] ${msg}`) }

  const allSrc = walk(join(root, 'src'), ['.ts'])
  const apiLayer = allSrc.filter(p => rel(p).startsWith('src/pwa/') || rel(p).startsWith('src/layer1-agent/'))

  // FAIL-CLOSED anchors — guard must never silently pass because code moved.
  for (const a of ANCHORS) if (!existsSync(join(root, a))) fail('anchor', `expected file missing: ${a} — guard cannot verify (fail-closed)`)

  // Rule 1 — admin_manual only in the controlled allowlist.
  for (const p of [...allSrc, ...walk(join(root, 'scripts'), ['.ts']), ...walk(join(root, 'docs'), ['.md'])]) {
    if (read(p).includes('admin_manual') && !ADMIN_MANUAL_ALLOW.has(rel(p))) {
      fail('rule1', `admin_manual in non-allowlisted file ${rel(p)} — admin/manual override must stay behind the controlled engine path + an admin-capability check`)
    }
  }

  // SQLite write-form fragments (the original regex missed INSERT OR REPLACE/IGNORE INTO, REPLACE INTO,
  // UPDATE OR … — Codex P1). `OR_CONFLICT` = the optional `OR (REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)` clause.
  const OR_CONFLICT = '(\\s+OR\\s+(REPLACE|IGNORE|ABORT|FAIL|ROLLBACK))?'
  // ANY write to a row (used by rule4 — an API layer must do NONE of these on a core table):
  const ANY_WRITE = `(INSERT${OR_CONFLICT}\\s+INTO|REPLACE\\s+INTO|UPDATE${OR_CONFLICT}|DELETE\\s+FROM)`
  // ROW MUTATION of an append-only log (rule2): plain INSERT/INSERT OR IGNORE merely append; UPDATE,
  // DELETE, REPLACE INTO and INSERT OR REPLACE INTO can replace/remove an existing row → forbidden.
  const ROW_MUTATION = `(UPDATE${OR_CONFLICT}|DELETE\\s+FROM|REPLACE\\s+INTO|INSERT\\s+OR\\s+REPLACE\\s+INTO)`
  const onTable = (verbGroup: string, t: string): RegExp => new RegExp(`${verbGroup}\\s+["'\`]?${t}\\b`, 'i')

  // Rule 2 — the append-only event log must not be row-mutated (DROP-TABLE migration / BEFORE-trigger
  // DDL / plain INSERT append are NOT this).
  for (const p of allSrc) {
    if (onTable(ROW_MUTATION, 'identity_binding_events').test(read(p))) {
      fail('rule2', `${rel(p)} mutates the append-only identity_binding_events log (UPDATE/DELETE/REPLACE/INSERT-OR-REPLACE)`)
    }
  }

  // Rule 4 — API layer must not write CORE tables directly (any write form).
  for (const p of apiLayer) {
    const src = read(p)
    for (const t of CORE_TABLES) {
      if (onTable(ANY_WRITE, t).test(src)) {
        fail('rule4', `${rel(p)} writes core table ${t} directly — identity/contribution writes MUST go through the layer2 engine`)
      }
    }
  }

  // Rule 5 — contribution engines must not import reward / KYC / wallet / economic modules.
  const FORBIDDEN_IMPORT = /\bfrom\s+['"][^'"]*(wallet|reward|kyc|economic|payout|valuation)[^'"]*['"]/i
  for (const a of ENGINES) {
    const p = join(root, a); if (!existsSync(p)) continue
    for (const line of read(p).split('\n')) {
      if (/^\s*import\b/.test(line) && FORBIDDEN_IMPORT.test(line)) {
        fail('rule5', `${a} imports a reward/KYC/wallet/economic module (${line.trim()}) — keep credential/fact/binding free of reward/identity-rights coupling`)
      }
    }
  }

  // Rule 7 — no real-looking GitHub token in tests/scripts (only the FAKE sentinel). Covers the modern
  // token families: ghp_/gho_/ghu_/ghs_/ghr_ (classic + OAuth/app) and github_pat_ (fine-grained) — Codex P2.
  const REAL_TOKEN = /(gh[pousr]_(?!FAKE)[A-Za-z0-9]{20,}|github_pat_(?!FAKE)[A-Za-z0-9_]{20,})/
  for (const p of walk(join(root, 'scripts'), ['.ts'])) {
    if (REAL_TOKEN.test(read(p))) fail('rule7', `${rel(p)} contains a real-looking GitHub token (ghp_/gho_/ghs_/github_pat_…) — tests must use only the FAKE sentinel`)
  }

  return failures
}

// ── CLI (only when run directly, not when imported by the test) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const failures = runIronRuleGuard(ROOT)
  console.log('\niron-rules:identity-claim (4b PR-S static guard)')
  console.log('────────────────────────────────────────────────')
  if (failures.length) {
    console.error(`\n❌ iron-rule violations (${failures.length}):`)
    for (const f of failures) console.error(`  • ${f}`)
    console.error('')
    process.exit(1)
  }
  console.log('  ✅ rule1 admin_manual allowlisted · rule2 event log not row-mutated · rule4 no direct API writes · rule5 no reward/KYC coupling · rule7 no real tokens\n')
}
