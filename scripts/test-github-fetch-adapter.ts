#!/usr/bin/env tsx
/**
 * Authenticated GitHub Fetch Adapter (PR 3B-1) — tests. NO network, NO real token.
 *   用法:npm run test:github-fetch-adapter
 *
 * The production entry takes NO transport/clock injection, so tests temporarily replace
 * globalThis.fetch (restored in finally). Outside a swap, globalThis.fetch is a sentinel that
 * THROWS — proving no test path ever performs a real network call. A FAKE token is used only to
 * prove it never appears in any serialized result.
 *
 * Counter-examples first: args validation · error matrix · trust boundary · never-guess ·
 * token non-leak · PR-number consistency · determinism · happy path.
 */
import { fetchGithubContributionCredential, type FetchResult } from '../src/layer2-business/L2-9-contribution/github-credential/github-fetch-adapter.js'
import { verifyCredentialSelfConsistency } from '../src/layer2-business/L2-9-contribution/github-credential/self-consistency.js'

const ORIGIN = 'https://api.github.com'
const OWNER = 'seasonsagents-art'
const REPO = 'webaz'
const PR = 101
const REPO_ID = 'R_webaz_nodeid'
const TOKEN = 'ghp_FAKE_TEST_TOKEN_xxx_do_not_use'
const repoUrl = `${ORIGIN}/repos/${OWNER}/${REPO}`
const prUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Canned = { status?: number; headers?: Record<string, string>; json?: any; text?: string; throwName?: string; redirected?: boolean; type?: string; hangBodyUntilAbort?: boolean; delayMs?: number }
function mkResponse(c: Canned, init?: any): any {
  const status = c.status ?? 200
  return {
    status, ok: status >= 200 && status < 300, redirected: c.redirected ?? false, type: c.type ?? 'default',
    headers: { get: (k: string) => (c.headers ?? {})[k.toLowerCase()] ?? null },
    json: async () => {
      if (c.hangBodyUntilAbort) {
        // headers returned, but the body read hangs until the adapter's AbortSignal fires → AbortError
        return await new Promise((_resolve, reject) => {
          const sig = init?.signal
          const fail = () => { const e = new Error('aborted'); (e as any).name = 'AbortError'; reject(e) }
          if (sig?.aborted) return fail()
          sig?.addEventListener?.('abort', fail)
        })
      }
      if (c.text !== undefined) throw new Error('not json')
      return c.json
    },
    text: async () => c.text ?? JSON.stringify(c.json ?? {}),
  }
}
function fakeFetch(routes: Record<string, Canned>, capture?: Array<{ url: string; init: any }>) {
  return (async (url: any, init: any) => {
    capture?.push({ url: String(url), init })
    const c = routes[String(url)]
    if (!c) return mkResponse({ status: 404, json: { message: 'Not Found' } }, init)
    if (c.throwName) { const e = new Error('boom'); (e as any).name = c.throwName; throw e }
    if (c.delayMs) {   // slow response (headers), abort-aware → exercises per-page timeout / shared deadline
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, c.delayMs)
        init?.signal?.addEventListener?.('abort', () => { clearTimeout(t); const e = new Error('aborted'); (e as any).name = 'AbortError'; reject(e) })
      })
    }
    return mkResponse(c, init)
  }) as unknown as typeof globalThis.fetch
}
const sleep = (ms: number) => new Promise<'HANG'>(r => setTimeout(() => r('HANG'), ms))
// swap globalThis.fetch for the duration of fn, ALWAYS restore (even on assertion failure / throw)
async function withFetch<T>(routes: Record<string, Canned>, capture: Array<{ url: string; init: any }> | undefined, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = fakeFetch(routes, capture)
  try { return await fn() } finally { globalThis.fetch = orig }
}
async function withTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const Orig = globalThis.Date
  class FakeDate extends Orig { constructor(...args: any[]) { if (args.length) super(...(args as [])); else super(iso) } static now() { return new Orig(iso).getTime() } }
  globalThis.Date = FakeDate as any
  try { return await fn() } finally { globalThis.Date = Orig }
}

