/**
 * Authenticated GitHub Fetch Adapter (PR 3B-1) — establishes SOURCE AUTHENTICITY for a
 * GitHub Contribution Credential by performing WebAZ's OWN authenticated, read-only fetch.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THREAT MODEL (written first, per the project's security-artifact discipline)
 *
 * Who controls each input (NOT all "trusted config" — be precise):
 *   - owner / repo / prNumber          : the CALLER chooses which PR to ask about (untrusted-ish:
 *                                        only selects a target; cannot weaken the trust path).
 *   - expectedRepositoryId / token /
 *     the runtime environment          : the TRUSTED SERVICE configuration (operator-controlled).
 *   - the transport (fetch) + the clock : the WebAZ runtime ITSELF — NOT injectable. The public
 *                                        entry uses only `globalThis.fetch` and the system clock.
 *
 * Trust root established here = an authenticated HTTPS GET to the FIXED origin
 *   https://api.github.com  with the trusted token, anchored to a repository id from TRUSTED
 *   CONFIG. The response is therefore trusted *within this execution* (modulo TLS + GitHub).
 *
 * ⚠️ NO transport/time injection on the production entry. Accepting a caller-supplied `fetchImpl`
 *    would let a caller return forged repo/PR bytes WITHOUT touching GitHub and still mint a
 *    credential; a caller-supplied `now` would forge `fetched_at`. Both are therefore REJECTED by
 *    the strict args schema (outcome `invalid_request`). Tests swap `globalThis.fetch` instead.
 *
 * What the output promises (and does NOT):
 *   - A returned credential was produced INSIDE this trusted execution at `fetched_at`.
 *   - `fetch_metadata` is AUDIT info for THIS execution only — NOT an independently verifiable
 *     signature. A serialized credential is NOT a portable proof: a later replay cannot
 *     re-establish authenticity without re-fetching (PR 3B-* / signing).
 *
 * Hardening: fixed origin; path segments encodeURIComponent'd + origin re-asserted; method GET;
 *   Authorization sent ONLY to api.github.com; redirects NOT followed; AbortSignal timeout;
 *   token never logged/returned/interpolated into errors/URLs; repository anchored on a STABLE id
 *   from trusted config (fork PRs anchored on BASE repo); PR.number must equal the requested
 *   prNumber; missing info never guessed; all predictable failures are TYPED returns, never thrown.
 *
 * Lifecycle: `merged` only (merged-only profile; no title/body/branch/commit inference). Boundaries: NO DB,
 *   persistence, Contribution Fact write, ingestion endpoint, webhook, write API, Passkey/KYC,
 *   scoring/reward, or Assurance Surface. No new dependency (native fetch).
 */
import { z } from 'zod'
import { verifyGithubContribution, type GithubPrApiResponse } from './verifier.js'
import type { GithubContributionCredential } from './github-credential.schema.js'

// Audited authenticated-read primitives (PR 3B-1). Exported so other GitHub-facing readers (e.g. the
// PR 4b identity-claim gist verifier) REUSE this single audited fetch — fixed origin, GET-only,
// manual-redirect, AbortSignal timeout, typed outcomes — instead of building a second authenticated
// read that would need its own origin/redirect/timeout audit.
export const ORIGIN = 'https://api.github.com'
export const API_VERSION = '2022-11-28'
export const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 60_000

