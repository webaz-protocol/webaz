/**
 * PR-F3b — GitHub identity-claim challenge ISSUANCE engine (internal). Issues an identity_claim_challenges
 * row for an ACTIVE GitHub credential-backed contribution fact, and returns the proof marker the user
 * copies into a GitHub Gist. NO API/MCP/UI; does NOT verify the gist (F3a) or bind (F2/4a).
 *
 * Security:
 *   - Same trust root as F2: the fact must be GitHub credential-BACKED (assertGithubCredentialBackedFact)
 *     — not governance/in_protocol/transaction, not a github fact without a credential link, not a
 *     credential naming another actor.
 *   - If the actor is already actively bound: same account → already_bound_self (no new challenge);
 *     other account → refused already_bound_other (no challenge).
 *   - nonce / challenge_id / expires_at are ENGINE-generated (crypto random; never caller-supplied —
 *     the strict input rejects them). Only sha256(nonce) is stored; the plaintext nonce is returned ONLY
 *     inside the proof_marker (never persisted).
 *   - One synchronous db.transaction().immediate(); non-sqlite backend → fail-closed backend_unsupported.
 *   - Predictable failures are typed results; unexpected errors throw loud.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { seamBackendKind, seamSqliteHandle } from '../../layer0-foundation/L0-1-database/db.js'
import { sha256hex } from './github-credential/canonical.js'
import { assertGithubCredentialBackedFact } from './identity-claim-fact-precondition.js'
import { CLAIM_MARKER_PREFIX } from './identity-claim-proof-verifier.js'

const CHALLENGE_TTL = '+30 minutes'   // SQLite datetime modifier

// Strict input — accountId/githubActorId/sourceEventKey only; caller-supplied nonce/challengeId/
// expiresAt/unknown keys are rejected (engine generates those) → invalid_request.
const IssueArgs = z.strictObject({
  accountId: z.string().min(1),
  githubActorId: z.string().min(1),
  sourceEventKey: z.string().min(1),
})

export type IssueRefusal = 'already_bound_other' | 'fact_not_found' | 'actor_mismatch' | 'backend_unsupported' | 'db_busy' | 'invalid_request'
export type IssueResult =
  | { ok: true; status: 'issued'; challenge_id: string; expires_at: string; proof_marker: string }
  | { ok: true; status: 'already_bound_self'; github_actor_id: string; account_id: string }
  | { ok: false; status: 'refused'; reason: IssueRefusal; detail?: string }

const MAX_BUSY_RETRIES = 5
const BUSY_BACKOFF_MS = 25
const isSqliteBusy = (e: unknown): boolean => { const c = (e as { code?: string })?.code; return c === 'SQLITE_BUSY' || c === 'SQLITE_BUSY_SNAPSHOT' }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const refused = (reason: IssueRefusal, detail?: string): IssueResult => ({ ok: false, status: 'refused', reason, detail })

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function issueGithubIdentityClaimChallenge(args: unknown): Promise<IssueResult> {
  const parsed = IssueArgs.safeParse(args)
  if (!parsed.success) {
    const reasons = parsed.error.issues.map(i => i.code === 'unrecognized_keys' ? `unrecognized argument(s): ${(i as { keys?: string[] }).keys?.join(', ')}` : `${i.path.join('.') || '(args)'}: ${i.code}`)
    return refused('invalid_request', reasons.join('; '))
  }
  const { accountId, githubActorId, sourceEventKey } = parsed.data

  const kind = seamBackendKind()
  const db = seamSqliteHandle()
  if (kind !== 'sqlite' || db === null) return refused('backend_unsupported', `backend=${kind ?? 'uninitialized'}`)

  const txn = (db as any).transaction((): IssueResult => {
    // 1) credential-backed fact precondition (shared with F2). No write if it fails.
    const pre = assertGithubCredentialBackedFact(db, sourceEventKey, githubActorId)
    if (!pre.ok) return refused(pre.reason, pre.detail)

    // 2) already-bound state — never issue if the identity is already claimed.
    const active = db.prepare('SELECT account_id FROM identity_bindings_active WHERE github_actor_id = ?')
      .get(githubActorId) as { account_id: string } | undefined
    if (active) {
      if (active.account_id === accountId) return { ok: true, status: 'already_bound_self', github_actor_id: githubActorId, account_id: accountId }
      return refused('already_bound_other', 'github id is actively bound to a different account')
    }

    // 3) engine-generated, crypto-random nonce + id + expiry; store ONLY sha256(nonce).
    const nonce = randomBytes(32).toString('hex')          // 64 lowercase hex
    const challengeId = `icc_${randomBytes(20).toString('hex')}`   // icc_ + 40 hex
    const nonceHash = sha256hex(nonce)                     // 64 lowercase hex (matches the table CHECK)
    const expiresAt = (db.prepare(`SELECT datetime('now', ?) AS t`).get(CHALLENGE_TTL) as { t: string }).t
    db.prepare(`INSERT INTO identity_claim_challenges
      (challenge_id, account_id, github_actor_id, source_event_key, nonce_hash, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'issued', ?)`)
      .run(challengeId, accountId, githubActorId, sourceEventKey, nonceHash, expiresAt)
    // proof_marker carries the PLAINTEXT nonce (returned to caller, never persisted); prefix imported from
    // the F3a verifier so the two never drift.
    const proofMarker = `${CLAIM_MARKER_PREFIX}${challengeId}:${nonce}`
    return { ok: true, status: 'issued', challenge_id: challengeId, expires_at: expiresAt, proof_marker: proofMarker }
  })

  for (let attempt = 0; ; attempt++) {
    try {
      return txn.immediate()
    } catch (err) {
      if (isSqliteBusy(err) && attempt < MAX_BUSY_RETRIES) { await sleep(BUSY_BACKOFF_MS * (attempt + 1)); continue }
      if (isSqliteBusy(err)) return refused('db_busy', `busy after ${MAX_BUSY_RETRIES} retries`)
      throw err
    }
  }
}

// ── READ-ONLY: fetch the verification inputs the F3c API needs before it calls the F3a verifier ──
// The API never embeds SQL against a core table (iron-rule rule4) and never holds the nonce plaintext:
// it only needs the stored `nonce_hash` (the F3a `expectedNonceHash`) for a challenge that is ISSUED,
// not expired, and owned by THIS (account, actor, source). Seam-based + read-only like the engines, so a
// non-sqlite backend fails closed. This is ADVISORY (lets the API reject early / avoid a pointless GitHub
// fetch); the AUTHORITATIVE single-use consume is still the CAS inside the F2 claim engine, so a
// race here can never double-spend a challenge.
const LookupArgs = z.strictObject({
  challengeId: z.string().min(1),
  accountId: z.string().min(1),
  githubActorId: z.string().min(1),
  sourceEventKey: z.string().min(1),
})

export type ChallengeLookupReason = 'challenge_not_found' | 'challenge_expired' | 'challenge_already_used' | 'backend_unsupported' | 'invalid_request'
export type ChallengeLookupResult =
  | { ok: true; nonceHash: string }
  | { ok: false; reason: ChallengeLookupReason }

export function getIssuedChallengeForVerification(args: unknown): ChallengeLookupResult {
  const parsed = LookupArgs.safeParse(args)
  if (!parsed.success) return { ok: false, reason: 'invalid_request' }
  const { challengeId, accountId, githubActorId, sourceEventKey } = parsed.data

  const kind = seamBackendKind()
  const db = seamSqliteHandle()
  if (kind !== 'sqlite' || db === null) return { ok: false, reason: 'backend_unsupported' }

  // Bind ownership in the WHERE clause: a row for another account/actor/source is reported as not-found
  // (no information about challenges the caller doesn't own).
  const row = (db as any).prepare(`SELECT status, nonce_hash, (expires_at > datetime('now')) AS not_expired
    FROM identity_claim_challenges
    WHERE challenge_id = ? AND account_id = ? AND github_actor_id = ? AND source_event_key = ?`)
    .get(challengeId, accountId, githubActorId, sourceEventKey) as
    { status: string; nonce_hash: string; not_expired: number } | undefined
  if (!row) return { ok: false, reason: 'challenge_not_found' }
  if (row.status === 'consumed') return { ok: false, reason: 'challenge_already_used' }
  if (row.status !== 'issued' || row.not_expired !== 1) return { ok: false, reason: 'challenge_expired' }
  return { ok: true, nonceHash: row.nonce_hash }
}
