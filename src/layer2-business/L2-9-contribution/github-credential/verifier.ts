/**
 * GitHub Contribution Credential verifier/adapter — PURE function (PR 3A).
 *
 * Maps an ALREADY-FETCHED GitHub API response → an immutable credential (or a typed refusal).
 * **No network I/O, no token.** PR body / self-reported JSON are NON-authoritative.
 *
 * TRUST BOUNDARY: this verifies STRUCTURE + repository anchoring of a CALLER-SUPPLIED object. It
 * does NOT prove the object authentically came from GitHub, and the self-consistency check it runs
 * is NOT tamper-proof (an attacker who controls the payload can recompute digests). Real
 * authenticity requires an authenticated fetch / trusted signature — deferred to PR 3B.
 * `verification_state='verified'` = structural + repo-anchor verification only.
 *
 * Lifecycle (merged-only profile): mints ONLY `merged`. reverted/superseded/void are deferred to PR 3B.
 */
import { z } from 'zod'
import { digestCore, digestObject, credentialIdFromDigest } from './canonical.js'
import { verifyCredentialSelfConsistency } from './self-consistency.js'
import {
  GithubCredentialSchema, type GithubContributionCredential,
  PROVENANCE, CONTRIBUTION_TYPES, LIFECYCLE_EVENT, CREDENTIAL_TYPE, CREDENTIAL_VERSION,
} from './github-credential.schema.js'

const idField = z.union([z.string(), z.number()])