// Loose schemas for GitHub responses — accept GitHub's extra/new fields; only require what we map.
const RepoResponse = z.object({
  node_id: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  visibility: z.string().optional(),
})
const PrResponse = z.object({
  number: z.number(),
  node_id: z.string(),
  merged: z.boolean().optional(),
  state: z.string().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  commits: z.number().optional(),                         // total commit count — used to detect the 250-cap truncation
  base: z.object({ ref: z.string(), repo: z.object({ node_id: z.string() }).nullable().optional() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  user: z.object({ id: z.union([z.string(), z.number()]), login: z.string() }),
  merged_by: z.object({ id: z.union([z.string(), z.number()]) }).nullable().optional(),
})

// Loose item schemas — supplementary list items are STRUCTURALLY validated and malformed ones
// are dropped (a malformed commit must NOT become an all-null author).
const CheckRunItem = z.object({ name: z.string().optional(), conclusion: z.string().nullable().optional() })
const ReviewItem = z.object({ state: z.string().optional(), user: z.object({ id: z.union([z.string(), z.number()]).optional() }).nullable().optional() })
const CommitItem = z.object({ author: z.object({ id: z.union([z.string(), z.number()]).nullable().optional(), login: z.string().nullable().optional() }).nullable().optional(), commit: z.object({ author: z.object({ name: z.string().nullable().optional() }).nullable().optional(), message: z.string().nullable().optional() }).nullable().optional() })


// STRICT args schema — rejects unknown keys (incl. fetchImpl / now), bounds timeoutMs, etc.
const nonBlank = z.string().min(1).refine(v => v.trim().length > 0, { message: 'blank' })
const ArgsSchema = z.strictObject({
  owner: nonBlank,
  repo: nonBlank,
  prNumber: z.number().int().positive(),
  expectedRepositoryId: nonBlank,                         // stable repo id from TRUSTED CONFIG
  token: z.string().optional(),                           // presence/blank → auth_required (post-parse)
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  // NOTE: evidence_scope is NOT a caller argument. 3B-1 does not verify repo-collaborator access,
  // so it MUST NOT let a caller claim a higher scope. It is fixed to 'public_metadata' (below);
  // elevating it requires a future PR that actually proves collaborator/admin access.
})

/** Public, documented call shape. NOTE: no `fetchImpl`/`now`/`evidenceScope` — transport, clock,
 *  and evidence scope are NOT caller-controlled (see ArgsSchema). */
export interface FetchArgs {
  owner: string
  repo: string
  prNumber: number
  expectedRepositoryId: string
  token: string
  timeoutMs?: number
}

export type FetchOutcome =
  | 'invalid_request'
  | 'auth_required'
  | 'authentication_failed'
  | 'wrong_repository'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'malformed_response'
  | 'credential_refused'

export interface FetchMetadata {
  fetched_at: string
  origin: string
  repo_endpoint: string          // path only — never contains the token
  pr_endpoint: string
  repo_status: number
  pr_status: number
  api_version: string
  unobserved: string[]           // evidence NOT fetched in 3B-1 (so it's unknown, not absent)
  note: string                   // audit-only; NOT an independently verifiable signature
}

export type FetchResult =
  | { ok: true; credential: GithubContributionCredential; fetch_metadata: FetchMetadata }
  | { ok: false; outcome: FetchOutcome; reasons: string[] }

export type RawResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'fail'; outcome: FetchOutcome; reasons: string[]; status: number }

export function pathFromOrigin(...segments: string[]): string {
  const url = `${ORIGIN}/${segments.map(encodeURIComponent).join('/')}`
  const parsed = new URL(url)
  if (parsed.origin !== ORIGIN || parsed.protocol !== 'https:') throw new Error('origin assertion failed')
  return url
}

const isAbort = (err: unknown): boolean => (err as { name?: string })?.name === 'AbortError'

export async function getJson(fetchImpl: typeof globalThis.fetch, url: string, token: string | undefined, timeoutMs: number): Promise<RawResult> {
  // Defense-in-depth at the EXPORTED boundary (Codex P1): this function attaches Authorization, so it
  // MUST refuse any URL that is not exactly https://api.github.com BEFORE calling fetch — otherwise a
  // caller-supplied off-origin URL would leak the token. Callers should still build URLs via
  // pathFromOrigin; this is the backstop. Never echo the URL / token in the failure (no leak).
  let parsed: URL
  try { parsed = new URL(url) } catch { return { kind: 'fail', outcome: 'invalid_request', reasons: ['malformed url'], status: 0 } }
  if (parsed.protocol !== 'https:' || parsed.origin !== ORIGIN) {
    return { kind: 'fail', outcome: 'invalid_request', reasons: ['url origin not allowed'], status: 0 }
  }
  const controller = new AbortController()
  // ONE timer covers the whole operation — fetch + status handling + body read (res.json()) —
  // and is cleared in finally on EVERY return/throw path. A hung body read still aborts → timeout.
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res: Response
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'webaz-github-fetch-adapter',
      }
      // Authorization is sent ONLY to api.github.com (fixed origin) and ONLY when a token is supplied;
      // omitted for unauthenticated PUBLIC reads (e.g. a public gist) so no bogus `Bearer undefined`.
      if (token) headers.Authorization = `Bearer ${token}`
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',                 // never follow redirects (would risk leaking Authorization)
        signal: controller.signal,
        headers,
      })
    } catch (err) {
      if (isAbort(err)) return { kind: 'fail', outcome: 'timeout', reasons: ['request aborted (timeout)'], status: 0 }
      return { kind: 'fail', outcome: 'upstream_unavailable', reasons: ['network error'], status: 0 }   // no token / no raw message
    }

    const status = res.status
    if ((status >= 300 && status < 400) || res.type === 'opaqueredirect' || res.redirected) {
      return { kind: 'fail', outcome: 'upstream_unavailable', reasons: ['unexpected redirect (not followed)'], status }
    }
    if (status === 401) return { kind: 'fail', outcome: 'authentication_failed', reasons: ['401 unauthorized'], status }
    if (status === 403) {
      const remaining = res.headers?.get?.('x-ratelimit-remaining')
      const retryAfter = res.headers?.get?.('retry-after')
      if (remaining === '0' || retryAfter) return { kind: 'fail', outcome: 'rate_limited', reasons: ['403 rate limited'], status }
      return { kind: 'fail', outcome: 'authentication_failed', reasons: ['403 forbidden'], status }
    }
    if (status === 429) return { kind: 'fail', outcome: 'rate_limited', reasons: ['429 too many requests'], status }
    if (status === 404) return { kind: 'fail', outcome: 'not_found', reasons: ['404 not found'], status }
    if (status >= 500) return { kind: 'fail', outcome: 'upstream_unavailable', reasons: [`${status} upstream error`], status }
    if (status < 200 || status >= 300) return { kind: 'fail', outcome: 'upstream_unavailable', reasons: [`unexpected status ${status}`], status }

    // body read is ALSO under the timeout: an abort here → timeout; any other failure → malformed.
    try {
      const body = await res.json()
      return { kind: 'ok', status, body }
    } catch (err) {
      if (isAbort(err)) return { kind: 'fail', outcome: 'timeout', reasons: ['body read aborted (timeout)'], status }
      return { kind: 'fail', outcome: 'malformed_response', reasons: ['response was not valid JSON'], status }
    }
  } finally {
    clearTimeout(timer)
  }
}

