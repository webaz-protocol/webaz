/**
 * PR-F2 — GitHub identity claim engine (NO API). Consumes an issued publication challenge and binds the
 * GitHub actor → WebAZ account, in ONE synchronous transaction. Design: docs/IDENTITY-CLAIM-DESIGN.md.
 *
 * Trust boundary (F2 vs F3): F2 takes `proofVerified: true` — the publication proof (gist via the #295
 * authenticated read) is F3's job. F2 REFUSES (proof_not_verified) if the flag is not explicitly true,
 * so an un-verified proof can never complete a binding. No API/MCP/UI, no GitHub fetch here.
 *
 * Binding granularity is IDENTITY-level: `github_actor_id → account_id` (the stable actor id, NEVER the
 * renameable login). The fact/source_event_key is only a PRECONDITION GUARD ("this GitHub actor has a
 * claimable contribution"): the fact must exist and its executor must be this github_actor_id.
 *
 * Atomicity (Codex F2): challenge consume (CAS) + bind run in ONE synchronous `db.transaction().immediate()`.
 * The fact/actor precondition is checked BEFORE the CAS, so a doomed claim never consumes the challenge.
 * The CAS requires status='issued' AND not expired AND account/github/source all match → changes=1. If the
 * bind then refuses (already_bound_to_other) or anything throws, the whole tx ROLLS BACK — the challenge is
 * NOT left consumed. No async/await inside the transaction. proof_method is always
 * 'github_publication_challenge' (never the governance/manual override path). visibility defaults 'private'.
 */
import { seamBackendKind, seamSqliteHandle } from '../../layer0-foundation/L0-1-database/db.js'
import { bindGithubIdentityCore } from './identity-binding-engine.js'
import { assertGithubCredentialBackedFact } from './identity-claim-fact-precondition.js'

export interface ClaimInput {
  accountId: string          // the WebAZ account performing the claim (the caller/session in F3)
  githubActorId: string      // stable GitHub actor id being claimed
  sourceEventKey: string     // the contribution fact's source event the challenge was issued for
  challengeId: string        // the issued challenge to consume
  proofVerified: boolean     // F2 trusts a PRE-VERIFIED publication proof (F3 sets this); false → refused
}

export type ClaimStatus = 'claimed' | 'already_bound_self'
export type ClaimRefusal =
  | 'proof_not_verified'
  | 'backend_unsupported'
  | 'db_busy'
  | 'fact_not_found'
  | 'actor_mismatch'
  | 'challenge_not_found'
  | 'challenge_expired'
  | 'challenge_already_used'
  | 'already_bound_other'
  | 'invariant_violation'

export type ClaimResult =
  | { ok: true; status: ClaimStatus; github_actor_id: string; account_id: string; challenge_id: string }
  | { ok: false; status: 'refused'; reason: ClaimRefusal; detail?: string }