// Full Zod schema for the external GitHub response — parsing it up-front means malformed input
// (missing fields, wrong types, non-array commit_authors/reviews/check_conclusions, [null], {}…)
// becomes a typed refusal instead of a thrown TypeError deep in the mapping code.
const InputSchema = z.object({
  repository: z.object({
    id: idField,
    owner: z.object({ login: z.string() }),
    name: z.string(),
    visibility: z.string().optional(),
  }),
  pull_request: z.object({
    number: z.number(),
    node_id: z.string(),
    merged: z.boolean().optional(),
    state: z.string().optional(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    base: z.object({ ref: z.string() }),
    head: z.object({ ref: z.string(), sha: z.string() }),
    user: z.object({ id: idField, login: z.string() }),
    merged_by: z.object({ id: idField }).nullable().optional(),
  }),
  commit_authors: z.array(z.object({
    author_id: idField.nullable().optional(),
    login: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    is_coauthor: z.boolean().optional(),
  })).optional(),
  check_conclusions: z.array(z.string()).optional(),
  reviews: z.array(z.object({ state: z.string(), user_id: idField.optional() })).optional(),
  dco_state: z.enum(['present', 'absent', 'unknown']).optional(),
  evidence_coverage: z.object({
    checks: z.enum(['observed', 'unobserved', 'partial']).optional(),
    reviews: z.enum(['observed', 'unobserved', 'partial']).optional(),
    commit_authors: z.enum(['observed', 'unobserved', 'partial']).optional(),
    dco: z.enum(['observed', 'unobserved']).optional(),
  }).optional(),
  observed_at: z.string().min(1),
  self_reported: z.object({
    task_id: z.string().nullable().optional(),
    source_ref: z.string().nullable().optional(),
    agent_provenance: z.string().optional(),
    contribution_type: z.string().optional(),
  }).optional(),
})

export type GithubPrApiResponse = z.input<typeof InputSchema>

export interface VerifierOptions {
  expectedRepositoryId: string
  lifecycle_event?: string                 // merged-only profile: accepts 'merged' only
  supersedes_credential_id?: string | null
  evidence_scope?: 'public_metadata' | 'repo_collaborator_metadata'
}

export type VerifyResult =
  | { ok: true; credential: GithubContributionCredential }
  | { ok: false; outcome: 'wrong_repository' | 'not_merged' | 'insufficient_evidence' | 'unsupported_lifecycle'; reasons: string[] }

const s = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : String(v)

function summarizeChecks(conclusions: string[] = []) {
  const sum = { total: conclusions.length, success: 0, failure: 0, neutral: 0, other: 0 }
  for (const c of conclusions) {
    if (c === 'success') sum.success++
    else if (c === 'failure' || c === 'timed_out' || c === 'cancelled') sum.failure++
    else if (c === 'neutral' || c === 'skipped') sum.neutral++
    else sum.other++
  }
  return sum
}
// Reviews dedup + final-state rule: GitHub returns reviews chronologically; a reviewer can review
// many times. A reviewer's FINAL state = the last DECISIVE review (APPROVED | CHANGES_REQUESTED |
// DISMISSED); COMMENTED never changes the final state. We count one vote per reviewer.
function summarizeReviews(reviews: Array<{ state: string; user_id?: string | number }> = []) {
  const finalDecisive = new Map<string, string>()   // reviewer id → last decisive state
  const everCommented = new Set<string>()
  const allReviewers: string[] = []
  for (const r of reviews) {
    const id = s(r.user_id)
    if (!id) continue
    if (!allReviewers.includes(id)) allReviewers.push(id)
    const st = (r.state || '').toUpperCase()
    if (st === 'APPROVED' || st === 'CHANGES_REQUESTED' || st === 'DISMISSED') finalDecisive.set(id, st)
    else if (st === 'COMMENTED') everCommented.add(id)
  }
  let approved = 0, changes_requested = 0
  for (const st of finalDecisive.values()) {
    if (st === 'APPROVED') approved++
    else if (st === 'CHANGES_REQUESTED') changes_requested++   // DISMISSED → counted in neither
  }
  let commented = 0
  for (const id of everCommented) if (!finalDecisive.has(id)) commented++   // commented-only reviewers
  return { approved, changes_requested, commented, reviewer_ids: allReviewers }
}

export function verifyGithubContribution(resp: GithubPrApiResponse, opts: VerifierOptions): VerifyResult {
  // merged-only profile: supports ONLY `merged` (a pure PR response cannot prove reverted/superseded/void).
  const lifecycle = opts.lifecycle_event ?? 'merged'
  if (lifecycle !== 'merged') {
    return { ok: false, outcome: 'unsupported_lifecycle', reasons: [`lifecycle '${lifecycle}' not supported by the pure-PR verifier (merged-only profile; only 'merged'); reverted/superseded/void are deferred to PR 3B's lifecycle-event verifier`] }
  }

  // P2: parse the whole external response up-front — malformed input ⇒ typed refusal, never throws.
  const parsed = InputSchema.safeParse(resp)
  if (!parsed.success) {
    return { ok: false, outcome: 'insufficient_evidence', reasons: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  }
  const r = parsed.data

  const repoId = s(r.repository.id)
  const prNodeId = s(r.pull_request.node_id)
  const baseRef = s(r.pull_request.base.ref)
  const headSha = s(r.pull_request.head.sha)
  const actorId = s(r.pull_request.user.id)
  if (!repoId || !prNodeId || !baseRef || !headSha || !actorId) {
    const reasons: string[] = []
    if (!repoId) reasons.push('empty repository_id')
    if (!prNodeId) reasons.push('empty pr_node_id')
    if (!baseRef) reasons.push('empty base_ref')
    if (!headSha) reasons.push('empty head_sha')
    if (!actorId) reasons.push('empty github_actor_id')
    return { ok: false, outcome: 'insufficient_evidence', reasons }
  }

  if (repoId !== opts.expectedRepositoryId) {
    return { ok: false, outcome: 'wrong_repository', reasons: [`repository_id ${repoId} != expected ${opts.expectedRepositoryId}`] }
  }

  const mergeSha = s(r.pull_request.merge_commit_sha)
  const mergedAt = s(r.pull_request.merged_at)
  if (r.pull_request.merged !== true) {
    return { ok: false, outcome: 'not_merged', reasons: [`pull_request.merged=${r.pull_request.merged}, state=${r.pull_request.state ?? '?'}`] }
  }
  if (!mergeSha) return { ok: false, outcome: 'insufficient_evidence', reasons: ['merged=true but missing merge_commit_sha'] }
  if (!mergedAt) return { ok: false, outcome: 'insufficient_evidence', reasons: ['merged=true but missing merged_at'] }

  // "cannot verify → never guess": no valid self-report ⇒ unknown / null, NOT human / code.
  const prov = PROVENANCE.includes(r.self_reported?.agent_provenance as never) ? (r.self_reported!.agent_provenance as typeof PROVENANCE[number]) : 'unknown'
  const ctype = CONTRIBUTION_TYPES.includes(r.self_reported?.contribution_type as never) ? (r.self_reported!.contribution_type as typeof CONTRIBUTION_TYPES[number]) : null

  // immutable GitHub fact core (digest domain = credential_type + credential_version)
  const core = {
    credential_type: CREDENTIAL_TYPE,
    credential_version: CREDENTIAL_VERSION,
    repository_id: repoId,
    pr_node_id: prNodeId,
    pr_number: r.pull_request.number,
    base_ref: baseRef,
    head_sha: headSha,
    merge_commit_sha: mergeSha,
    merged_at: mergedAt,
    github_actor_id: actorId,
    lifecycle_event: lifecycle as typeof LIFECYCLE_EVENT[number],
    supersedes_credential_id: null,   // merged forces a null parent link
  }
  const coreDigest = digestCore(core)
  const credentialId = credentialIdFromDigest(coreDigest)

  const observation = {
    observed_at: r.observed_at,
    repository_owner: r.repository.owner.login,
    repository_name: r.repository.name,
    repository_visibility_at_observation: (['public', 'private', 'internal'].includes(r.repository.visibility as never) ? r.repository.visibility : 'unknown') as 'public' | 'private' | 'internal' | 'unknown',   // missing ⇒ unknown, never guessed public
    head_ref: s(r.pull_request.head.ref) ?? baseRef,
    github_login: r.pull_request.user.login,
    commit_authors: (r.commit_authors ?? []).map(a => ({ author_id: s(a.author_id), login: a.login ?? null, name: a.name ?? null, is_coauthor: a.is_coauthor === true })),
    agent_provenance: prov,
    claimed_task_id: r.self_reported?.task_id ?? null,
    source_ref: r.self_reported?.source_ref ?? null,
    contribution_type: ctype,
    verification_state: 'verified' as const,
    evidence_scope: opts.evidence_scope ?? 'public_metadata' as const,
    checks_summary: summarizeChecks(r.check_conclusions),
    reviews_summary: summarizeReviews(r.reviews),
    dco_state: r.dco_state ?? 'unknown',
    evidence_coverage: {
      // default 'unobserved' — a pure verifier (no fetch) observed no evidence. The adapter
      // (3B-1/3B-2) supplies real coverage. Zeros/unknown only mean something when coverage='observed'.
      checks: r.evidence_coverage?.checks ?? 'unobserved',
      reviews: r.evidence_coverage?.reviews ?? 'unobserved',
      commit_authors: r.evidence_coverage?.commit_authors ?? 'unobserved',
      dco: r.evidence_coverage?.dco ?? 'unobserved',
    },
    merged_by_actor_id: s(r.pull_request.merged_by?.id),
    evidence_refs: [`pr:${repoId}#${r.pull_request.number}`, `merge_sha:${mergeSha}`],
    known_limitations: [
      'PR 3A is a PURE verifier over a caller-supplied response; it does NOT prove the response authentically came from GitHub. verification_state=verified = structural + repository-anchor verification only.',
      'The self-consistency check is NOT tamper-proof: an attacker who controls the payload can recompute digests. Real authenticity needs an authenticated fetch / trusted signature (PR 3B).',
      'credential_id + core_digest authenticate ONLY the immutable GitHub fact core, NOT this observation envelope.',
      'GitHub identity is contribution attribution + a future-claim candidate, NOT a Passkey owner (RFC-017 I-7).',
      'self-reported fields (claimed_task_id/source_ref/provenance/contribution_type) are NON-authoritative and excluded from core_digest.',
      'commit_authors marked is_coauthor=true come from commit-message Co-authored-by trailers: COMMIT-DECLARED and IDENTITY-UNVERIFIED (no GitHub id) — must NOT be used for identity claim or reward.',
    ],
  }

  const credential: GithubContributionCredential = {
    credential_id: credentialId,
    event_source: 'github_api',
    accountable_party_ref: null,
    core,
    core_digest: coreDigest,
    observation,
    observation_digest: digestObject(observation),
  }

  // schema validation (structure + cross-field) ...
  const check = GithubCredentialSchema.safeParse(credential)
  if (!check.success) {
    return { ok: false, outcome: 'insufficient_evidence', reasons: check.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }
  }
  // ... and self-consistency (digests match content) — NOT a tamper-proof guarantee (see PR 3B).
  const consistency = verifyCredentialSelfConsistency(credential)
  if (!consistency.ok) {
    return { ok: false, outcome: 'insufficient_evidence', reasons: consistency.reasons }
  }
  return { ok: true, credential }
}