const MAX_PAGES = 10
const PER_PAGE = 100
const MAX_SUPPLEMENTARY_BUDGET_MS = 20_000   // hard wall-clock cap for ALL supplementary evidence
type Coverage = 'observed' | 'unobserved' | 'partial'

const downgrade = (cov: Coverage, rawLen: number, keptLen: number): Coverage =>
  cov === 'observed' && keptLen < rawLen ? 'partial' : cov   // dropped an unrepresentable item ⇒ not complete

// Best-effort paged GET of a GitHub list endpoint, bounded by a SHARED deadline. ANY page failure /
// non-list → 'unobserved'. Page cap reached with full pages, or the shared deadline hit mid-stream →
// 'partial' (never silently complete). Per-page timeout is capped by the remaining shared budget.
async function getListPaged(
  doFetch: typeof globalThis.fetch, baseUrl: string, token: string, perPageTimeoutMs: number, deadline: number,
  extract: (body: unknown) => unknown[] | null,
): Promise<{ items: unknown[]; coverage: Coverage }> {
  const items: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { items, coverage: items.length ? 'partial' : 'unobserved' }   // shared budget exhausted
    const url = `${baseUrl}?per_page=${PER_PAGE}&page=${page}`
    const res = await getJson(doFetch, url, token, Math.min(perPageTimeoutMs, remaining))
    // a mid-stream failure (incl. a deadline-capped page timeout) keeps what we already have as
    // 'partial'; a first-page failure with nothing accumulated → 'unobserved'.
    if (res.kind === 'fail') return { items, coverage: items.length ? 'partial' : 'unobserved' }
    const arr = extract(res.body)
    if (!arr) return { items, coverage: items.length ? 'partial' : 'unobserved' }
    for (const it of arr) items.push(it)
    if (arr.length < PER_PAGE) return { items, coverage: 'observed' }
  }
  return { items, coverage: 'partial' }   // page cap reached with full pages → may be truncated
}

