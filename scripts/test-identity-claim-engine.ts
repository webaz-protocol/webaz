#!/usr/bin/env tsx
/**
 * PR-F2 — identity claim engine tests (fresh in-memory DB; no API, no network, no real proof).
 *   用法:npm run test:identity-claim-engine
 *
 * Verifies: the precondition requires a GitHub credential-BACKED active fact (facts ⋈ link ⋈ credential,
 * Codex F2 P1) — not merely a matching generic executor_ref; consume-challenge CAS + bind in ONE tx;
 * typed outcomes; rollback (CAS-then-bind-failure / already_bound_other / failed precondition leave the
 * challenge ISSUED); no contribution_facts.accountable_ref mutation; proof gate.
 */
import Database from 'better-sqlite3'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initIdentityClaimChallengeSchema } from '../src/layer2-business/L2-9-contribution/identity-claim-challenge-store.js'
import { bindGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'
import { claimGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-claim-engine.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const SEK = 'github:R_webaz:PR_1:merged'
const NONCE = 'a'.repeat(64)
/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','c','ka'),('usr_bob','Bob','c','kb')`).run()
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  initIdentityClaimChallengeSchema(db)
  setSeamDb(db)
  return db
}
const insFact = (db: any, o: any = {}) => db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status) VALUES (@fact_id,@source_event_key,@source,NULL,@artifact_ref,@occurred_at,@executor_ref,NULL,'unknown',@status)`).run({ fact_id: 'cfact_1', source_event_key: SEK, source: 'github', artifact_ref: 'm', occurred_at: 't', executor_ref: 'github:U_alice', status: 'active', ...o })
const insCred = (db: any, o: any = {}) => db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES (@credential_id,@core_digest,'2',@source_event_key,'R','P',1,'m','t',@github_actor_id,'merged','{}')`).run({ credential_id: 'ghc_alice', core_digest: 'd1', source_event_key: SEK, github_actor_id: 'U_alice', ...o })
const insLink = (db: any, o: any = {}) => db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES (@fact_id,@credential_id,@source_event_key)`).run({ fact_id: 'cfact_1', credential_id: 'ghc_alice', source_event_key: SEK, ...o })
// full credential-backed chain (fact ⋈ link ⋈ credential), actor U_alice, source SEK
const seedChain = (db: any) => { insFact(db); insCred(db); insLink(db) }
// expires_at concrete (pass 'PAST' for expired)
const insChallenge = (db: any, o: any = {}) => {
  const future = (db.prepare("SELECT datetime('now','+1 hour') AS t").get() as any).t
  const past = (db.prepare("SELECT datetime('now','-1 hour') AS t").get() as any).t
  const row = { challenge_id: 'icc_1', account_id: 'usr_alice', github_actor_id: 'U_alice', source_event_key: SEK, nonce_hash: NONCE, expires_at: future, ...o }
  if (row.expires_at === 'PAST') row.expires_at = past
  db.prepare(`INSERT INTO identity_claim_challenges (challenge_id,account_id,github_actor_id,source_event_key,nonce_hash,status,expires_at) VALUES (?,?,?,?,?,'issued',?)`)
    .run(row.challenge_id, row.account_id, row.github_actor_id, row.source_event_key, row.nonce_hash, row.expires_at)
}
const chalStatus = (db: any, id = 'icc_1') => (db.prepare('SELECT status FROM identity_claim_challenges WHERE challenge_id=?').get(id) as any)?.status
const activeAcct = (db: any, gh = 'U_alice') => (db.prepare('SELECT account_id FROM identity_bindings_active WHERE github_actor_id=?').get(gh) as any)?.account_id
const eventCount = (db: any) => (db.prepare('SELECT COUNT(*) c FROM identity_binding_events').get() as any).c
const factAccountable = (db: any) => (db.prepare('SELECT accountable_ref FROM contribution_facts WHERE source_event_key=?').get(SEK) as any)?.accountable_ref
const CLAIM = { accountId: 'usr_alice', githubActorId: 'U_alice', sourceEventKey: SEK, challengeId: 'icc_1', proofVerified: true }

async function main(): Promise<void> {
  // 1) happy path — full credential-backed chain + matching actor → claimed
  { const db = freshDb(); seedChain(db); insChallenge(db)
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('happy: claimed (credential-backed)', r.ok && r.status === 'claimed', JSON.stringify(r))
    ok('happy: challenge consumed', chalStatus(db) === 'consumed')
    ok('happy: binding active → usr_alice', activeAcct(db) === 'usr_alice')
    ok('happy: contribution_facts.accountable_ref NOT mutated (overlay, NULL)', factAccountable(db) === null) }

  // proof gate
  { const db = freshDb(); seedChain(db); insChallenge(db)
    const r = await claimGithubIdentity({ ...CLAIM, proofVerified: false })
    ok('proof_not_verified → refused', !r.ok && r.reason === 'proof_not_verified', JSON.stringify(r))
    ok('proof_not_verified → challenge remains issued', chalStatus(db) === 'issued') }

  // ── Codex F2 P1: precondition must be GitHub credential-backed ──
  // A) source='governance' but executor_ref matches → refused; challenge issued
  { const db = freshDb(); insFact(db, { source: 'governance', executor_ref: 'github:U_alice' }); insChallenge(db)
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('governance fact (executor matches) → refused', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('governance fact → challenge remains issued', chalStatus(db) === 'issued') }
  // B) source='github' fact but NO github_fact_credentials link → refused; challenge issued
  { const db = freshDb(); insFact(db); insChallenge(db)   // fact only, no credential/link
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('github fact without credential link → refused', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('no-link → challenge remains issued', chalStatus(db) === 'issued') }
  // C) full link but credential.github_actor_id mismatches → refused; challenge issued
  { const db = freshDb(); insFact(db); insCred(db, { github_actor_id: 'U_other', credential_id: 'ghc_other', core_digest: 'dother' }); insLink(db, { credential_id: 'ghc_other' }); insChallenge(db)
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('credential.github_actor_id mismatch → refused', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('credential actor mismatch → challenge remains issued', chalStatus(db) === 'issued') }

  // 2) generic executor mismatch (fact exists, wrong executor) → actor_mismatch; challenge issued
  { const db = freshDb(); insFact(db, { executor_ref: 'github:U_other' }); insChallenge(db)
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('actor_mismatch → refused', !r.ok && r.reason === 'actor_mismatch', JSON.stringify(r))
    ok('actor_mismatch → challenge remains issued', chalStatus(db) === 'issued') }

  // 3) fact not found → refused; challenge issued
  { const db = freshDb(); insChallenge(db)
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('fact_not_found → refused', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('fact_not_found → challenge remains issued', chalStatus(db) === 'issued') }

  // 4) expired challenge → refused; row stays issued (engine does NOT mark expiry)
  { const db = freshDb(); seedChain(db); insChallenge(db, { expires_at: 'PAST' })
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('challenge_expired → refused', !r.ok && r.reason === 'challenge_expired', JSON.stringify(r))
    ok('challenge_expired → row stays issued', chalStatus(db) === 'issued') }

  // 5) already consumed → refused
  { const db = freshDb(); seedChain(db); insChallenge(db)
    db.prepare("UPDATE identity_claim_challenges SET status='consumed', consumed_at=datetime('now') WHERE challenge_id='icc_1'").run()
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('challenge_already_used → refused', !r.ok && r.reason === 'challenge_already_used', JSON.stringify(r)) }

  // 6) challenge account mismatch → refused; challenge issued
  { const db = freshDb(); seedChain(db); insChallenge(db, { account_id: 'usr_bob' })
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('account mismatch → challenge_not_found refused', !r.ok && r.reason === 'challenge_not_found', JSON.stringify(r))
    ok('account mismatch → challenge remains issued', chalStatus(db) === 'issued') }

  // 7) challenge source_event_key mismatch → refused; challenge issued
  { const db = freshDb(); seedChain(db); insChallenge(db, { source_event_key: 'github:R_webaz:PR_OTHER:merged' })
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('source mismatch → challenge_not_found refused', !r.ok && r.reason === 'challenge_not_found', JSON.stringify(r))
    ok('source mismatch → challenge remains issued', chalStatus(db) === 'issued') }

  // 8) already_bound_self → idempotent typed outcome, no new event, challenge consumed
  { const db = freshDb(); seedChain(db); insChallenge(db)
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    const before = eventCount(db)
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('already_bound_self → typed outcome', r.ok && r.status === 'already_bound_self', JSON.stringify(r))
    ok('already_bound_self → no new binding event', eventCount(db) === before)
    ok('already_bound_self → challenge consumed (idempotent)', chalStatus(db) === 'consumed') }

  // 9) already_bound_other → refused, challenge NOT consumed (rolled back)
  { const db = freshDb(); seedChain(db); insChallenge(db)
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_bob', proofMethod: 'github_publication_challenge' })
    const r = await claimGithubIdentity({ ...CLAIM })
    ok('already_bound_other → refused', !r.ok && r.reason === 'already_bound_other', JSON.stringify(r))
    ok('already_bound_other → challenge NOT consumed (issued)', chalStatus(db) === 'issued')
    ok('already_bound_other → binding unchanged (bob)', activeAcct(db) === 'usr_bob') }

  // 10) CAS success then binding failure → full rollback (challenge stays issued)
  { const db = freshDb(); seedChain(db); insChallenge(db)
    const origPrepare = db.prepare.bind(db)
    ;(db as any).prepare = (sql: string) => { if (/INSERT INTO identity_binding_events/.test(sql)) throw Object.assign(new Error('injected bind failure'), { code: 'INJECTED' }); return origPrepare(sql) }
    let threw = false
    try { await claimGithubIdentity({ ...CLAIM }) } catch { threw = true }
    ;(db as any).prepare = origPrepare
    ok('rollback: unexpected bind failure fails loud (rethrown)', threw)
    ok('rollback: challenge NOT consumed (issued)', chalStatus(db) === 'issued')
    ok('rollback: no binding created', activeAcct(db) === undefined) }

  console.log('\ntest:identity-claim-engine')
  console.log('──────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ claim engine: credential-backed precondition + CAS+bind one tx + typed outcomes + rollback leaves challenge issued + no accountable_ref mutation + proof gate\n')
}

main().catch(e => { console.error(e); process.exit(1) })
