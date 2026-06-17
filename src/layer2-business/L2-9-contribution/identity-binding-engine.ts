/**
 * PR 4a — GitHub identity → WebAZ account binding engine + accountable read-overlay.
 *
 * Records an identity binding (append-only event log + a current-state projection) and resolves a
 * contribution fact's CURRENT accountable party at read time. Design + threat model:
 * docs/IDENTITY-CLAIM-DESIGN.md. Schema: identity-binding-store.ts.
 *
 * Trust boundary (4a vs 4b): this engine takes an **already-verified `githubActorId`** as trusted
 * input — proving control of that GitHub identity (publication challenge) and the human Passkey gate
 * are 4b's job (the same schema/trigger split as 3B-3a/3B-3b). The engine itself is internal: it
 * exposes NO agent/MCP/API surface.
 *
 * Atomicity: one synchronous better-sqlite3 `db.transaction(...).immediate()` (BEGIN IMMEDIATE takes
 * the write lock before the lookup → no double-bind race); the active projection's PK is the second
 * line. Non-sqlite backend → fail-closed (`backend_unsupported`). SQLITE_BUSY → bounded retry → typed
 * `db_busy`; genuinely unexpected errors are re-thrown loud.
 *
 * Append-only: the EVENT LOG (`identity_binding_events`) is INSERT-only (immutable). The current-state
 * projection (`identity_bindings_active`) is mutable BY DESIGN (bound→INSERT, revoked→DELETE) — it is a
 * cache rebuildable from the log, never the audit truth.
 */
import { dbOne, seamBackendKind, seamSqliteHandle } from '../../layer0-foundation/L0-1-database/db.js'
import { sha256hex } from './github-credential/canonical.js'

export type ProofMethod = 'github_publication_challenge' | 'admin_manual'
export type Visibility = 'private' | 'public'

export interface BindInput {
  githubActorId: string
  accountId: string
  proofMethod: ProofMethod
  proofRef?: string
  visibility?: Visibility
}
export interface RevokeInput {
  githubActorId: string
  accountId: string
  proofMethod: ProofMethod
  proofRef?: string
}

export type BindRefusal = 'backend_unsupported' | 'db_busy' | 'already_bound_to_other' | 'invalid_input'
export type RevokeRefusal = 'backend_unsupported' | 'db_busy' | 'not_bound' | 'not_owner' | 'invalid_input'

export type BindResult =
  | { ok: true; status: 'bound' | 'already_bound'; github_actor_id: string; account_id: string; event_id: string }
  | { ok: false; status: 'refused'; reason: BindRefusal; detail?: string }
export type RevokeResult =
  | { ok: true; status: 'revoked'; github_actor_id: string; account_id: string; event_id: string }
  | { ok: false; status: 'refused'; reason: RevokeRefusal; detail?: string }

export interface ActiveBinding {
  accountable_ref: string   // webaz:<account_id>
  account_id: string
  visibility: Visibility
  bound_at: string
  bound_event_id: string
}