// Co-authors come ONLY from a valid `Co-authored-by:` trailer in the commit message's TRAILING
// trailer block (a distinct last paragraph whose every line is a `Token: value` trailer) — NOT from
// arbitrary body lines. Both name and a syntactically-valid email are required, but the EMAIL IS
// NEVER stored (rule 10) — only the name. These are COMMIT-DECLARED and IDENTITY-UNVERIFIED (no
// GitHub id) → never usable for identity claim or reward (recorded as is_coauthor, author_id=null).
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s.+$/
const COAUTHOR_TRAILER = /^co-authored-by:\s*(.+?)\s*<([^<>@\s]+@[^<>\s]+)>\s*$/i
function parseCoAuthorNames(message: unknown): string[] {
  if (typeof message !== 'string') return []
  const lines = message.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()   // drop trailing blank lines
  if (!lines.length) return []
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim() === '') break; start = i }
  if (start === 0 || lines[start - 1].trim() !== '') return []                // must be a distinct trailing paragraph
  const block = lines.slice(start)
  if (!block.every(l => TRAILER_LINE.test(l))) return []                       // not a clean all-trailers block
  const names: string[] = []
  for (const l of block) {
    const m = COAUTHOR_TRAILER.exec(l)
    if (m && m[1].trim() && m[2].trim()) names.push(m[1].trim())               // name + valid email required; email discarded
  }
  return names
}

type CommitAuthor = { author_id: string | null; login: string | null; name: string | null; is_coauthor: boolean }
// returns the deduped authors AND the count of raw commits that could NOT be represented
// (malformed, or no identifying author info) — used to downgrade coverage to 'partial'.
function buildCommitAuthors(commits: unknown[]): { authors: CommitAuthor[]; dropped: number } {
  const map = new Map<string, CommitAuthor>()
  const add = (author_id: string | null, login: string | null, name: string | null, is_coauthor: boolean): boolean => {
    if (!author_id && !login && !name) return false   // malformed/empty → NO all-null author entry
    const key = author_id ? `id:${author_id}` : login ? `login:${login}` : `name:${name ?? ''}`
    if (!map.has(key)) map.set(key, { author_id, login, name, is_coauthor })
    return true
  }
  let dropped = 0
  for (const raw of commits) {
    const parsed = CommitItem.safeParse(raw)   // structurally validate
    if (!parsed.success) { dropped++; continue }
    const c = parsed.data
    const ghId = c.author?.id != null ? String(c.author.id) : null
    // primary-author completeness is INDEPENDENT of co-authors: if the primary author can't be
    // represented, the commit is incompletely observed (→ partial) EVEN IF co-authors are kept.
    const primaryRepresented = add(ghId, c.author?.login ?? null, c.commit?.author?.name ?? null, false)
    for (const coName of parseCoAuthorNames(c.commit?.message ?? undefined)) add(null, null, coName, true)
    if (!primaryRepresented) dropped++
  }
  return { authors: [...map.values()], dropped }
}

const KNOWN_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'])
// a review is representable only if it parses, is attributable (has a user id), AND has a RECOGNIZED
// state. A missing/unknown state is unrepresentable → dropped → downgrades coverage to 'partial'
// (we must not claim 'observed' while silently losing a review's state).
function representableReviews(items: unknown[]): Array<{ state: string; user_id: string | number }> {
  const out: Array<{ state: string; user_id: string | number }> = []
  for (const raw of items) {
    const p = ReviewItem.safeParse(raw)
    if (p.success && p.data.user?.id != null && typeof p.data.state === 'string' && KNOWN_REVIEW_STATES.has(p.data.state.toUpperCase())) {
      out.push({ state: p.data.state, user_id: p.data.user.id })
    }
  }
  return out
}

