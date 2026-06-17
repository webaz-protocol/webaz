/**
 * PR 3B-3b — GitHub contribution credential ingestion engine.
 *
 * Persists an **authenticated-fetched** GitHub credential (append-only) and emits the RFC-017 §10
 * Contribution Fact, re-establishing trust at ingestion. Schema = PR 3B-3a (github-credential-store.ts).
 * Design + threat model: docs/GITHUB-CREDENTIAL-INGESTION-DESIGN.md.
 *
 * Trust model (design §2):
 *   - `owner/repo/prNumber` is an UNTRUSTED request — it only SELECTS a target.
 *   - `expectedRepositoryId` is NEVER caller-reported — it is looked up in the trusted repository
 *     mapping; an unmapped repo is refused (`repository_not_allowed`).
 *   - The credential is RE-FETCHED + RE-MINTED inside the trusted path via the 3B-1 adapter
 *     (`globalThis.fetch`, no injectable transport). A caller-supplied serialized credential / its
 *     digests are NEVER accepted as proof of authenticity.
 *
 * Atomicity (design §5): all four-table lookups + the state decision + the INSERTs + the result run
 * inside ONE synchronous better-sqlite3 `db.transaction(...).immediate()` (BEGIN IMMEDIATE takes the
 * write lock BEFORE the lookups → no TOCTOU). The async seam (dbOne/dbAll/dbRun) is NEVER used inside
 * the transaction (its Promises would break better-sqlite3 atomicity). On a non-sqlite backend there
 * is no synchronous transaction yet (RFC-016 Phase 3) → FAIL-CLOSED (`backend_unsupported`).
 *
 * Append-only / row-level immutability (design §9 mandatory gate): this engine issues **only INSERT**
 * on the four tables — there is NO `UPDATE`/`DELETE` SQL anywhere here. `contribution_facts.status`
 * stays the as-ingested `active`; reverts/classification/identity-claim are future read-overlays, never
 * an in-place edit. The dedicated test asserts the source carries no UPDATE/DELETE and that an existing
 * row is byte-identical after re-ingestion.
 *
 * Never-guess: the fact's `type` is NULL (a merge does not reveal a contribution type) and `provenance`
 * is `unknown` (a non-authoritative self-report is NOT promoted onto the authoritative fact);
 * `accountable_ref` is NULL until a future identity claim. No valuation/reward is ever produced.
 */
import type Database from 'better-sqlite3'
import { seamBackendKind, seamSqliteHandle } from '../../layer0-foundation/L0-1-database/db.js'
import { fetchGithubContributionCredential, type FetchOutcome } from './github-credential/github-fetch-adapter.js'
import { GithubCredentialSchema } from './github-credential/github-credential.schema.js'
import { verifyCredentialSelfConsistency } from './github-credential/self-consistency.js'
import { canonicalSerialize, sha256hex } from './github-credential/canonical.js'

export interface IngestRequest {
  owner: string
  repo: string
  prNumber: number
}

/** Trusted config: `${owner}/${repo}` → the stable GitHub repository node_id we anchor on. */
export type RepositoryMapping = ReadonlyMap<string, string>

export interface IngestDeps {
  token: string
  repositoryMapping: RepositoryMapping
  timeoutMs?: number
}

export type IngestStatus = 'ingested' | 'credential_upgraded' | 're_observed' | 'already_present'

/** Refusals: own reasons + the 3B-1 adapter's typed outcomes (propagated, never thrown). */
export type RefusalReason =
  | 'repository_not_allowed'
  | 'backend_unsupported'
  | 'db_busy'
  | 'invariant_violation'
  | FetchOutcome

export type IngestResult =
  | { ok: true; status: IngestStatus; fact_id: string; credential_id: string; source_event_key: string }
  | { ok: false; status: 'refused'; reason: RefusalReason; detail?: string }

const MAX_BUSY_RETRIES = 5
const BUSY_BACKOFF_MS = 25

