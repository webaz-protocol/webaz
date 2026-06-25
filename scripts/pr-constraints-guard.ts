#!/usr/bin/env tsx
/**
 * Engineering PR constraints — CI guard (follow-up to PR #58 / docs/ENGINEERING-PR-CONSTRAINTS.md).
 *   用法:npm run guard:pr-constraints
 *
 * Upgrades two cheap, mechanical rules from review-time prose into a CI hard wall:
 *
 *   Guard A — ratchet baselines may only go DOWN.
 *     Compare scripts/complexity-ratchet-guard.ts on this branch vs the merge-base
 *     with origin/main. Any EXISTING LOC_CEILINGS entry or SERVER_DDL_EXACT
 *     ('CREATE TABLE' / 'ALTER TABLE') baseline that RISES → fail. Decreases are
 *     fine. New keys are allowed, but a new LOC_CEILINGS path must be a file that
 *     actually exists (no ghost ceilings). FAIL-CLOSED: there is no
 *     `ratchet-raise:` exception channel — if a baseline genuinely must rise, that
 *     is a deliberate decision to be handled separately, not waved through here.
 *
 *   Guard B — every split src/pwa/public/app-*.js is fully wired.
 *     Each app-*.js must appear in BOTH package.json's check:pwa-syntax command
 *     AND complexity-ratchet-guard.ts's LOC_CEILINGS, so complexity can't move
 *     under a new filename that nothing checks.
 *
 * Base comparison uses git; if origin/main can't be resolved (e.g. a shallow
 * local clone with no remote), Guard A is skipped with a notice — CI fetches the
 * base branch, so enforcement always happens there. Guard B needs no git.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const GUARD_REL = 'scripts/complexity-ratchet-guard.ts'
const PWA_DIR_REL = 'src/pwa/public'

let failed = false
const fail = (msg: string): void => { failed = true; console.error(`  ✗ ${msg}`) }

// ── parse the two baseline records out of a complexity-ratchet-guard.ts source ──
function sliceBlock(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  const close = src.indexOf('\n}', open)
  return open >= 0 && close > open ? src.slice(open, close) : ''
}
function parsePairs(block: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const mt of block.matchAll(/'([^']+)'\s*:\s*(\d+)/g)) m.set(mt[1], Number(mt[2]))
  return m
}
function parseGuard(src: string): { all: Map<string, number>; loc: Map<string, number> } {
  const loc = parsePairs(sliceBlock(src, 'LOC_CEILINGS'))
  const ddl = parsePairs(sliceBlock(src, 'SERVER_DDL_EXACT'))
  const all = new Map<string, number>([...loc, ...ddl])
  return { all, loc }
}

const currentSrc = readFileSync(join(ROOT, GUARD_REL), 'utf8')
const current = parseGuard(currentSrc)

// ─────────────────────────── Guard A: ratchet monotonicity ───────────────────────────
console.log('— Guard A: complexity ratchet baselines may only go DOWN —')
const BASE_REF = process.env.PR_CONSTRAINTS_BASE || 'origin/main'
let baseSrc: string | null = null
try {
  const baseSha = execSync(`git merge-base ${BASE_REF} HEAD`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  baseSrc = execSync(`git show ${baseSha}:${GUARD_REL}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
} catch {
  baseSrc = null
}

if (!baseSrc) {
  console.log(`  ⚠ base ref '${BASE_REF}' not resolvable (shallow clone / no remote) — skipping monotonicity locally; CI enforces it.`)
} else {
  const base = parseGuard(baseSrc)
  let raises = 0
  for (const [key, cur] of current.all) {
    const prev = base.all.get(key)
    if (prev === undefined) {
      // new baseline key — allowed, but a new LOC path must point at a real file
      if (current.loc.has(key) && !existsSync(join(ROOT, key))) {
        fail(`new LOC_CEILINGS entry '${key}' has no such file — ghost ceiling.`)
      } else {
        console.log(`  ✓ new baseline '${key}' = ${cur} (allowed)`)
      }
      continue
    }
    if (cur > prev) { raises++; fail(`baseline '${key}' rose ${prev} → ${cur}. Ratchet baselines may only be LOWERED, never raised (fail-closed: no exception channel).`) }
    else if (cur < prev) console.log(`  ✓ '${key}' lowered ${prev} → ${cur}`)
    else console.log(`  ✓ '${key}' unchanged (${cur})`)
  }
  if (raises === 0) console.log('  Guard A OK')
}

// ─────────────────────────── Guard B: app-*.js fully wired ───────────────────────────
console.log('— Guard B: every src/pwa/public/app-*.js is wired into check:pwa-syntax + LOC_CEILINGS —')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const checkScript = pkg.scripts['check:pwa-syntax'] || ''
const splitFiles = readdirSync(join(ROOT, PWA_DIR_REL)).filter(f => /^app-.*\.js$/.test(f)).sort()

if (splitFiles.length === 0) console.log('  (no app-*.js split files yet)')
for (const f of splitFiles) {
  const rel = `${PWA_DIR_REL}/${f}`
  const inSyntax = checkScript.includes(`${PWA_DIR_REL}/${f}`) || checkScript.includes(`/${f}`)
  const inCeiling = current.loc.has(rel)
  if (!inSyntax) fail(`${f}: not in package.json check:pwa-syntax — add \`node --check ${rel}\`.`)
  if (!inCeiling) fail(`${f}: not in complexity-ratchet-guard.ts LOC_CEILINGS — add a '${rel}' ceiling.`)
  if (inSyntax && inCeiling) console.log(`  ✓ ${f}: in check:pwa-syntax + LOC_CEILINGS`)
}

if (failed) {
  console.error('\npr-constraints guard failed — see messages above. (docs/ENGINEERING-PR-CONSTRAINTS.md §3, §5)')
  process.exit(1)
}
console.log('\npr-constraints guard OK')