export async function fetchGithubContributionCredential(args: unknown): Promise<FetchResult> {
  // Parse the WHOLE arg object with a strict schema BEFORE any destructuring / Date / setTimeout.
  // Rejects unknown keys (incl. fetchImpl / now), bad types, bad timeoutMs — all as invalid_request.
  const parsed = ArgsSchema.safeParse(args)
  if (!parsed.success) {
    const reasons = parsed.error.issues.map(i =>
      i.code === 'unrecognized_keys'
        ? `unrecognized argument(s): ${(i as { keys?: string[] }).keys?.join(', ')}`
        : `${i.path.join('.') || '(args)'}: ${i.code}`)            // codes only — never echoes a value (no token leak)
    return { ok: false, outcome: 'invalid_request', reasons }
  }
  const a = parsed.data
  if (!a.token || a.token.trim().length === 0) {
    return { ok: false, outcome: 'auth_required', reasons: ['missing or blank token'] }   // never includes the token
  }
  const token = a.token
  const timeoutMs = a.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const observedAt = new Date().toISOString()             // system clock — NOT caller-injectable
  const doFetch = globalThis.fetch                        // runtime transport — NOT caller-injectable

  try {
    let repoUrl: string, prUrl: string
    try {
      repoUrl = pathFromOrigin('repos', a.owner, a.repo)
      prUrl = pathFromOrigin('repos', a.owner, a.repo, 'pulls', String(a.prNumber))
    } catch {
      return { ok: false, outcome: 'invalid_request', reasons: ['could not build a safe api.github.com URL'] }
    }
    const repoEndpoint = new URL(repoUrl).pathname
    const prEndpoint = new URL(prUrl).pathname

    // 1) authenticated GET /repos/{owner}/{repo}
    const repoRes = await getJson(doFetch, repoUrl, token, timeoutMs)
    if (repoRes.kind === 'fail') return { ok: false, outcome: repoRes.outcome, reasons: repoRes.reasons }
    const repoParsed = RepoResponse.safeParse(repoRes.body)
    if (!repoParsed.success) return { ok: false, outcome: 'malformed_response', reasons: ['repository response missing/typed-wrong fields'] }
    const repoData = repoParsed.data

    // 2) repository anchoring — stable id from trusted config vs the API's stable id (not self-derived)
    if (repoData.node_id !== a.expectedRepositoryId) {
      return { ok: false, outcome: 'wrong_repository', reasons: ['repository node_id != expectedRepositoryId (trusted config)'] }
    }

    // 3) authenticated GET /repos/{owner}/{repo}/pulls/{prNumber}
    const prRes = await getJson(doFetch, prUrl, token, timeoutMs)
    if (prRes.kind === 'fail') return { ok: false, outcome: prRes.outcome, reasons: prRes.reasons }
    const prParsed = PrResponse.safeParse(prRes.body)
    if (!prParsed.success) return { ok: false, outcome: 'malformed_response', reasons: ['pull request response missing/typed-wrong fields'] }
    const pr = prParsed.data

    // 3a) the response must be for the PR we asked about (no substituted PR)
    if (pr.number !== a.prNumber) {
      return { ok: false, outcome: 'malformed_response', reasons: [`pull_request.number ${pr.number} != requested ${a.prNumber}`] }
    }

    // 4) fork PRs allowed, but base/target repo must still be the anchored one
    const baseRepoNodeId = pr.base.repo?.node_id
    if (baseRepoNodeId && baseRepoNodeId !== a.expectedRepositoryId) {
      return { ok: false, outcome: 'wrong_repository', reasons: ['PR base repository != expectedRepositoryId'] }
    }

    // 5) best-effort SUPPLEMENTARY evidence (checks / reviews / commits → authors + DCO).
    //    The core merged fact is already authenticated above; a supplementary failure degrades
    //    that stream to 'unobserved' (never half-claimed), it does NOT refuse the credential.
    // fetch the 3 supplementary streams IN PARALLEL, under a SHARED wall-clock deadline (bounds the
    // whole supplementary phase, not just one stream).
    const supplementaryDeadline = Date.now() + Math.min(timeoutMs * 4, MAX_SUPPLEMENTARY_BUDGET_MS)
    const [checksPaged, reviewsPaged, commitsPaged] = await Promise.all([
      getListPaged(doFetch, pathFromOrigin('repos', a.owner, a.repo, 'commits', pr.head.sha, 'check-runs'), token, timeoutMs, supplementaryDeadline,
        b => Array.isArray((b as { check_runs?: unknown[] })?.check_runs) ? (b as { check_runs: unknown[] }).check_runs : null),
      getListPaged(doFetch, pathFromOrigin('repos', a.owner, a.repo, 'pulls', String(a.prNumber), 'reviews'), token, timeoutMs, supplementaryDeadline,
        b => Array.isArray(b) ? b : null),
      getListPaged(doFetch, pathFromOrigin('repos', a.owner, a.repo, 'pulls', String(a.prNumber), 'commits'), token, timeoutMs, supplementaryDeadline,
        b => Array.isArray(b) ? b : null),
    ])

    // structurally validate each item; an UNREPRESENTABLE item (malformed / no usable identity)
    // downgrades the stream to 'partial' — we must not claim a complete result after dropping data.
    const checkRuns = checksPaged.items.map(i => CheckRunItem.safeParse(i)).flatMap(r => r.success ? [r.data] : [])
    const reviewItems = representableReviews(reviewsPaged.items)
    const checksCoverage = downgrade(checksPaged.coverage, checksPaged.items.length, checkRuns.length)
    const reviewsCoverage = downgrade(reviewsPaged.coverage, reviewsPaged.items.length, reviewItems.length)

    const checkConclusions = checksCoverage === 'unobserved' ? undefined
      : checkRuns.map(c => typeof c.conclusion === 'string' ? c.conclusion : 'other')
    const reviews = reviewsCoverage === 'unobserved' ? undefined
      : reviewItems.map(rv => ({ state: rv.state ?? '', user_id: rv.user_id }))

    const { authors, dropped: commitsDropped } = buildCommitAuthors(commitsPaged.items)
    let commitsCoverage = downgrade(commitsPaged.coverage, commitsPaged.items.length, commitsPaged.items.length - commitsDropped)
    // GitHub's PR-commits API caps at 250: if the PR total exceeds what we fetched → 'partial'.
    if (commitsCoverage === 'observed') {
      if (typeof pr.commits === 'number') { if (commitsPaged.items.length < pr.commits) commitsCoverage = 'partial' }
      else if (commitsPaged.items.length >= 250) commitsCoverage = 'partial'
    }
    const commitAuthors = commitsCoverage === 'unobserved' ? undefined : authors

    // DCO is DEFERRED (3B-2): a DCO check-run 'success' does NOT reliably prove a real-human
    // Signed-off-by (the DCO legal statement) — e.g. a lenient check may pass on Co-authored-by.
    // We do NOT derive present/absent from a check whose semantics we cannot verify. Reliable DCO
    // (verifying Signed-off-by per commit against its author) is a later PR. → always unknown/unobserved.
    const dcoState: 'present' | 'absent' | 'unknown' = 'unknown'
    const evidenceCoverage = {
      checks: checksCoverage,
      reviews: reviewsCoverage,
      commit_authors: commitsCoverage,
      dco: 'unobserved' as 'observed' | 'unobserved',
    }

    // 6) build the PR #294 verifier input — only what GitHub returned; nothing guessed.
    const verifierInput: GithubPrApiResponse = {
      repository: { id: repoData.node_id, owner: { login: repoData.owner.login }, name: repoData.name, visibility: repoData.visibility },
      pull_request: {
        number: pr.number,
        node_id: pr.node_id,
        merged: pr.merged,
        state: pr.state,
        merged_at: pr.merged_at,
        merge_commit_sha: pr.merge_commit_sha,
        base: { ref: pr.base.ref },
        head: { ref: pr.head.ref, sha: pr.head.sha },
        user: { id: pr.user.id, login: pr.user.login },
        merged_by: pr.merged_by ? { id: pr.merged_by.id } : null,
      },
      observed_at: observedAt,
      check_conclusions: checkConclusions,
      reviews,
      commit_authors: commitAuthors,
      dco_state: dcoState,
      evidence_coverage: evidenceCoverage,
    }

    // 7) mint inside the trusted path (merged-only profile; verifier self-checks schema + self-consistency)
    const verified = verifyGithubContribution(verifierInput, {
      expectedRepositoryId: a.expectedRepositoryId,
      lifecycle_event: 'merged',
      evidence_scope: 'public_metadata',   // FIXED in 3B-1 — never caller-claimed (no collaborator proof yet)
    })
    if (!verified.ok) {
      if (verified.outcome === 'wrong_repository') return { ok: false, outcome: 'wrong_repository', reasons: verified.reasons }
      return { ok: false, outcome: 'credential_refused', reasons: [verified.outcome, ...verified.reasons] }
    }

    const fetch_metadata: FetchMetadata = {
      fetched_at: observedAt,
      origin: ORIGIN,
      repo_endpoint: repoEndpoint,
      pr_endpoint: prEndpoint,
      repo_status: repoRes.status,
      pr_status: prRes.status,
      api_version: API_VERSION,
      // authoritative per-stream coverage lives in credential.observation.evidence_coverage;
      // mirrored here = streams NOT fully observed (+ self_report, which is never fetched).
      unobserved: [...Object.entries(evidenceCoverage).filter(([, v]) => v !== 'observed').map(([k]) => k), 'self_report'],
      note: 'Audit info for THIS trusted execution only. NOT an independently verifiable signature; a serialized credential cannot be re-verified for source authenticity outside this fetch path (see PR 3B-* / signing).',
    }
    return { ok: true, credential: verified.credential, fetch_metadata }
  } catch {
    return { ok: false, outcome: 'upstream_unavailable', reasons: ['unexpected adapter error'] }   // never leak the token
  }
}
