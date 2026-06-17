#!/usr/bin/env tsx
/**
 * PR-S — proves the iron-rule guard actually CATCHES violations (and passes clean on the real repo).
 *   用法:npm run test:iron-rules-guard
 *
 * A guard that can never fail is worthless. This plants one violating file per rule in a temp fixture
 * tree and asserts the guard flags exactly that rule; then asserts the real repo is clean.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runIronRuleGuard } from './identity-claim-iron-rules-guard.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`) } }

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// 1) the REAL repo must be clean (this is also what CI's `npm run iron-rules:identity-claim` asserts)
ok('real repo: no iron-rule violations', runIronRuleGuard(REPO).length === 0, runIronRuleGuard(REPO).join(' | '))

// 2) a fixture with one planted violation per rule → each rule must fire
const fx = mkdtempSync(join(tmpdir(), 'ironrules-'))
try {
  const w = (relPath: string, content: string): void => {
    const p = join(fx, relPath); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content)
  }
  // rule1: admin_manual in a non-allowlisted route file
  w('src/pwa/routes/evil-admin.ts', `export const x = { proofMethod: 'admin_manual' }\n`)
  // rule2: row UPDATE on the append-only event log
  w('src/layer2-business/x/sneaky.ts', `db.prepare("UPDATE identity_binding_events SET visibility='public' WHERE event_id=?")\n`)
  // rule4: API-layer file writing a core table directly — ALL SQLite write forms (Codex P1: the old
  // regex missed INSERT OR REPLACE / REPLACE INTO / UPDATE OR …, the most dangerous bypass).
  w('src/pwa/routes/evil-insert.ts', `db.prepare("INSERT INTO identity_bindings_active (github_actor_id) VALUES (?)")\n`)
  w('src/pwa/routes/evil-replace.ts', `db.prepare("INSERT OR REPLACE INTO identity_bindings_active (github_actor_id) VALUES (?)")\n`)
  w('src/pwa/routes/evil-replace2.ts', `db.prepare("REPLACE INTO contribution_facts (fact_id) VALUES (?)")\n`)
  w('src/pwa/routes/evil-ignore.ts', `db.prepare("INSERT OR IGNORE INTO github_fact_credentials (fact_id) VALUES (?)")\n`)
  w('src/pwa/routes/evil-update.ts', `db.prepare("UPDATE OR REPLACE github_contribution_credentials SET core_json='x'")\n`)
  w('src/layer1-agent/L1-1-mcp-server/evil-mcp.ts', `db.prepare("DELETE FROM github_credential_observations WHERE id=?")\n`)
  w('src/pwa/routes/evil-challenge.ts', `db.prepare("INSERT INTO identity_claim_challenges (challenge_id) VALUES (?)")\n`)   // PR-F1: API must not write challenge state
  // rule5: a contribution engine importing a wallet module (use the real engine path so it's checked)
  w('src/layer2-business/L2-9-contribution/identity-binding-engine.ts', `import { pay } from '../../layer2-business/wallet-write.js'\nexport const e = 1\n`)
  // rule7: real-looking GitHub tokens in scripts. Built by concatenation so this test's OWN source
  // doesn't contain the literals (which the guard would flag) — the written fixtures do. Covers both
  // a classic ghp_ token and a fine-grained github_pat_ (Codex P2).
  w('scripts/leak.ts', `const t = '${'ghp_' + 'AbCdEf0123456789AbCdEf0123456789'}'\n`)
  w('scripts/leak-pat.ts', `const t = '${'github_pat_' + '11ABCDE0123456789_AbCdEf0123456789AbCdEf'}'\n`)

  const f = runIronRuleGuard(fx)
  for (const rule of ['rule1', 'rule2', 'rule4', 'rule5', 'rule7']) {
    ok(`guard catches ${rule}`, f.some(v => v.startsWith(`[${rule}]`)), `failures: ${f.join(' | ') || '(none)'}`)
  }
  // P1 — every SQLite write form on a core table from the API layer is caught (not just INSERT INTO).
  ok('rule4 catches INSERT INTO', f.some(v => v.includes('evil-insert.ts')))
  ok('rule4 catches INSERT OR REPLACE INTO (the dangerous bypass)', f.some(v => v.includes('evil-replace.ts')))
  ok('rule4 catches REPLACE INTO', f.some(v => v.includes('evil-replace2.ts')))
  ok('rule4 catches INSERT OR IGNORE INTO', f.some(v => v.includes('evil-ignore.ts')))
  ok('rule4 catches UPDATE OR REPLACE', f.some(v => v.includes('evil-update.ts')))
  ok('rule4 catches DELETE FROM in MCP layer', f.some(v => v.includes('evil-mcp.ts')))
  ok('rule4 catches INSERT INTO identity_claim_challenges (PR-F1)', f.some(v => v.includes('evil-challenge.ts')))
  // P2 — fine-grained github_pat_ token is caught (not just ghp_).
  ok('rule7 catches github_pat_ (fine-grained)', f.some(v => v.includes('leak-pat.ts')))
  // fail-closed: the fixture is missing the other anchors → an anchor failure must also be reported
  ok('guard fail-closed on missing anchor', f.some(v => v.startsWith('[anchor]')))
} finally {
  rmSync(fx, { recursive: true, force: true })
}

console.log('\ntest:iron-rules-guard')
console.log('─────────────────────')
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
console.log('✅ guard proven to catch rule1/2/4/5/7 + fail-closed on missing anchor; real repo clean\n')