const MAX_BUSY_RETRIES = 5
const BUSY_BACKOFF_MS = 25
const isSqliteBusy = (e: unknown): boolean => {
  const c = (e as { code?: string })?.code
  return c === 'SQLITE_BUSY' || c === 'SQLITE_BUSY_SNAPSHOT'
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
export const accountableRef = (accountId: string): string => `webaz:${accountId}`

/* eslint-disable @typescript-eslint/no-explicit-any */
// Runs `body` in one synchronous .immediate() transaction; maps the two infra refusals
// (non-sqlite backend / SQLITE_BUSY exhaustion) into the caller's own result type T.
async function runTx<T>(
  buildRefused: (reason: 'backend_unsupported' | 'db_busy', detail?: string) => T,
  body: (db: any) => () => T,
): Promise<T> {
  const kind = seamBackendKind()
  const db = seamSqliteHandle()
  if (kind !== 'sqlite' || db === null) return buildRefused('backend_unsupported', `backend=${kind ?? 'uninitialized'}`)
  const txn = (db as any).transaction(body(db))
  for (let attempt = 0; ; attempt++) {
    try {
      return txn.immediate()
    } catch (err) {
      if (isSqliteBusy(err) && attempt < MAX_BUSY_RETRIES) { await sleep(BUSY_BACKOFF_MS * (attempt + 1)); continue }
      if (isSqliteBusy(err)) return buildRefused('db_busy', `busy after ${MAX_BUSY_RETRIES} retries`)
      throw err
    }
  }
}

/**
 * Synchronous bind core — the bind state machine WITHOUT its own transaction or backend check, so it
 * can run INSIDE a caller-supplied `db.transaction` (e.g. the PR-F2 claim engine consuming a challenge
 * + binding in ONE tx, avoiding the nested-transaction conflict). `bindGithubIdentity` wraps this in its
 * own `.immediate()` tx; behavior is identical (proven by the existing identity-binding tests + a
 * dedicated equivalence test). `db` is a better-sqlite3 handle already inside a transaction.
 */
export function bindGithubIdentityCore(db: any, input: BindInput): BindResult {
  const { githubActorId, accountId, proofMethod, proofRef = null } = input
  const visibility: Visibility = input.visibility ?? 'private'
  if (!githubActorId || !accountId) {
    return { ok: false, status: 'refused', reason: 'invalid_input', detail: 'githubActorId and accountId are required' }
  }
  const refused = (reason: BindRefusal, detail?: string): BindResult => ({ ok: false, status: 'refused', reason, detail })
  const active = db.prepare('SELECT account_id FROM identity_bindings_active WHERE github_actor_id = ?')
    .get(githubActorId) as { account_id: string } | undefined
  if (active) {
    if (active.account_id === accountId) {
      return { ok: true, status: 'already_bound', github_actor_id: githubActorId, account_id: accountId, event_id: '' }
    }
    return refused('already_bound_to_other', 'github id is actively bound to a different account — revoke first')
  }
  const eventId = `ibe_${sha256hex(`bound:${githubActorId}:${accountId}:${Date.now()}:${Math.random()}`).slice(0, 40)}`
  const boundAt = new Date().toISOString()
  db.prepare(`INSERT INTO identity_binding_events
    (event_id, event_type, github_actor_id, account_id, visibility, proof_method, proof_ref, supersedes_event_id)
    VALUES (?, 'bound', ?, ?, ?, ?, ?, NULL)`).run(eventId, githubActorId, accountId, visibility, proofMethod, proofRef)
  db.prepare(`INSERT INTO identity_bindings_active
    (github_actor_id, account_id, visibility, bound_event_id, bound_at) VALUES (?, ?, ?, ?, ?)`)
    .run(githubActorId, accountId, visibility, eventId, boundAt)
  return { ok: true, status: 'bound', github_actor_id: githubActorId, account_id: accountId, event_id: eventId }
}

export async function bindGithubIdentity(input: BindInput): Promise<BindResult> {
  // Input validation BEFORE runTx (so bad input → invalid_input regardless of backend) — unchanged.
  if (!input.githubActorId || !input.accountId) {
    return { ok: false, status: 'refused', reason: 'invalid_input', detail: 'githubActorId and accountId are required' }
  }
  return runTx<BindResult>(
    (reason, detail) => ({ ok: false, status: 'refused', reason, detail }),
    (db) => (): BindResult => bindGithubIdentityCore(db, input),
  )
}

export async function revokeGithubIdentityBinding(input: RevokeInput): Promise<RevokeResult> {
  const { githubActorId, accountId, proofMethod, proofRef = null } = input
  if (!githubActorId || !accountId) {
    return { ok: false, status: 'refused', reason: 'invalid_input', detail: 'githubActorId and accountId are required' }
  }
  const refused = (reason: RevokeRefusal, detail?: string): RevokeResult => ({ ok: false, status: 'refused', reason, detail })
  return runTx<RevokeResult>(
    (reason, detail) => refused(reason, detail),
    (db) => (): RevokeResult => {
      const active = db.prepare('SELECT account_id, visibility, bound_event_id FROM identity_bindings_active WHERE github_actor_id = ?')
        .get(githubActorId) as { account_id: string; visibility: Visibility; bound_event_id: string } | undefined
      if (!active) return refused('not_bound', 'no active binding for this github id')
      // Only the current account may self-revoke; admin_manual lets governance override (audited).
      if (proofMethod !== 'admin_manual' && active.account_id !== accountId) {
        return refused('not_owner', 'only the currently-bound account may revoke (or use admin_manual)')
      }
      const eventId = `ibe_${sha256hex(`revoked:${githubActorId}:${active.account_id}:${Date.now()}:${Math.random()}`).slice(0, 40)}`
      db.prepare(`INSERT INTO identity_binding_events
        (event_id, event_type, github_actor_id, account_id, visibility, proof_method, proof_ref, supersedes_event_id)
        VALUES (?, 'revoked', ?, ?, ?, ?, ?, ?)`)
        .run(eventId, githubActorId, active.account_id, active.visibility, proofMethod, proofRef, active.bound_event_id)
      db.prepare('DELETE FROM identity_bindings_active WHERE github_actor_id = ?').run(githubActorId)
      return { ok: true, status: 'revoked', github_actor_id: githubActorId, account_id: active.account_id, event_id: eventId }
    },
  )
}

/**
 * Read-overlay: the CURRENT accountable party for a contribution fact's `executor_ref`.
 * Only `github:<id>` executors are bindable in v1; anything else (or no active binding) → null.
 * Uses the async seam (a plain read, no transaction) so it composes with the rest of the read path.
 */
export async function resolveAccountable(executorRef: string): Promise<ActiveBinding | null> {
  if (!executorRef.startsWith('github:')) return null
  const githubActorId = executorRef.slice('github:'.length)
  if (!githubActorId) return null
  const row = await dbOne<{ account_id: string; visibility: Visibility; bound_at: string; bound_event_id: string }>(
    'SELECT account_id, visibility, bound_at, bound_event_id FROM identity_bindings_active WHERE github_actor_id = ?',
    [githubActorId],
  )
  if (!row) return null
  return { accountable_ref: accountableRef(row.account_id), account_id: row.account_id, visibility: row.visibility, bound_at: row.bound_at, bound_event_id: row.bound_event_id }
}
