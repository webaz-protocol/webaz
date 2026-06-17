#!/usr/bin/env tsx
/**
 * PR-F3b — identity-claim challenge ISSUANCE engine tests (fresh in-memory DB; no network).
 *   用法:npm run test:identity-claim-challenge-engine
 *
 * Verifies: credential-backed precondition (shared with F2); already-bound gating; engine-generated
 * crypto nonce/id/expiry; only sha256(nonce) stored (no plaintext); strict input (caller nonce/id/expiry
 * rejected); typed outcomes; marker matches the F3a verifier (round-trip); writes no bindings.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb, setSeamBackend } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initIdentityClaimChallengeSchema } from '../src/layer2-business/L2-9-contribution/identity-claim-challenge-store.js'
import { bindGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'
import { issueGithubIdentityClaimChallenge } from '../src/layer2-business/L2-9-contribution/identity-claim-challenge-engine.js'
import { verifyGithubGistProof, CLAIM_MARKER_PREFIX } from '../src/layer2-business/L2-9-contribution/identity-claim-proof-verifier.js'
import { sha256hex } from '../src/layer2-business/L2-9-contribution/github-credential/canonical.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const SEK = 'github:R_webaz:PR_1:merged'
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
const seedChain = (db: any) => { insFact(db); insCred(db); insLink(db) }
const chalCount = (db: any) => (db.prepare('SELECT COUNT(*) c FROM identity_claim_challenges').get() as any).c
const bindingCount = (db: any) => (db.prepare('SELECT COUNT(*) c FROM identity_binding_events').get() as any).c + (db.prepare('SELECT COUNT(*) c FROM identity_bindings_active').get() as any).c
const ISSUE = { accountId: 'usr_alice', githubActorId: 'U_alice', sourceEventKey: SEK }

async function main(): Promise<void> {
  // 1) happy path — full credential-backed chain → issued
  { const db = freshDb(); seedChain(db)
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('happy: issued', r.ok && r.status === 'issued', JSON.stringify(r))
    if (r.ok && r.status === 'issued') {
      ok('happy: challenge_id format icc_<40hex>', /^icc_[0-9a-f]{40}$/.test(r.challenge_id))
      ok('happy: proof_marker starts with F3a prefix', r.proof_marker.startsWith(CLAIM_MARKER_PREFIX))
      const prefix = `${CLAIM_MARKER_PREFIX}${r.challenge_id}:`
      const nonce = r.proof_marker.slice(prefix.length)
      ok('happy: nonce is 64-char lowercase hex', /^[0-9a-f]{64}$/.test(nonce))
      const row = db.prepare('SELECT status, nonce_hash FROM identity_claim_challenges WHERE challenge_id=?').get(r.challenge_id) as any
      ok('happy: DB row status=issued', row.status === 'issued')
      ok('happy: stored nonce_hash = sha256(nonce in marker)', row.nonce_hash === sha256hex(nonce))
      ok('happy: nonce_hash is 64 lowercase hex', /^[0-9a-f]{64}$/.test(row.nonce_hash))
      const dump = JSON.stringify(db.prepare('SELECT * FROM identity_claim_challenges').all())
      ok('happy: plaintext nonce NOT in DB', !dump.includes(nonce))
      ok('happy: no bindings written', bindingCount(db) === 0)
      // round-trip: F3a verifier accepts a gist (owner=actor) containing this marker, with the stored hash
      const orig = globalThis.fetch
      globalThis.fetch = (async () => ({ status: 200, ok: true, redirected: false, type: 'default', headers: { get: () => null }, json: async () => ({ owner: { id: 'U_alice' }, files: { 'p.txt': { content: r.proof_marker, truncated: false } } }), text: async () => '' })) as any
      try {
        const v = await verifyGithubGistProof({ gistId: 'g1', githubActorId: 'U_alice', challengeId: r.challenge_id, expectedNonceHash: row.nonce_hash })
        ok('round-trip: F3a verifier verifies the issued marker', v.ok === true, JSON.stringify(v))
      } finally { globalThis.fetch = orig }
    } }

  // 2) governance fact (executor matches) → refused, zero challenge
  { const db = freshDb(); insFact(db, { source: 'governance', executor_ref: 'github:U_alice' })
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('governance fact → refused fact_not_found', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('governance → zero challenge', chalCount(db) === 0) }

  // 3) github fact, no credential link → refused, zero
  { const db = freshDb(); insFact(db)
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('no link → refused fact_not_found', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('no link → zero challenge', chalCount(db) === 0) }

  // 4) credential.github_actor_id mismatch → refused, zero
  { const db = freshDb(); insFact(db); insCred(db, { github_actor_id: 'U_other', credential_id: 'ghc_other', core_digest: 'do' }); insLink(db, { credential_id: 'ghc_other' })
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('credential actor mismatch → refused', !r.ok && r.reason === 'fact_not_found', JSON.stringify(r))
    ok('credential actor mismatch → zero challenge', chalCount(db) === 0) }

  // 5) fact executor_ref mismatch → actor_mismatch, zero
  { const db = freshDb(); insFact(db, { executor_ref: 'github:U_other' })
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('executor mismatch → actor_mismatch', !r.ok && r.reason === 'actor_mismatch', JSON.stringify(r))
    ok('executor mismatch → zero challenge', chalCount(db) === 0) }

  // 6) already_bound_self → typed outcome, no new challenge
  { const db = freshDb(); seedChain(db)
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('already_bound_self → typed outcome', r.ok && r.status === 'already_bound_self', JSON.stringify(r))
    ok('already_bound_self → no challenge issued', chalCount(db) === 0) }

  // 7) already_bound_other → refused, no challenge
  { const db = freshDb(); seedChain(db)
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_bob', proofMethod: 'github_publication_challenge' })
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('already_bound_other → refused', !r.ok && r.reason === 'already_bound_other', JSON.stringify(r))
    ok('already_bound_other → no challenge issued', chalCount(db) === 0) }

  // 8) caller-supplied nonce/challengeId/expiresAt/unknown → invalid_request, zero DB write
  for (const [name, extra] of [
    ['nonce', { nonce: 'x'.repeat(64) }], ['challengeId', { challengeId: 'icc_evil' }],
    ['expiresAt', { expiresAt: '2999-01-01' }], ['unknown', { foo: 1 }],
  ] as Array<[string, any]>) {
    const db = freshDb(); seedChain(db)
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE, ...extra })
    ok(`strict: caller ${name} → invalid_request`, !r.ok && r.reason === 'invalid_request', JSON.stringify(r))
    ok(`strict: caller ${name} → zero DB write`, chalCount(db) === 0)
  }

  // 9) missing account / invalid input → typed refusal
  { const db = freshDb(); seedChain(db)
    const r = await issueGithubIdentityClaimChallenge({ githubActorId: 'U_alice', sourceEventKey: SEK } as any)
    ok('missing accountId → invalid_request', !r.ok && r.reason === 'invalid_request', JSON.stringify(r))
    ok('missing accountId → zero DB', chalCount(db) === 0) }

  // 10) backend unsupported → typed refusal
  { const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
    setSeamBackend({ kind: 'pg', one: async () => undefined, all: async () => [], run: async () => ({ changes: 0, lastInsertRowid: 0 }) })
    const r = await issueGithubIdentityClaimChallenge({ ...ISSUE })
    ok('PG backend → backend_unsupported', !r.ok && r.reason === 'backend_unsupported', JSON.stringify(r))
    db.close() }

  // 13) issuance engine source: no proof-verifier call, no claim-engine call, no binding writes
  { const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'layer2-business', 'L2-9-contribution', 'identity-claim-challenge-engine.ts'), 'utf8')
    ok('source: does NOT call verifyGithubGistProof', !/verifyGithubGistProof\s*\(/.test(src))
    ok('source: does NOT call claimGithubIdentity', !/claimGithubIdentity\s*\(/.test(src))
    ok('source: no write to identity_binding_events/active', !/(INSERT|UPDATE|DELETE)\b[^;]*identity_binding/i.test(src)) }

  console.log('\ntest:identity-claim-challenge-engine')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ issuance engine: credential-backed precondition + already-bound gating + crypto nonce (hash-only) + strict input + typed outcomes + F3a marker round-trip + no bindings\n')
}

main().catch(e => { console.error(e); process.exit(1) })