const MAX_BUSY_RETRIES = 5
const BUSY_BACKOFF_MS = 25
const isSqliteBusy = (e: unknown): boolean => {
  const c = (e as { code?: string })?.code
  return c === 'SQLITE_BUSY' || c === 'SQLITE_BUSY_SNAPSHOT'
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const refused = (reason: ClaimRefusal, detail?: string): ClaimResult => ({ ok: false, status: 'refused', reason, detail })

// Sentinel thrown inside the tx to ROLL BACK a consumed challenge (e.g. bind refused) — caught outside.
class ClaimRollback extends Error { constructor(public readonly outcome: ClaimResult) { super('claim rollback') } }

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function claimGithubIdentity(input: ClaimInput): Promise<ClaimResult> {
  const { accountId, githubActorId, sourceEventKey, challengeId } = input
  if (!accountId || !githubActorId || !sourceEventKey || !challengeId) {
    return refused('invariant_violation', 'accountId, githubActorId, sourceEventKey, challengeId are required')
  }
  // Proof gate — F2 only completes a binding for a PRE-VERIFIED proof (F3 verifies the gist).
  if (input.proofVerified !== true) return refused('proof_not_verified', 'publication proof is not verified (F3 must verify before F2 binds)')

  const kind = seamBackendKind()
  const db = seamSqliteHandle()
  if (kind !== 'sqlite' || db === null) return refused('backend_unsupported', `backend=${kind ?? 'uninitialized'}`)

  const txn = (db as any).transaction((): ClaimResult => {
    // 1) precondition (BEFORE the CAS, so a doomed claim leaves the challenge ISSUED): the fact must be a
    //    GitHub credential-BACKED active fact whose AUTHENTICATED credential names this actor (Codex F2 P1).
    //    Shared with the F3b issuance engine via assertGithubCredentialBackedFact (behavior-zero).
    const pre = assertGithubCredentialBackedFact(db, sourceEventKey, githubActorId)
    if (!pre.ok) return refused(pre.reason, pre.detail)

    // 2) CAS consume the issued challenge (single-use; all of account/github/source must match).
    const cas = db.prepare(`UPDATE identity_claim_challenges
      SET status = 'consumed', consumed_at = datetime('now')
      WHERE challenge_id = ? AND status = 'issued' AND expires_at > datetime('now')
        AND account_id = ? AND github_actor_id = ? AND source_event_key = ?`)
      .run(challengeId, accountId, githubActorId, sourceEventKey)
    if (cas.changes !== 1) {
      // 0 changes → no write happened; determine WHY (commit is a no-op, challenge state untouched).
      const row = db.prepare(`SELECT status, (expires_at > datetime('now')) AS not_expired, account_id, github_actor_id, source_event_key
        FROM identity_claim_challenges WHERE challenge_id = ?`).get(challengeId) as
        { status: string; not_expired: number; account_id: string; github_actor_id: string; source_event_key: string } | undefined
      if (!row) return refused('challenge_not_found')
      if (row.status === 'consumed') return refused('challenge_already_used')
      if (row.status === 'expired' || row.status === 'revoked') return refused('challenge_expired')
      if (row.status === 'issued' && row.not_expired !== 1) return refused('challenge_expired')
      // issued + not expired but account/github/source didn't match this claim → no matching challenge.
      if (row.account_id !== accountId || row.github_actor_id !== githubActorId || row.source_event_key !== sourceEventKey) return refused('challenge_not_found')
      return refused('invariant_violation', 'challenge CAS matched 0 rows for an otherwise-valid challenge')
    }

    // 3) bind (challenge now consumed in THIS tx). bound→claimed; already_bound(self)→commit idempotently;
    //    already_bound_to_other / unexpected → THROW to roll back the consumed challenge.
    const b = bindGithubIdentityCore(db, { githubActorId, accountId, proofMethod: 'github_publication_challenge', proofRef: challengeId, visibility: 'private' })
    if (b.ok && b.status === 'bound') return { ok: true, status: 'claimed', github_actor_id: githubActorId, account_id: accountId, challenge_id: challengeId }
    if (b.ok && b.status === 'already_bound') return { ok: true, status: 'already_bound_self', github_actor_id: githubActorId, account_id: accountId, challenge_id: challengeId }
    if (!b.ok && b.reason === 'already_bound_to_other') throw new ClaimRollback(refused('already_bound_other', b.detail))
    throw new ClaimRollback(refused('invariant_violation', `unexpected bind result: ${JSON.stringify(b)}`))
  })

  for (let attempt = 0; ; attempt++) {
    try {
      return txn.immediate()
    } catch (err) {
      if (err instanceof ClaimRollback) return err.outcome
      if (isSqliteBusy(err) && attempt < MAX_BUSY_RETRIES) { await sleep(BUSY_BACKOFF_MS * (attempt + 1)); continue }
      if (isSqliteBusy(err)) return refused('db_busy', `busy after ${MAX_BUSY_RETRIES} retries`)
      throw err
    }
  }
}
