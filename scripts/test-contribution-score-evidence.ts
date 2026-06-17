#!/usr/bin/env tsx
/**
 * PR5E — Contribution Score v1 read-only evidence collector tests (fresh in-memory DB; no network).
 *   用法:npm run test:contribution-score-evidence
 *
 * Verifies: only the caller's own ACTIVE credential-backed attributable facts feed the positive
 * components; unbound-actor facts and other accounts' facts are excluded; non-active facts are NOT in the
 * positive buckets; reverted_penalty is NOT-YET-WIRED (0/[]; no status-events overlay source — never read
 * from contribution_facts.status, which is append-only/as-ingested); evidence_refs point at real fact rows;
 * the output keys match the #318 contract; NO contribution_score is ever returned; the engine does no DB
 * write; and no economic-promise field name appears.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { bindGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'
import { collectContributionScoreEvidence } from '../src/layer2-business/L2-9-contribution/contribution-score-evidence.js'
import { CONTRIBUTION_SCORE_V1 } from '../src/layer2-business/L2-9-contribution/contribution-score-contract.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const ALICE = 'usr_alice', BOB = 'usr_bob'
const FORBIDDEN = /amount|currency|yield|payout|reward|\bprice\b|promise|\bclaim\b/i

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any
function seedFact(sek: string, actor: string, factId: string, credId: string, opts: { type?: string | null; status?: string; executorActor?: string } = {}): void {
  const executor = `github:${opts.executorActor ?? actor}`
  db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status) VALUES (?,?,'github',?,'m','t',?,NULL,'unknown',?)`)
    .run(factId, sek, opts.type ?? null, executor, opts.status ?? 'active')
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES (?,?,'2',?,'R','P',1,'m','t',?,'merged','{}')`)
    .run(credId, `dig_${credId}`, sek, actor)
  db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES (?,?,?)`).run(factId, credId, sek)
}
function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','c','ka'),('usr_bob','Bob','c','kb')`).run()
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  setSeamDb(db)
}
const byKey = (comps: any[], k: string) => comps.find(c => c.key === k)

async function main(): Promise<void> {
  freshDb()
  await bindGithubIdentity({ githubActorId: 'U_alice', accountId: ALICE, proofMethod: 'github_publication_challenge' })
  await bindGithubIdentity({ githubActorId: 'U_bob', accountId: BOB, proofMethod: 'github_publication_challenge' })
  // alice: active code/audit/maintenance + a reverted fact; bob: one active; an orphan (unbound) active.
  seedFact('sek:a:code', 'U_alice', 'cf_a_code', 'cr_a_code', { type: 'code' })
  seedFact('sek:a:audit', 'U_alice', 'cf_a_audit', 'cr_a_audit', { type: 'audit' })
  seedFact('sek:a:maint', 'U_alice', 'cf_a_maint', 'cr_a_maint', { type: 'maintenance' })
  seedFact('sek:a:rev', 'U_alice', 'cf_a_rev', 'cr_a_rev', { type: 'code', status: 'reverted' })
  seedFact('sek:b:code', 'U_bob', 'cf_b_code', 'cr_b_code', { type: 'code' })
  seedFact('sek:orphan', 'U_orphan', 'cf_orphan', 'cr_orphan', { type: 'code' })   // actor bound to nobody

  const a = await collectContributionScoreEvidence(ALICE)
  const accepted = byKey(a, 'accepted_contributions')

  // 1) only the account's active attributable facts feed accepted_contributions
  ok('1 accepted = alice active attributable (3: code/audit/maint)', accepted.raw_count === 3 && JSON.stringify([...accepted.evidence_refs].sort()) === JSON.stringify(['cf_a_audit', 'cf_a_code', 'cf_a_maint']), JSON.stringify(accepted))
  // 2) unbound actor's fact excluded
  ok('2 orphan (unbound actor) fact excluded', !accepted.evidence_refs.includes('cf_orphan'))
  // 3) other account's fact excluded
  ok('3 bob fact excluded from alice', !accepted.evidence_refs.includes('cf_b_code'))
  // 4) non-active facts are excluded from the positive buckets (active-only). reverted_penalty is NOT
  //    sourced from contribution_facts.status — lifecycle status belongs to a future append-only
  //    status-events overlay; status is as-ingested 'active' and never updated in place. The seeded
  //    status='reverted' row is a REGRESSION GUARD: if someone re-wires reverted_penalty to fact.status,
  //    raw_count would become 1 and this fails.
  ok('4 reverted (non-active) fact NOT in accepted (active-only filter)', !accepted.evidence_refs.includes('cf_a_rev'))
  ok('4 reverted_penalty = 0/[] despite a reverted fact (NOT read from fact.status; append-only)', byKey(a, 'reverted_penalty').raw_count === 0 && byKey(a, 'reverted_penalty').evidence_refs.length === 0)
  // typed subsets
  ok('reviews_provided (type=audit) = [cf_a_audit]', byKey(a, 'reviews_provided').raw_count === 1 && byKey(a, 'reviews_provided').evidence_refs[0] === 'cf_a_audit')
  ok('maintenance_actions (type=maintenance) = [cf_a_maint]', byKey(a, 'maintenance_actions').raw_count === 1 && byKey(a, 'maintenance_actions').evidence_refs[0] === 'cf_a_maint')
  ok('impact_observed = 0 / [] (no source in v1, not fabricated)', byKey(a, 'impact_observed').raw_count === 0 && byKey(a, 'impact_observed').evidence_refs.length === 0)
  ok('reverted_penalty = 0 / [] (no status-events overlay source yet)', byKey(a, 'reverted_penalty').raw_count === 0 && byKey(a, 'reverted_penalty').evidence_refs.length === 0)

  // 5) evidence_refs point at REAL fact rows
  const allRefs = a.flatMap((c: any) => c.evidence_refs)
  const realFactIds = new Set((db.prepare('SELECT fact_id FROM contribution_facts').all() as any[]).map(r => r.fact_id))
  ok('5 every evidence_ref is a real contribution_facts.fact_id', allRefs.length > 0 && allRefs.every((r: string) => realFactIds.has(r)), JSON.stringify(allRefs))

  // bob sees only his own
  const b = await collectContributionScoreEvidence(BOB)
  ok('bob accepted = 1 (cf_b_code only)', byKey(b, 'accepted_contributions').raw_count === 1 && byKey(b, 'accepted_contributions').evidence_refs[0] === 'cf_b_code')
  // unrelated account → all-zero, still all 5 components
  const none = await collectContributionScoreEvidence('usr_nobody')
  ok('unrelated account → 5 components all zero', none.length === 5 && none.every((c: any) => c.raw_count === 0))

  // output shape: keys match the #318 contract, in order; NO contribution_score anywhere
  ok('keys match #318 contract component_keys (in order)', JSON.stringify(a.map((c: any) => c.key)) === JSON.stringify([...CONTRIBUTION_SCORE_V1.component_keys]))
  ok('component shape = { key, raw_count, evidence_refs }', a.every((c: any) => typeof c.key === 'string' && typeof c.raw_count === 'number' && Array.isArray(c.evidence_refs) && Object.keys(c).length === 3))
  ok('NO contribution_score / score / total field in output', !JSON.stringify(a).match(/contribution_score|"score"|"total"/i))

  // 6) engine source: no DB write
  const src = readFileSync(join(HERE, '..', 'src', 'layer2-business', 'L2-9-contribution', 'contribution-score-evidence.ts'), 'utf8')
  ok('6 engine source: no INSERT/UPDATE/DELETE/REPLACE', !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(src))
  ok('6 engine source: no reward/kyc/wallet/economic/valuation import', !/\bfrom\s+['"][^'"]*(wallet|reward|kyc|economic|payout|valuation|escrow|commission)[^'"]*['"]/i.test(src))
  // 7) no economic-promise field name in engine source or returned keys
  ok('7 returned component keys carry no economic-promise term', !a.some((c: any) => FORBIDDEN.test(c.key)), JSON.stringify(a.map((c: any) => c.key)))
  ok('7 engine assigns no economic-promise field (term: / term=)', !/\b(reward|payout|amount|currency|yield|\bprice\b|promise|\bclaim\b)\s*[:=]/i.test(src))

  console.log('\ntest:contribution-score-evidence')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ evidence collector: own active credential-backed attributable facts only · unbound/other-account/non-active excluded · impact_observed & reverted_penalty not-yet-wired (0/[]; reverted NOT read from fact.status, append-only) · real evidence_refs · keys match #318 · NO contribution_score · read-only\n')
}

main().catch(e => { console.error(e); process.exit(1) })