const goodRepo = { node_id: REPO_ID, name: REPO, owner: { login: OWNER }, visibility: 'private', id: 123, EXTRA_GH_FIELD: 'ignored' }
const goodPr = {
  number: PR, node_id: 'PR_kwDO101', merged: true, state: 'closed',
  merged_at: '2026-06-10T12:00:00Z', merge_commit_sha: 'aaaa000000000000000000000000000000000000',
  base: { ref: 'main', repo: { node_id: REPO_ID } }, head: { ref: 'feat/x', sha: '1111111111111111111111111111111111111111' },
  user: { id: 'U_alice', login: 'alice' }, merged_by: { id: 'U_holden', login: 'holden' }, EXTRA_GH_FIELD: 'ignored',
}
const base = { owner: OWNER, repo: REPO, prNumber: PR, expectedRepositoryId: REPO_ID, token: TOKEN }
function happyRoutes(repo: any = goodRepo, pr: any = goodPr) { return { [repoUrl]: { json: repo }, [prUrl]: { json: pr } } }

async function main(): Promise<void> {
  // ── ARGS VALIDATION (P2): typed invalid_request / auth_required, NO throw, NO network ──
  type ArgCase = [string, any, string]
  const argCases: ArgCase[] = [
    ['undefined args', undefined, 'invalid_request'],
    ['null args', null, 'invalid_request'],
    ['unknown fetchImpl injected', { ...base, fetchImpl: () => { throw new Error('should never run') } }, 'invalid_request'],
    ['unknown now injected', { ...base, now: new Date('2000-01-01') }, 'invalid_request'],
    ['timeoutMs 0', { ...base, timeoutMs: 0 }, 'invalid_request'],
    ['timeoutMs negative', { ...base, timeoutMs: -5 }, 'invalid_request'],
    ['timeoutMs NaN', { ...base, timeoutMs: NaN }, 'invalid_request'],
    ['timeoutMs Infinity', { ...base, timeoutMs: Infinity }, 'invalid_request'],
    ['timeoutMs over cap', { ...base, timeoutMs: 999_999 }, 'invalid_request'],
    ['non-string token', { ...base, token: 123 }, 'invalid_request'],
    ['empty owner', { ...base, owner: '' }, 'invalid_request'],
    ['blank owner', { ...base, owner: '   ' }, 'invalid_request'],
    ['prNumber 0', { ...base, prNumber: 0 }, 'invalid_request'],
    ['prNumber negative', { ...base, prNumber: -1 }, 'invalid_request'],
    ['prNumber non-integer', { ...base, prNumber: 1.5 }, 'invalid_request'],
    ['evidenceScope injected (valid value) → rejected', { ...base, evidenceScope: 'repo_collaborator_metadata' }, 'invalid_request'],
    ['evidenceScope injected (bad value) → rejected', { ...base, evidenceScope: 'everyone' }, 'invalid_request'],
    ['missing token', { owner: OWNER, repo: REPO, prNumber: PR, expectedRepositoryId: REPO_ID }, 'auth_required'],
    ['blank token', { ...base, token: '   ' }, 'auth_required'],
  ]
  for (const [name, args, expected] of argCases) {
    const cap: Array<{ url: string; init: any }> = []
    let threw = false; let res: FetchResult | undefined
    try { res = await withFetch(happyRoutes(), cap, () => fetchGithubContributionCredential(args)) }
    catch { threw = true }
    ok(`args: ${name} → ${expected} (no throw)`, !threw && !!res && res.ok === false && res.outcome === expected, threw ? 'THREW' : JSON.stringify(res && (res as any).outcome))
    ok(`args: ${name} → no network performed`, cap.length === 0)
    if (res) ok(`args: ${name} → no token leak`, !JSON.stringify(res).includes(TOKEN) && !/authorization/i.test(JSON.stringify(res)))
  }

  // ── ERROR MATRIX — distinct typed outcome, no throw, no token leak ──
  type ErrCase = [string, Record<string, Canned>, string]
  const errorCases: ErrCase[] = [
    ['repo 401', { [repoUrl]: { status: 401, json: {} } }, 'authentication_failed'],
    ['repo 403 forbidden', { [repoUrl]: { status: 403, json: {} } }, 'authentication_failed'],
    ['repo 403 rate limit', { [repoUrl]: { status: 403, headers: { 'x-ratelimit-remaining': '0' }, json: {} } }, 'rate_limited'],
    ['repo 429', { [repoUrl]: { status: 429, json: {} } }, 'rate_limited'],
    ['repo 404', { [repoUrl]: { status: 404, json: {} } }, 'not_found'],
    ['repo 500', { [repoUrl]: { status: 500, json: {} } }, 'upstream_unavailable'],
    ['network error', { [repoUrl]: { throwName: 'TypeError' } }, 'upstream_unavailable'],
    ['timeout/abort', { [repoUrl]: { throwName: 'AbortError' } }, 'timeout'],
    ['redirect (manual, not followed)', { [repoUrl]: { status: 301, headers: { location: 'https://evil.example' } } }, 'upstream_unavailable'],
    ['non-JSON repo', { [repoUrl]: { text: '<html>not json</html>' } }, 'malformed_response'],
    ['malformed repo payload', { [repoUrl]: { json: { name: REPO } } }, 'malformed_response'],
    ['malformed PR payload', { [repoUrl]: { json: goodRepo }, [prUrl]: { json: { number: PR } } }, 'malformed_response'],
    ['unmerged PR', happyRoutes(goodRepo, { ...goodPr, merged: false, merged_at: null, merge_commit_sha: null }), 'credential_refused'],
    ['merged missing merge_commit_sha', happyRoutes(goodRepo, { ...goodPr, merge_commit_sha: null }), 'credential_refused'],
    ['wrong repository id', { [repoUrl]: { json: { ...goodRepo, node_id: 'R_other' } } }, 'wrong_repository'],
    ['PR base repo != target', happyRoutes(goodRepo, { ...goodPr, base: { ref: 'main', repo: { node_id: 'R_fork' } } }), 'wrong_repository'],
    ['response PR number != requested', happyRoutes(goodRepo, { ...goodPr, number: 999 }), 'malformed_response'],
  ]
  for (const [name, routes, expected] of errorCases) {
    let threw = false; let res: FetchResult | undefined
    try { res = await withFetch(routes, undefined, () => fetchGithubContributionCredential(base)) }
    catch { threw = true }
    ok(`error: ${name} → ${expected} (no throw)`, !threw && !!res && res.ok === false && res.outcome === expected, threw ? 'THREW' : JSON.stringify(res && (res as any).outcome))
    if (res) ok(`error: ${name} → no token leak`, !JSON.stringify(res).includes(TOKEN) && !/authorization/i.test(JSON.stringify(res)))
  }

  // ── BODY-READ TIMEOUT (Codex P2): headers returned but json() hangs → typed timeout, no hang ──
  // covers BOTH stages (repo + PR) which share getJson; signal must still fire during res.json().
  for (const [name, routes] of [
    ['repo body hang', { [repoUrl]: { hangBodyUntilAbort: true } }],
    ['PR body hang', { [repoUrl]: { json: goodRepo }, [prUrl]: { hangBodyUntilAbort: true } }],
  ] as Array<[string, Record<string, Canned>]>) {
    const started = Date.now()
    const raced = await withFetch(routes, undefined, () => Promise.race<FetchResult | 'HANG'>([
      fetchGithubContributionCredential({ ...base, timeoutMs: 100 }),
      sleep(3000),
    ]))
    ok(`body-read timeout: ${name} → typed timeout, no hang`, raced !== 'HANG' && (raced as FetchResult).ok === false && (raced as any).outcome === 'timeout', String((raced as any)?.outcome ?? raced))
    ok(`body-read timeout: ${name} → returns well under the 3s guard`, Date.now() - started < 2500)
  }

  // ── HAPPY PATH ──
  const cap: Array<{ url: string; init: any }> = []
  const r = await withFetch(happyRoutes(), cap, () => fetchGithubContributionCredential(base))
  ok('happy: ok credential', r.ok)
  if (r.ok) {
    ok('happy: self-consistency passes', verifyCredentialSelfConsistency(r.credential).ok)
    ok('happy: core matches PR#294 rules', r.credential.core.credential_type === 'github_contribution_credential'
      && r.credential.core.credential_version === '2' && r.credential.core.lifecycle_event === 'merged'
      && r.credential.core.supersedes_credential_id === null && r.credential.core.repository_id === REPO_ID
      && r.credential.core.merge_commit_sha === goodPr.merge_commit_sha && r.credential.core.head_sha === goodPr.head.sha)
    ok('happy: output credential strict (no GitHub EXTRA leaks)', !JSON.stringify(r.credential).includes('EXTRA_GH_FIELD'))
    ok('happy: fetch_metadata is audit-only (not a signature)', /not an independently verifiable signature/i.test(r.fetch_metadata.note))
    ok('happy: unobserved lists checks/reviews/dco', ['checks', 'reviews', 'dco'].every(x => r.fetch_metadata.unobserved.includes(x)))
    ok('happy: no token in success result', !JSON.stringify(r).includes(TOKEN))
    ok('happy: evidence_scope fixed to public_metadata (not caller-claimed)', r.credential.observation.evidence_scope === 'public_metadata')
    ok('happy: no evidence routes → all evidence_coverage unobserved', Object.values(r.credential.observation.evidence_coverage).every(v => v === 'unobserved'))
  }
  ok('happy: core GETs are repo then PR (first two)', cap[0]?.url === repoUrl && cap[1]?.url === prUrl)
  ok('happy: all requests GET to https://api.github.com', cap.every(c => new URL(c.url).origin === ORIGIN && c.init.method === 'GET'))
  ok('happy: Authorization Bearer + Accept + API-Version headers sent', cap.every(c => c.init.headers.Authorization === `Bearer ${TOKEN}`
    && c.init.headers.Accept === 'application/vnd.github+json' && c.init.headers['X-GitHub-Api-Version'] === '2022-11-28'))
  ok('happy: redirect mode manual', cap.every(c => c.init.redirect === 'manual'))

  // ── TRUST BOUNDARY: host cannot be escaped via malicious owner/repo ──
  { const cap2: Array<{ url: string; init: any }> = []
    await withFetch({}, cap2, () => fetchGithubContributionCredential({ ...base, owner: '../../evil.example', repo: 'x/y' }))
    ok('host-escape: Authorization never leaves api.github.com', cap2.every(c => new URL(c.url).origin === ORIGIN)) }

  // ── FORK PR allowed, anchored on base repo ──
  { const forkPr = { ...goodPr, user: { id: 'U_fork', login: 'contributor' } }
    const fr = await withFetch(happyRoutes(goodRepo, forkPr), undefined, () => fetchGithubContributionCredential(base))
    ok('fork PR merged (anchored on base) → ok', fr.ok && fr.credential.core.repository_id === REPO_ID) }

  // ── NEVER GUESS ──
  { const noVis = { ...goodRepo }; delete (noVis as any).visibility
    const nr = await withFetch(happyRoutes(noVis), undefined, () => fetchGithubContributionCredential(base))
    ok('never-guess: missing visibility → unknown', nr.ok && nr.credential.observation.repository_visibility_at_observation === 'unknown') }
  if (r.ok) {
    ok('never-guess: no self-report → provenance unknown', r.credential.observation.agent_provenance === 'unknown')
    ok('never-guess: no self-report → contribution_type null', r.credential.observation.contribution_type === null)
    ok('never-guess: checks/reviews/dco not fetched → no green/approved/present claim',
      r.credential.observation.dco_state === 'unknown' && r.credential.observation.reviews_summary.approved === 0 && r.credential.observation.checks_summary.success === 0)
  }

  // ── DETERMINISM (time controlled via globalThis.Date swap, restored in finally) ──
  const a = await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => fetchGithubContributionCredential(base)))
  const b = await withTime('2026-06-12T09:09:09.000Z', () => withFetch(happyRoutes(), undefined, () => fetchGithubContributionCredential(base)))
  if (a.ok && b.ok) {
    ok('determinism: same fact → same credential_id/core_digest', a.credential.credential_id === b.credential.credential_id && a.credential.core_digest === b.credential.core_digest)
    ok('determinism: observation time change → different observation_digest', a.credential.observation_digest !== b.credential.observation_digest)
  }
  const renamed = await withFetch(happyRoutes({ ...goodRepo, name: 'webaz-renamed', owner: { login: 'renamed-org' } }), undefined, () => fetchGithubContributionCredential(base))
  if (a.ok && renamed.ok) ok('determinism: repo rename (same node_id) → same core_digest', a.credential.core_digest === renamed.credential.core_digest)

  // ── RICHER EVIDENCE (PR 3B-2): coverage / reviews dedup / DCO / co-authors / partial / best-effort ──
  const checksUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/commits/${goodPr.head.sha}/check-runs?per_page=100&page=1`
  const reviewsUrlP = `${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/reviews?per_page=100&page=1`
  const commitsUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/commits?per_page=100&page=1`
  const evRoutes = (ev: Record<string, Canned>) => ({ ...happyRoutes(), ...ev })

  { const routes = evRoutes({
      [checksUrl]: { json: { check_runs: [{ name: 'build', conclusion: 'success' }, { name: 'DCO sign-off check', conclusion: 'success', app: { slug: 'github-actions' } }] } },
      [reviewsUrlP]: { json: [{ state: 'COMMENTED', user: { id: 'R1' } }, { state: 'APPROVED', user: { id: 'R1' } }, { state: 'CHANGES_REQUESTED', user: { id: 'R2' } }] },
      [commitsUrl]: { json: [{ author: { id: 'U_alice', login: 'alice' }, commit: { author: { name: 'Alice' }, message: 'feat\n\nCo-authored-by: Bob <bob@example.com>' } }] },
    })
    const er = await withFetch(routes, undefined, () => fetchGithubContributionCredential(base))
    const cov = er.ok && er.credential.observation.evidence_coverage
    ok('evidence: checks/reviews/commit_authors observed; dco deferred→unobserved', !!cov && cov.checks === 'observed' && cov.reviews === 'observed' && cov.commit_authors === 'observed' && cov.dco === 'unobserved')
    if (er.ok) {
      const o = er.credential.observation
      ok('evidence: reviews dedup/final-state (approved1 changes1 commented0)', o.reviews_summary.approved === 1 && o.reviews_summary.changes_requested === 1 && o.reviews_summary.commented === 0)
      ok('evidence: reviewer_ids deduped (2)', o.reviews_summary.reviewer_ids.length === 2)
      ok('evidence: checks summarized', o.checks_summary.total === 2 && o.checks_summary.success === 2)
      ok('evidence: DCO deferred → dco_state unknown even with a passing DCO check', o.dco_state === 'unknown')
      ok('evidence: co-author from trailer (name only, no id)', o.commit_authors.some(au => au.name === 'Bob' && au.is_coauthor === true && au.author_id === null))
      ok('evidence: NO email anywhere (rule 10)', !JSON.stringify(er.credential).includes('@'))
      ok('evidence: self-consistency still passes', verifyCredentialSelfConsistency(er.credential).ok)
      ok('evidence: no token leak with evidence', !JSON.stringify(er).includes(TOKEN))
    }
  }
  // an UNREPRESENTABLE supplementary item (dropped) downgrades that stream to 'partial' (Codex P2)
  { const er = await withFetch(evRoutes({ [checksUrl]: { json: { check_runs: [] } }, [reviewsUrlP]: { json: [{ state: 'APPROVED', user: { id: 'R1' } }, { state: 'COMMENTED' }] }, [commitsUrl]: { json: [{ author: { id: 'U1' }, commit: { author: { name: 'A' }, message: '' } }] } }), undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: dropped review item (no user) → reviews coverage partial', er.ok && er.credential.observation.evidence_coverage.reviews === 'partial') }
  // Codex P1-a: a review with a user but MISSING/UNKNOWN state is unrepresentable → reviews partial
  { const er = await withFetch(evRoutes({ [checksUrl]: { json: { check_runs: [] } }, [reviewsUrlP]: { json: [{ state: 'APPROVED', user: { id: 'R1' } }, { user: { id: 'R2' } }] }, [commitsUrl]: { json: [{ author: { id: 'U1' }, commit: { author: { name: 'A' }, message: '' } }] } }), undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: review with user but no/unknown state → reviews coverage partial', er.ok && er.credential.observation.evidence_coverage.reviews === 'partial') }
  // Codex P1-b: a commit with NO primary author (only a Co-authored-by trailer) → commit_authors
  // partial (primary completeness independent of co-author), and the co-author is still recorded.
  { const er = await withFetch(evRoutes({ [checksUrl]: { json: { check_runs: [] } }, [reviewsUrlP]: { json: [] }, [commitsUrl]: { json: [{ commit: { message: 'fix\n\nCo-authored-by: Carol <carol@example.com>' } }] } }), undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: commit with only co-author (no primary) → commit_authors partial', er.ok && er.credential.observation.evidence_coverage.commit_authors === 'partial')
    ok('evidence: co-author still recorded despite missing primary (no email)', er.ok && er.credential.observation.commit_authors.some(au => au.name === 'Carol' && au.is_coauthor === true) && !JSON.stringify(er.credential).includes('@')) }
  // Codex P1 (trailer-block strictness): co-authors ONLY from a TRAILING trailer block; mid-body /
  // body-after / empty-email must NOT produce a co-author; a valid trailing trailer must.
  { const coAuthorNames = async (message: string): Promise<string[]> => {
      const er = await withFetch(evRoutes({ [checksUrl]: { json: { check_runs: [] } }, [reviewsUrlP]: { json: [] }, [commitsUrl]: { json: [{ author: { id: 'U_alice', login: 'alice' }, commit: { author: { name: 'Alice' }, message } }] } }), undefined, () => fetchGithubContributionCredential(base))
      return er.ok ? er.credential.observation.commit_authors.filter(a => a.is_coauthor).map(a => a.name ?? '') : ['ERR']
    }
    ok('co-author: valid TRAILING trailer → recorded', (await coAuthorNames('feat\n\nbody\n\nCo-authored-by: Bob <bob@x.com>')).includes('Bob'))
    ok('co-author: trailer with body AFTER (separate paragraph) → ignored', (await coAuthorNames('feat\n\nCo-authored-by: X <x@x.com>\n\nmore body')).length === 0)
    ok('co-author: trailer with body after on same block → ignored', (await coAuthorNames('feat\n\nCo-authored-by: X <x@x.com>\nstill body')).length === 0)
    ok('co-author: empty email → ignored', (await coAuthorNames('feat\n\nCo-authored-by: X <>')).length === 0)
    ok('co-author: no blank before trailer (mid-body) → ignored', (await coAuthorNames('subj\nCo-authored-by: X <x@x.com>')).length === 0) }
  // shared supplementary deadline (Codex P2): a slow paged stream exceeding the budget → partial, no hang
  { const slowFull: Canned = { delayMs: 60, json: Array.from({ length: 100 }, (_, i) => ({ state: 'COMMENTED', user: { id: 'D' + i } })) }   // 60ms < per-page 100ms; budget (~400ms) trips first
    const routes: Record<string, Canned> = { ...happyRoutes(), [checksUrl]: { json: { check_runs: [] } }, [commitsUrl]: { json: [] } }
    for (let p = 1; p <= 10; p++) routes[`${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/reviews?per_page=100&page=${p}`] = slowFull
    const started = Date.now()
    const er = await withFetch(routes, undefined, () => fetchGithubContributionCredential({ ...base, timeoutMs: 100 }))
    ok('evidence: shared deadline → slow reviews stream marked partial', er.ok && er.credential.observation.evidence_coverage.reviews === 'partial', String(er.ok && er.credential.observation.evidence_coverage.reviews))
    ok('evidence: shared deadline bounds total time (well under page-cap×timeout)', Date.now() - started < 2000) }
  // commits: PR total exceeds fetched (250-cap) → partial, even though last page was short
  { const prBig = { ...goodPr, commits: 300 }
    const routes: Record<string, Canned> = { [repoUrl]: { json: goodRepo }, [prUrl]: { json: prBig }, [checksUrl]: { json: { check_runs: [] } }, [reviewsUrlP]: { json: [] } }
    for (let p = 1; p <= 3; p++) routes[`${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/commits?per_page=100&page=${p}`] = { json: Array.from({ length: p < 3 ? 100 : 50 }, () => ({ author: { id: 'U_alice' }, commit: { author: { name: 'A' }, message: '' } })) }
    const er = await withFetch(routes, undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: commits total>fetched (250-cap) → coverage partial', er.ok && er.credential.observation.evidence_coverage.commit_authors === 'partial') }
  // malformed commit ({}) → NO all-null author fabricated
  { const er = await withFetch(evRoutes({ [checksUrl]: { json: { check_runs: [] } }, [reviewsUrlP]: { json: [] }, [commitsUrl]: { json: [{}, { author: { id: 'U_alice' }, commit: { author: { name: 'A' }, message: '' } }] } }), undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: malformed commit → no all-null author', er.ok && er.credential.observation.commit_authors.every(a => a.author_id || a.login || a.name)) }
  { const routes = evRoutes({ [checksUrl]: { status: 500, json: {} }, [reviewsUrlP]: { json: [{ state: 'APPROVED', user: { id: 'R1' } }] }, [commitsUrl]: { json: [] } })
    const er = await withFetch(routes, undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: a stream fetch fails → still mints (best-effort, core already authenticated)', er.ok)
    if (er.ok) {
      const c = er.credential.observation.evidence_coverage
      ok('evidence: failed checks → coverage.checks/dco unobserved, dco_state unknown', c.checks === 'unobserved' && c.dco === 'unobserved' && er.credential.observation.dco_state === 'unknown')
      ok('evidence: other streams still observed', c.reviews === 'observed' && c.commit_authors === 'observed')
      ok('evidence: unobserved checks NOT claimed green', er.credential.observation.checks_summary.success === 0)
      ok('evidence: fetch_metadata.unobserved lists failed checks', er.fetch_metadata.unobserved.includes('checks'))
    } }
  { const full: Canned = { json: Array.from({ length: 100 }, (_, i) => ({ state: 'COMMENTED', user: { id: 'R' + i } })) }
    const routes: Record<string, Canned> = { ...happyRoutes(), [checksUrl]: { json: { check_runs: [] } }, [commitsUrl]: { json: [] } }
    for (let p = 1; p <= 10; p++) routes[`${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/reviews?per_page=100&page=${p}`] = full
    const er = await withFetch(routes, undefined, () => fetchGithubContributionCredential(base))
    ok('evidence: reviews hit page cap → coverage partial (truncation honest)', er.ok && er.credential.observation.evidence_coverage.reviews === 'partial') }

  console.log('\ntest:github-fetch-adapter')
  console.log('─────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ all GitHub fetch adapter cases pass (no network; no injectable transport/clock; token never leaked)\n')
}

// no-network sentinel: outside an explicit withFetch swap, any real fetch THROWS.
const realFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error('REAL NETWORK BLOCKED IN TEST') }) as any
main().catch(e => { console.error(e); process.exit(1) }).finally(() => { globalThis.fetch = realFetch })
