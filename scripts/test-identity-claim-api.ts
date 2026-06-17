#!/usr/bin/env tsx
/**
 * PR-F3c — minimal GitHub identity-claim API route tests (real express app on an ephemeral port; API
 * calls go via node:http so globalThis.fetch stays free to stub the F3a gist re-fetch). No real network.
 *   用法:npm run test:identity-claim-api
 *
 * Verifies the closed loop AND its boundaries: login required; accountId never from body; trusted GitHub
 * token only from server config (fail-closed when absent, without burning the human gate token); the
 * one-time WebAuthn gate token must be bound to THIS claim tuple (purpose/replay/expiry); challenge
 * ownership confirmed BEFORE any network call (verifier not even called); verifier failure does NOT
 * consume the challenge; strict input rejects expectedNonceHash/proofVerified/accountId/nonce; no
 * token/nonce_hash leak in responses; the route source has no direct core-table writes; registered
 * before the SPA fallback.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initIdentityClaimChallengeSchema } from '../src/layer2-business/L2-9-contribution/identity-claim-challenge-store.js'
import { bindGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'
import { createHumanPresence } from '../src/pwa/human-presence.js'
import { registerContributionIdentityRoutes } from '../src/pwa/routes/contribution-identity.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const SEK = 'github:R_webaz:PR_1:merged'
const ACTOR = 'U_alice'
const ALICE = 'usr_alice'
const BOB = 'usr_bob'
const TRUSTED_TOKEN = 'ghp_FAKEtrustedreadtoken_not_a_real_secret'   // FAKE sentinel — never a real token (rule7)

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── server-config + gist transport, both mutable per case ──
let configuredToken: string | undefined = TRUSTED_TOKEN
let hpParam = 1                                       // require_human_presence_for_identity_claim
let fetchCalls = 0
let gist: { ownerId: string | null; content: string | null; truncated?: boolean; status?: number } = { ownerId: ACTOR, content: null }

function stubFetch(): void {
  globalThis.fetch = (async (url: string) => {
    fetchCalls++
    if (!String(url).startsWith('https://api.github.com/')) throw new Error(`refused off-origin fetch: ${url}`)
    const status = gist.status ?? 200
    const body: any = { truncated: gist.truncated === true, files: {} }
    if (gist.ownerId !== null) body.owner = { id: gist.ownerId }
    if (gist.content !== null) body.files['proof.txt'] = { content: gist.content, truncated: false }
    return { status, ok: status >= 200 && status < 300, redirected: false, type: 'default', headers: { get: () => null }, json: async () => body, text: async () => '' }
  }) as any
}

function freshDb(): any {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','c','ka'),('usr_bob','Bob','c','kb')`).run()
  db.exec(`CREATE TABLE webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)`)
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  initIdentityClaimChallengeSchema(db)
  // credential-backed chain (fact ⋈ link ⋈ credential), the trust root for issue + claim
  db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status) VALUES ('cfact_1',?,'github',NULL,'m','t',?,NULL,'unknown','active')`).run(SEK, `github:${ACTOR}`)
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES ('ghc_alice','d1','2',?,'R','P',1,'m','t',?,'merged','{}')`).run(SEK, ACTOR)
  db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES ('cfact_1','ghc_alice',?)`).run(SEK)
  setSeamDb(db)
  return db
}

let db: any
// identity_binding_events is append-only (DELETE forbidden), so per-case isolation uses a FRESH in-memory
// DB rather than clearing tables. The route's engines read the seam (setSeamDb in freshDb) and the
// human-presence dep is rebuilt per call from the current `db` (below), so everything tracks one DB.
const resetState = (): void => {
  db = freshDb()
  configuredToken = TRUSTED_TOKEN; hpParam = 1; fetchCalls = 0; gist = { ownerId: ACTOR, content: null }
}

const chalCount = (): number => (db.prepare('SELECT COUNT(*) c FROM identity_claim_challenges').get() as any).c
const issuedCount = (): number => (db.prepare(`SELECT COUNT(*) c FROM identity_claim_challenges WHERE status='issued'`).get() as any).c
const bindingCount = (): number => (db.prepare('SELECT COUNT(*) c FROM identity_bindings_active').get() as any).c
const tokenConsumed = (id: string): boolean => !!(db.prepare('SELECT consumed_at FROM webauthn_gate_tokens WHERE id=?').get(id) as any)?.consumed_at

function mintGateToken(opts: { id: string; userId: string; purpose?: string; data?: any; expiresOffset?: string }): string {
  const purpose = opts.purpose ?? 'identity_claim'
  const exp = (db.prepare(`SELECT datetime('now', ?) t`).get(opts.expiresOffset ?? '+60 seconds') as any).t
  db.prepare(`INSERT INTO webauthn_gate_tokens (id,user_id,purpose,purpose_data,expires_at,consumed_at) VALUES (?,?,?,?,?,NULL)`)
    .run(opts.id, opts.userId, purpose, opts.data ? JSON.stringify(opts.data) : null, exp)
  return opts.id
}

// ── HTTP plumbing: API requests via node:http (NOT fetch, which is the gist stub) ──
let server: Server
let port = 0
function api(path: string, body: any, userId?: string): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {})
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (userId) headers['x-test-user'] = userId
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers }, (res) => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j, raw }) })
    })
    req.on('error', reject); req.write(payload); req.end()
  })
}

const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => {
  res.status(status).json({ error: message, error_code: code, ...(extra || {}) })
}

async function main(): Promise<void> {
  db = freshDb()
  stubFetch()
  const getParam = (<T,>(_k: string, fb: T): T => (hpParam as unknown as T) ?? fb) as any

  const app = express()
  app.use(express.json())
  registerContributionIdentityRoutes(app, {
    auth: (req, res) => { const u = (req.headers['x-test-user'] as string) || ''; if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } },
    // rebuilt per call from the CURRENT db (fresh per case) so it tracks the seam
    requireHumanPresence: ((uid: string, p: any, t: any, k: any, v: any) => createHumanPresence(db, getParam).requireHumanPresence(uid, p, t, k, v)) as any,
    errorRes,
    getGithubReadToken: () => configuredToken,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))

  const CHAL = '/api/contribution-identity/github/claim-challenge'
  const DONE = '/api/contribution-identity/github/claim-complete'

  // helper: issue a real challenge as alice and return { challenge_id, proof_marker }
  async function issueChallenge(): Promise<{ challenge_id: string; proof_marker: string }> {
    const r = await api(CHAL, { source_event_key: SEK, github_actor_id: ACTOR }, ALICE)
    return { challenge_id: r.json.challenge_id, proof_marker: r.json.proof_marker }
  }

  // 1) challenge happy path — only nonce_hash stored, no plaintext nonce
  { resetState()
    const r = await api(CHAL, { source_event_key: SEK, github_actor_id: ACTOR }, ALICE)
    ok('1 challenge happy: 200 issued', r.status === 200 && r.json.status === 'issued', r.raw)
    ok('1 challenge happy: has challenge_id/expires_at/proof_marker', !!r.json.challenge_id && !!r.json.expires_at && !!r.json.proof_marker)
    ok('1 challenge happy: response has NO nonce_hash', !('nonce_hash' in (r.json || {})) && !r.raw.includes('nonce_hash'))
    const prefix = r.json.proof_marker.slice(0, r.json.proof_marker.lastIndexOf(':') + 1)
    const nonce = r.json.proof_marker.slice(prefix.length)
    const dump = JSON.stringify(db.prepare('SELECT * FROM identity_claim_challenges').all())
    ok('1 challenge happy: plaintext nonce NOT in DB', nonce.length === 64 && !dump.includes(nonce)) }

  // 2) challenge not logged in → 401; logged-in with extra account_id field → strict 400 (no bypass)
  { resetState()
    const r401 = await api(CHAL, { source_event_key: SEK, github_actor_id: ACTOR })
    ok('2 challenge no-auth → 401', r401.status === 401, r401.raw)
    ok('2 challenge no-auth → no challenge written', chalCount() === 0)
    const rInject = await api(CHAL, { source_event_key: SEK, github_actor_id: ACTOR, account_id: BOB } as any, ALICE)
    ok('2 challenge body account_id → strict 400 (cannot inject accountId)', rInject.status === 400 && rInject.json.error_code === 'INVALID_REQUEST', rInject.raw)
    ok('2 challenge inject → no challenge written', chalCount() === 0) }

  // 3) challenge for a non-credential-backed fact → refused, no challenge written
  { resetState()
    const r = await api(CHAL, { source_event_key: 'github:NOPE:PR_9:merged', github_actor_id: ACTOR }, ALICE)
    ok('3 challenge non-backed fact → 404 FACT_NOT_CLAIMABLE', r.status === 404 && r.json.error_code === 'FACT_NOT_CLAIMABLE', r.raw)
    ok('3 challenge non-backed → no challenge written', chalCount() === 0) }

  // 4) complete happy path — human token bound + gist proof ok → claimed; consumed; binding active
  { resetState()
    const { challenge_id, proof_marker } = await issueChallenge()
    gist = { ownerId: ACTOR, content: `please verify ${proof_marker} thanks` }
    mintGateToken({ id: 'tok_ok', userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_ok' }, ALICE)
    ok('4 complete happy: 200 claimed', r.status === 200 && r.json.status === 'claimed', r.raw)
    ok('4 complete happy: returns github_actor_id + challenge_id', r.json.github_actor_id === ACTOR && r.json.challenge_id === challenge_id)
    ok('4 complete happy: verifier was called (gist re-fetched)', fetchCalls === before + 1)
    ok('4 complete happy: challenge consumed', issuedCount() === 0)
    ok('4 complete happy: binding active for alice', bindingCount() === 1)
    ok('4 complete happy: no token/nonce_hash leak', !r.raw.includes(TRUSTED_TOKEN) && !r.raw.includes('nonce_hash')) }

  // 5) complete verifier failures → refused; challenge stays issued; no binding; verifier WAS called
  for (const [name, mut] of [
    ['owner_mismatch', () => { gist.ownerId = 'U_evil' }],
    ['proof_not_found', () => { gist.content = 'no marker here' }],
    ['nonce_mismatch', (marker: string) => { gist.content = marker.slice(0, marker.lastIndexOf(':') + 1) + 'deadbeef' }],
  ] as Array<[string, (m: string) => void]>) {
    resetState()
    const { challenge_id, proof_marker } = await issueChallenge()
    gist = { ownerId: ACTOR, content: proof_marker }
    mut(proof_marker)
    mintGateToken({ id: `tok_${name}`, userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: `tok_${name}` }, ALICE)
    ok(`5 verifier ${name} → 422 PROOF_REJECTED`, r.status === 422 && r.json.error_code === 'PROOF_REJECTED', r.raw)
    ok(`5 verifier ${name} → verifier was called`, fetchCalls === before + 1)
    ok(`5 verifier ${name} → challenge STILL issued (not consumed)`, issuedCount() === 1)
    ok(`5 verifier ${name} → no binding`, bindingCount() === 0)
  }

  // 6) human-presence failures (missing / wrong-purpose / replay / expired) → refused; challenge issued; no binding
  // 6a missing token → strict 400 (webauthn_token required)
  { resetState(); const { challenge_id } = await issueChallenge()
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1' } as any, ALICE)
    ok('6a missing token → 400', r.status === 400 && r.json.error_code === 'INVALID_REQUEST', r.raw)
    ok('6a missing token → challenge issued, no binding', issuedCount() === 1 && bindingCount() === 0) }
  // 6b wrong purpose → 412
  { resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_wp', userId: ALICE, purpose: 'delete_passkey', data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_wp' }, ALICE)
    ok('6b wrong purpose → 412 HUMAN_PRESENCE_REQUIRED', r.status === 412 && r.json.error_code === 'HUMAN_PRESENCE_REQUIRED', r.raw)
    ok('6b wrong purpose → verifier NOT called', fetchCalls === before)
    ok('6b wrong purpose → challenge issued, no binding', issuedCount() === 1 && bindingCount() === 0) }
  // 6c token bound to a DIFFERENT challenge tuple → purpose_data validate fails → 412
  { resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_mismatch', userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id: 'icc_other' } })
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_mismatch' }, ALICE)
    ok('6c token bound to other challenge → 412', r.status === 412 && r.json.error_code === 'HUMAN_PRESENCE_REQUIRED', r.raw)
    ok('6c → challenge issued, no binding', issuedCount() === 1 && bindingCount() === 0) }
  // 6d replay → second use of a consumed token → 412
  { resetState(); const { challenge_id } = await issueChallenge()
    gist = { ownerId: ACTOR, content: 'no marker' }   // verifier fails AFTER the gate consumes the token
    mintGateToken({ id: 'tok_replay', userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    const r1 = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_replay' }, ALICE)
    ok('6d first use consumed token but proof failed → 422', r1.status === 422, r1.raw)
    ok('6d token now consumed', tokenConsumed('tok_replay'))
    const r2 = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_replay' }, ALICE)
    ok('6d replay → 412', r2.status === 412 && r2.json.error_code === 'HUMAN_PRESENCE_REQUIRED', r2.raw)
    ok('6d replay → challenge still issued, no binding', issuedCount() === 1 && bindingCount() === 0) }
  // 6e expired token → 412
  { resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_exp', userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id }, expiresOffset: '-60 seconds' })
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_exp' }, ALICE)
    ok('6e expired token → 412', r.status === 412 && r.json.error_code === 'HUMAN_PRESENCE_REQUIRED', r.raw)
    ok('6e expired → challenge issued, no binding', issuedCount() === 1 && bindingCount() === 0) }

  // 7) challenge not owned by current user / actor / source mismatch → refused; verifier NOT called; not consumed
  // 7a different user (bob completing alice's challenge), bob's token bound to the tuple
  { resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_bob', userId: BOB, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_bob' }, BOB)
    ok('7a other user → 404 CHALLENGE_NOT_FOUND', r.status === 404 && r.json.error_code === 'CHALLENGE_NOT_FOUND', r.raw)
    ok('7a other user → verifier NOT called', fetchCalls === before)
    ok('7a other user → challenge still issued, no binding', issuedCount() === 1 && bindingCount() === 0) }
  // 7b actor mismatch (token bound to the request's mismatched actor so the gate passes; read finds nothing)
  { resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_am', userId: ALICE, data: { github_actor_id: 'U_evil', source_event_key: SEK, challenge_id } })
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: 'U_evil', challenge_id, gist_id: 'g1', webauthn_token: 'tok_am' }, ALICE)
    ok('7b actor mismatch → 404 CHALLENGE_NOT_FOUND', r.status === 404 && r.json.error_code === 'CHALLENGE_NOT_FOUND', r.raw)
    ok('7b actor mismatch → verifier NOT called', fetchCalls === before)
    ok('7b actor mismatch → not consumed', issuedCount() === 1 && bindingCount() === 0) }

  // 8) caller passes expectedNonceHash / proofVerified / accountId / nonce → strict 400, verifier not called, not consumed
  for (const extra of [{ expectedNonceHash: 'a'.repeat(64) }, { proofVerified: true }, { accountId: BOB }, { nonce: 'x'.repeat(64) }]) {
    resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_strict', userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_strict', ...extra } as any, ALICE)
    ok(`8 strict reject ${Object.keys(extra)[0]} → 400`, r.status === 400 && r.json.error_code === 'INVALID_REQUEST', r.raw)
    ok(`8 strict ${Object.keys(extra)[0]} → verifier not called, not consumed`, fetchCalls === before && issuedCount() === 1 && bindingCount() === 0)
  }

  // 9) trusted GitHub token NOT configured → completion fails closed, WITHOUT burning the gate token or consuming
  { resetState(); const { challenge_id, proof_marker } = await issueChallenge(); gist = { ownerId: ACTOR, content: proof_marker }
    mintGateToken({ id: 'tok_cfg', userId: ALICE, data: { github_actor_id: ACTOR, source_event_key: SEK, challenge_id } })
    configuredToken = undefined
    const before = fetchCalls
    const r = await api(DONE, { source_event_key: SEK, github_actor_id: ACTOR, challenge_id, gist_id: 'g1', webauthn_token: 'tok_cfg' }, ALICE)
    ok('9 token unconfigured → 503 GITHUB_READ_NOT_CONFIGURED', r.status === 503 && r.json.error_code === 'GITHUB_READ_NOT_CONFIGURED', r.raw)
    ok('9 unconfigured → verifier NOT called', fetchCalls === before)
    ok('9 unconfigured → gate token NOT burned (config checked first)', !tokenConsumed('tok_cfg'))
    ok('9 unconfigured → challenge still issued, no binding', issuedCount() === 1 && bindingCount() === 0) }

  // 10) already-bound: challenge endpoint reports already_bound_self / _other via API
  { resetState(); await bindGithubIdentity({ githubActorId: ACTOR, accountId: ALICE, proofMethod: 'github_publication_challenge' })
    const rSelf = await api(CHAL, { source_event_key: SEK, github_actor_id: ACTOR }, ALICE)
    ok('10 already_bound_self → 200 typed', rSelf.status === 200 && rSelf.json.status === 'already_bound_self', rSelf.raw)
    const rOther = await api(CHAL, { source_event_key: SEK, github_actor_id: ACTOR }, BOB)
    ok('10 already_bound_other → 409 ALREADY_BOUND', rOther.status === 409 && rOther.json.error_code === 'ALREADY_BOUND', rOther.raw)
    ok('10 already-bound → no challenge written', chalCount() === 0) }

  // 11) route SOURCE: no db handle, no direct core-table writes (iron-rule rule4 spirit)
  { const src = readFileSync(join(HERE, '..', 'src', 'pwa', 'routes', 'contribution-identity.ts'), 'utf8')
    ok('11 route uses session user.id (never body accountId)', /accountId:\s*user\.id|accountId:\s*userId/.test(src))
    ok('11 route has no db.prepare/db.exec', !/db\.(prepare|exec)\s*\(/.test(src))
    ok('11 route no write to identity core tables', !/(INSERT|UPDATE|DELETE|REPLACE)\b[^;]*(identity_claim_challenges|identity_binding|contribution_facts)/i.test(src))
    ok('11 route never reads token from body', !/req\.body[^\n]*token[^\n]*github|getGithubReadToken[^\n]*req\.body/i.test(src)) }

  // 12) registered after auth middleware, before SPA fallback (server.ts source order)
  { const srv = readFileSync(join(HERE, '..', 'src', 'pwa', 'server.ts'), 'utf8')
    const reg = srv.indexOf('registerContributionIdentityRoutes(app')
    const spa = srv.indexOf("res.sendFile(path.join(__dirname, 'public', 'index.html'))")
    ok('12 route registered in server.ts', reg > -1)
    ok('12 registered before SPA fallback', reg > -1 && spa > -1 && reg < spa) }

  await new Promise<void>(r => server.close(() => r()))

  console.log('\ntest:identity-claim-api')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ F3c API: login-gated + accountId from session + trusted-token fail-closed + Passkey gate bound to claim tuple + ownership-before-verify + verifier-fail keeps challenge + strict input + no token/nonce leak + registered before SPA\n')
}

main().catch(e => { console.error(e); process.exit(1) })