function refused(reason: RefusalReason, detail?: string): IngestResult {
  return { ok: false, status: 'refused', reason, detail }
}
function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT'
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export async function ingestGithubContribution(request: IngestRequest, deps: IngestDeps): Promise<IngestResult> {
  // 1) trusted mapping — expectedRepositoryId is NEVER caller-reported (design §2)
  const mapKey = `${request.owner}/${request.repo}`
  const expectedRepositoryId = deps.repositoryMapping.get(mapKey)
  if (expectedRepositoryId === undefined) return refused('repository_not_allowed', mapKey)

  // 2) backend fail-closed BEFORE any network — no synchronous transaction on PG yet (design §5)
  const kind = seamBackendKind()
  const db = seamSqliteHandle()
  if (kind !== 'sqlite' || db === null) return refused('backend_unsupported', `backend=${kind ?? 'uninitialized'}`)

  // 3) re-fetch + mint inside the trusted path (adapter uses globalThis.fetch) — OUTSIDE the transaction
  const fetched = await fetchGithubContributionCredential({
    owner: request.owner,
    repo: request.repo,
    prNumber: request.prNumber,
    expectedRepositoryId,
    token: deps.token,
    timeoutMs: deps.timeoutMs,
  })
  if (!fetched.ok) return refused(fetched.outcome, fetched.reasons.join('; '))
  const credential = fetched.credential

  // 4) re-validate the minted credential (the trusted path must be self-consistent) — outside the tx
  if (!GithubCredentialSchema.safeParse(credential).success) {
    return refused('invariant_violation', 'minted credential failed schema re-validation')
  }
  const sc = verifyCredentialSelfConsistency(credential)
  if (!sc.ok) return refused('invariant_violation', `self-consistency: ${sc.reasons.join('; ')}`)

  // 5) derive identity keys. source_event_key is VERSION-INDEPENDENT (credential_id includes the
  //    version; a v2 and a future v3 of the same merge are ONE fact) — design §3.
  const core = credential.core
  const mergeCommitSha = core.merge_commit_sha
  const mergedAt = core.merged_at
  if (mergeCommitSha === null || mergedAt === null) {
    return refused('invariant_violation', 'merged core missing merge_commit_sha/merged_at')
  }
  const sourceEventKey = `github:${core.repository_id}:${core.pr_node_id}:merged`
  const factId = `cfact_${sha256hex(sourceEventKey).slice(0, 40)}`
  const observationId = `gco_${sha256hex(`${credential.credential_id}:${credential.observation_digest}`).slice(0, 40)}`
  const executorRef = `github:${core.github_actor_id}`

  // 6) ONE synchronous transaction — all four lookups + decision + INSERTs + result (design §5).
  //    No async seam inside; raw prepared statements only; .immediate() = write lock up front.
  const txn = db.transaction((): IngestResult => {
    const coreRow = db.prepare('SELECT core_digest FROM github_contribution_credentials WHERE credential_id = ?')
      .get(credential.credential_id) as { core_digest: string } | undefined
    const obsRow = db.prepare('SELECT id FROM github_credential_observations WHERE credential_id = ? AND observation_digest = ?')
      .get(credential.credential_id, credential.observation_digest) as { id: string } | undefined
    const factRow = db.prepare('SELECT fact_id FROM contribution_facts WHERE source_event_key = ?')
      .get(sourceEventKey) as { fact_id: string } | undefined
    const linkRow = db.prepare('SELECT fact_id FROM github_fact_credentials WHERE credential_id = ?')
      .get(credential.credential_id) as { fact_id: string } | undefined

    const coreExists = coreRow !== undefined
    const obsExists = obsRow !== undefined
    const factExists = factRow !== undefined
    const linkExists = linkRow !== undefined

    // Defensive consistency: stored rows must agree with the deterministic derivations; any drift is a
    // corrupted invariant → fail-closed, never silently repair (design §4 catch-all).
    if (coreExists && coreRow!.core_digest !== credential.core_digest) {
      return refused('invariant_violation', 'stored core_digest mismatch for credential_id')
    }
    if (factExists && factRow!.fact_id !== factId) {
      return refused('invariant_violation', 'existing fact_id mismatch for source_event_key')
    }
    if (linkExists && linkRow!.fact_id !== factId) {
      return refused('invariant_violation', 'existing link points to a different fact')
    }

    const insertCore = (): void => {
      db.prepare(`INSERT INTO github_contribution_credentials
        (credential_id, core_digest, credential_version, source_event_key, repository_id, pr_node_id,
         pr_number, merge_commit_sha, merged_at, github_actor_id, lifecycle_event, core_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        credential.credential_id, credential.core_digest, core.credential_version, sourceEventKey,
        core.repository_id, core.pr_node_id, core.pr_number, mergeCommitSha, mergedAt,
        core.github_actor_id, core.lifecycle_event, canonicalSerialize(core),
      )
    }
    const insertObs = (): void => {
      db.prepare(`INSERT INTO github_credential_observations
        (id, credential_id, observation_digest, observation_json, observed_at) VALUES (?,?,?,?,?)`).run(
        observationId, credential.credential_id, credential.observation_digest,
        canonicalSerialize(credential.observation), credential.observation.observed_at,
      )
    }
    const insertFact = (): void => {
      db.prepare(`INSERT INTO contribution_facts
        (fact_id, source_event_key, source, type, artifact_ref, occurred_at, executor_ref,
         accountable_ref, provenance, status) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        factId, sourceEventKey, 'github', null, mergeCommitSha, mergedAt, executorRef, null, 'unknown', 'active',
      )
    }
    const insertLink = (): void => {
      // source_event_key on the link + the composite FKs (Codex #297 P2-1) force the linked credential
      // and fact to share THIS source event — a cross-event mislink is rejected by the DB.
      db.prepare('INSERT INTO github_fact_credentials (fact_id, credential_id, source_event_key) VALUES (?,?,?)')
        .run(factId, credential.credential_id, sourceEventKey)
    }

    const result = (status: IngestStatus): IngestResult =>
      ({ ok: true, status, fact_id: factId, credential_id: credential.credential_id, source_event_key: sourceEventKey })

    // Precise state machine — ONLY the four valid tuples write; anything else fail-closed (design §4).
    if (!coreExists && !obsExists && !factExists && !linkExists) {
      insertCore(); insertObs(); insertFact(); insertLink()
      return result('ingested')
    }
    if (!coreExists && !obsExists && factExists && !linkExists) {
      // v2→v3 of the SAME merge: new immutable core + observation, LINKED to the existing fact. No 2nd fact.
      insertCore(); insertObs(); insertLink()
      return result('credential_upgraded')
    }
    if (coreExists && !obsExists && factExists && linkExists) {
      insertObs()
      return result('re_observed')
    }
    if (coreExists && obsExists && factExists && linkExists) {
      return result('already_present')
    }
    return refused('invariant_violation', `uncovered state core=${coreExists} obs=${obsExists} fact=${factExists} link=${linkExists}`)
  })

  // 7) bounded SQLITE_BUSY retry → typed db_busy; genuinely unexpected errors fail LOUD (never a fake success)
  for (let attempt = 0; ; attempt++) {
    try {
      return txn.immediate()
    } catch (err) {
      if (isSqliteBusy(err) && attempt < MAX_BUSY_RETRIES) {
        await sleep(BUSY_BACKOFF_MS * (attempt + 1))
        continue
      }
      if (isSqliteBusy(err)) return refused('db_busy', `busy after ${MAX_BUSY_RETRIES} retries`)
      throw err
    }
  }
}
