#!/usr/bin/env tsx
/**
 * PR 3B-3b — GitHub credential ingestion engine tests. NO network, NO real token.
 *   用法:npm run test:github-credential-ingestion
 *
 * Fresh in-memory SQLite per scenario (`PRAGMA foreign_keys = ON` + 3B-3a schema + setSeamDb).
 * The engine re-fetches via the 3B-1 adapter using globalThis.fetch — tests SWAP globalThis.fetch
 * (restored in finally; outside a swap a sentinel THROWS, proving zero real network). A FAKE token
 * proves the token is never persisted.
 *
 * Counter-examples first: refusals (unmapped repo / adapter failure / PG fail-closed) · the precise
 * state machine (ingested / re_observed / already_present / credential_upgraded / invariant) ·
 * atomicity rollback · append-only (only INSERT; existing rows byte-stable) · no token/email persisted.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb, setSeamBackend } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { ingestGithubContribution, type IngestResult, type RepositoryMapping } from '../src/layer2-business/L2-9-contribution/github-credential-ingestion-engine.js'
import { sha256hex } from '../src/layer2-business/L2-9-contribution/github-credential/canonical.js'

const ORIGIN = 'https://api.github.com'
const OWNER = 'seasonsagents-art'
const REPO = 'webaz'
const PR = 101
const REPO_ID = 'R_webaz_nodeid'
const TOKEN = 'ghp_FAKE_TEST_TOKEN_xxx_do_not_use'
const repoUrl = `${ORIGIN}/repos/${OWNER}/${REPO}`
const prUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}`
const MAP: RepositoryMapping = new Map([[`${OWNER}/${REPO}`, REPO_ID]])
const deps = { token: TOKEN, repositoryMapping: MAP }

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Canned = { status?: number; headers?: Record<string, string>; json?: any; text?: string }
function mkResponse(c: Canned): any {
  const status = c.status ?? 200
  return {
    status, ok: status >= 200 && status < 300, redirected: false, type: 'default',
    headers: { get: (k: string) => (c.headers ?? {})[k.toLowerCase()] ?? null },
    json: async () => { if (c.text !== undefined) throw new Error('not json'); return c.json },
    text: async () => c.text ?? JSON.stringify(c.json ?? {}),
  }
}
function fakeFetch(routes: Record<string, Canned>, capture?: string[]) {
  return (async (url: any) => {
    capture?.push(String(url))
    const c = routes[String(url)]
    return mkResponse(c ?? { status: 404, json: { message: 'Not Found' } })
  }) as unknown as typeof globalThis.fetch
}
async function withFetch<T>(routes: Record<string, Canned>, capture: string[] | undefined, fn: () => Promise<T>): Promise<T> {
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

const goodRepo = { node_id: REPO_ID, name: REPO, owner: { login: OWNER }, visibility: 'private', id: 123 }
const goodPr = {
  number: PR, node_id: 'PR_kwDO101', merged: true, state: 'closed',
  merged_at: '2026-06-10T12:00:00Z', merge_commit_sha: 'aaaa000000000000000000000000000000000000',
  base: { ref: 'main', repo: { node_id: REPO_ID } }, head: { ref: 'feat/x', sha: '1111111111111111111111111111111111111111' },
  user: { id: 'U_alice', login: 'alice' }, merged_by: { id: 'U_holden', login: 'holden' },
}
const happyRoutes = (): Record<string, Canned> => ({ [repoUrl]: { json: goodRepo }, [prUrl]: { json: goodPr } })

const EXPECTED_SOURCE_EVENT_KEY = `github:${REPO_ID}:${goodPr.node_id}:merged`
const EXPECTED_FACT_ID = `cfact_${sha256hex(EXPECTED_SOURCE_EVENT_KEY).slice(0, 40)}`

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initGithubCredentialStoreSchema(db)
  setSeamDb(db)
  return db
}
const n = (db: Database.Database, t: string): number => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c
const counts = (db: Database.Database) => ({
  cred: n(db, 'github_contribution_credentials'),
  obs: n(db, 'github_credential_observations'),
  fact: n(db, 'contribution_facts'),
  link: n(db, 'github_fact_credentials'),
})
function dumpAll(db: Database.Database): string {
  const tables = ['github_contribution_credentials', 'github_credential_observations', 'contribution_facts', 'github_fact_credentials']
  return JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()))
}

async function main(): Promise<void> {
  // ── REFUSAL: unmapped repo → repository_not_allowed, BEFORE any network, no writes ──
  { const db = freshDb(); const cap: string[] = []
    const r = await withFetch(happyRoutes(), cap, () => ingestGithubContribution({ owner: 'evil', repo: 'x', prNumber: 1 }, deps))
    ok('refuse: unmapped repo → repository_not_allowed', !r.ok && r.reason === 'repository_not_allowed', JSON.stringify(r))
    ok('refuse: unmapped repo → NO network performed (mapping checked first)', cap.length === 0)
    ok('refuse: unmapped repo → no writes', counts(db).cred === 0 && counts(db).fact === 0) }

  // ── REFUSAL: adapter failure propagates (repo 404 → not_found), no writes ──
  { const db = freshDb()
    const r = await withFetch({ [repoUrl]: { status: 404, json: {} } }, undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps))
    ok('refuse: adapter not_found propagates', !r.ok && r.reason === 'not_found', JSON.stringify(r))
    ok('refuse: adapter failure → no writes', counts(db).cred === 0 && counts(db).fact === 0) }

  // ── REFUSAL: PG backend → backend_unsupported (fail-closed), BEFORE any network ──
  { const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); initGithubCredentialStoreSchema(db)
    setSeamBackend({ kind: 'pg', one: async () => undefined, all: async () => [], run: async () => ({ changes: 0, lastInsertRowid: 0 }) })
    const cap: string[] = []
    const r = await withFetch(happyRoutes(), cap, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps))
    ok('refuse: PG backend → backend_unsupported (fail-closed)', !r.ok && r.reason === 'backend_unsupported', JSON.stringify(r))
    ok('refuse: PG backend → NO network performed (backend checked first)', cap.length === 0)
    db.close() }

  // ── HAPPY: first ingest → 'ingested'; exactly one row per table; fact fields never-guessed ──
  let firstCredId = ''
  { const db = freshDb()
    const r = await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ok('ingest: first → ingested', r.ok && r.status === 'ingested', JSON.stringify(r))
    if (r.ok) {
      firstCredId = r.credential_id
      ok('ingest: deterministic fact_id from source_event_key', r.fact_id === EXPECTED_FACT_ID && r.source_event_key === EXPECTED_SOURCE_EVENT_KEY)
      const c = counts(db)
      ok('ingest: exactly one row in each table', c.cred === 1 && c.obs === 1 && c.fact === 1 && c.link === 1, JSON.stringify(c))
      const fact = db.prepare('SELECT * FROM contribution_facts').get() as any
      ok('ingest: fact never-guessed (type NULL, provenance unknown, accountable null, status active, source github)',
        fact.type === null && fact.provenance === 'unknown' && fact.accountable_ref === null && fact.status === 'active' && fact.source === 'github')
      ok('ingest: fact artifact/occurred/executor map from core',
        fact.artifact_ref === goodPr.merge_commit_sha && fact.occurred_at === goodPr.merged_at && fact.executor_ref === 'github:U_alice')
      ok('ingest: immutable defaults to 1', fact.immutable === 1)
      const link = db.prepare('SELECT * FROM github_fact_credentials').get() as any
      ok('ingest: link binds credential → fact with the shared source_event_key', link.fact_id === r.fact_id && link.credential_id === r.credential_id && link.source_event_key === r.source_event_key)
    } }

  // ── RE-OBSERVED: same merge, NEW observed_at → new observation_digest; one new obs, NO new fact ──
  { const db = freshDb()
    const r1 = await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    const before = db.prepare('SELECT core_json, created_at FROM github_contribution_credentials').get() as any
    const factBefore = db.prepare('SELECT * FROM contribution_facts').get() as any
    const r2 = await withTime('2026-06-12T09:09:09.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ok('re_observed: second ingest at a new time → re_observed', r2.ok && r2.status === 're_observed', JSON.stringify(r2))
    const c = counts(db)
    ok('re_observed: one core, TWO observations, ONE fact, ONE link', c.cred === 1 && c.obs === 2 && c.fact === 1 && c.link === 1, JSON.stringify(c))
    ok('re_observed: same fact_id as first', r1.ok && r2.ok && r1.fact_id === r2.fact_id)
    // append-only: the existing core + fact rows are byte-identical after re-ingestion (no in-place edit)
    const after = db.prepare('SELECT core_json, created_at FROM github_contribution_credentials').get() as any
    const factAfter = db.prepare('SELECT * FROM contribution_facts').get() as any
    ok('append-only: existing core row unchanged after re_observed', JSON.stringify(before) === JSON.stringify(after))
    ok('append-only: existing fact row unchanged after re_observed', JSON.stringify(factBefore) === JSON.stringify(factAfter)) }

  // ── ALREADY-PRESENT: identical snapshot (same observed_at) re-ingested → no writes ──
  { const db = freshDb()
    await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    const dumpBefore = dumpAll(db)
    const r2 = await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ok('already_present: identical snapshot re-ingested → already_present', r2.ok && r2.status === 'already_present', JSON.stringify(r2))
    ok('already_present: NO writes at all (every table byte-identical)', dumpAll(db) === dumpBefore)
    ok('already_present: still exactly one fact', counts(db).fact === 1) }

  // ── REPEATED → EXACTLY ONE FACT (idempotency backbone; concurrent racers protected by the same
  //    UNIQUE(source_event_key) + BEGIN IMMEDIATE) ──
  { const db = freshDb()
    for (let i = 0; i < 4; i++) await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ok('idempotent: 4 identical ingests → exactly one fact / one core / one obs', counts(db).fact === 1 && counts(db).cred === 1 && counts(db).obs === 1, JSON.stringify(counts(db))) }

  // ── CREDENTIAL_UPGRADED: a NEW credential_id for an ALREADY-recorded fact (simulates v2→v3) →
  //    new core + obs + a SECOND link to the SAME fact; NO second fact ──
  { const db = freshDb()
    // pre-seed: the fact already exists (deterministic fact_id) + a PRIOR credential evidenced it.
    db.prepare(`INSERT INTO contribution_facts (fact_id, source_event_key, source, type, artifact_ref, occurred_at, executor_ref, accountable_ref, provenance, status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(EXPECTED_FACT_ID, EXPECTED_SOURCE_EVENT_KEY, 'github', null, goodPr.merge_commit_sha, goodPr.merged_at, 'github:U_alice', null, 'unknown', 'active')
    db.prepare(`INSERT INTO github_contribution_credentials (credential_id, core_digest, credential_version, source_event_key, repository_id, pr_node_id, pr_number, merge_commit_sha, merged_at, github_actor_id, lifecycle_event, core_json)
      VALUES ('ghc_prior','dprior','1',?,?,?,?,?,?,?,'merged','{}')`).run(EXPECTED_SOURCE_EVENT_KEY, REPO_ID, goodPr.node_id, PR, goodPr.merge_commit_sha, goodPr.merged_at, 'U_alice')
    db.prepare('INSERT INTO github_fact_credentials (fact_id, credential_id, source_event_key) VALUES (?,?,?)').run(EXPECTED_FACT_ID, 'ghc_prior', EXPECTED_SOURCE_EVENT_KEY)
    const r = await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ok('credential_upgraded: new credential for existing fact → credential_upgraded', r.ok && r.status === 'credential_upgraded', JSON.stringify(r))
    const c = counts(db)
    ok('credential_upgraded: TWO cores, ONE fact, TWO links, ONE new obs', c.cred === 2 && c.fact === 1 && c.link === 2 && c.obs === 1, JSON.stringify(c))
    if (r.ok) {
      const links = db.prepare('SELECT credential_id FROM github_fact_credentials WHERE fact_id = ? ORDER BY credential_id').all(EXPECTED_FACT_ID) as any[]
      ok('credential_upgraded: BOTH credential_ids evidence the SAME fact', links.length === 2 && links.some(l => l.credential_id === 'ghc_prior') && links.some(l => l.credential_id === r.credential_id))
    } }

  // ── ATOMICITY: a mid-transaction failure leaves NONE of the four tables half-written (rollback) ──
  { const db = freshDb()
    const origPrepare = db.prepare.bind(db)
    ;(db as any).prepare = (sql: string) => {
      if (/INSERT INTO contribution_facts/.test(sql)) throw Object.assign(new Error('injected mid-tx failure'), { code: 'INJECTED' })
      return origPrepare(sql)
    }
    let threw = false
    try { await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps))) }
    catch { threw = true }
    ;(db as any).prepare = origPrepare
    ok('atomicity: unexpected mid-tx error fails LOUD (rethrown, not a fake success)', threw)
    const c = counts(db)
    ok('atomicity: rollback → all four tables empty (core+obs were undone)', c.cred === 0 && c.obs === 0 && c.fact === 0 && c.link === 0, JSON.stringify(c)) }

  // ── APPEND-ONLY (mandatory gate): the engine prepares ONLY SELECT/INSERT — never UPDATE/DELETE ──
  { const db = freshDb()
    const prepared: string[] = []
    const origPrepare = db.prepare.bind(db)
    ;(db as any).prepare = (sql: string) => { prepared.push(sql); return origPrepare(sql) }
    // exercise ingested + re_observed so every prepared statement in the engine runs
    await withTime('2026-06-11T00:00:00.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    await withTime('2026-06-12T09:09:09.000Z', () => withFetch(happyRoutes(), undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ;(db as any).prepare = origPrepare
    ok('append-only: engine prepared ≥ 1 statement', prepared.length > 0)
    ok('append-only: every prepared statement is SELECT or INSERT (no UPDATE/DELETE)',
      prepared.every(s => /^\s*(SELECT|INSERT)\b/i.test(s)), prepared.filter(s => !/^\s*(SELECT|INSERT)\b/i.test(s)).join(' | '))
    // static backstop: the engine source carries no UPDATE/DELETE SQL inside any db.prepare(...)
    const engineSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'layer2-business', 'L2-9-contribution', 'github-credential-ingestion-engine.ts'), 'utf8')
    const prepareCalls = engineSrc.match(/db\.prepare\(`?[^`)]*`?\)/g) ?? []
    ok('append-only: no db.prepare(...) contains UPDATE/DELETE in engine source', !prepareCalls.some(p => /\b(UPDATE|DELETE)\b/i.test(p))) }

  // ── NO TOKEN / EMAIL PERSISTED; public attribution IS present (rule 10 + 7) ──
  { const db = freshDb()
    const checksUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/commits/${goodPr.head.sha}/check-runs?per_page=100&page=1`
    const reviewsUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/reviews?per_page=100&page=1`
    const commitsUrl = `${ORIGIN}/repos/${OWNER}/${REPO}/pulls/${PR}/commits?per_page=100&page=1`
    const routes: Record<string, Canned> = {
      ...happyRoutes(),
      [checksUrl]: { json: { check_runs: [] } },
      [reviewsUrl]: { json: [] },
      [commitsUrl]: { json: [{ author: { id: 'U_alice', login: 'alice' }, commit: { author: { name: 'Alice' }, message: 'feat\n\nCo-authored-by: Bob <bob@example.com>' } }] },
    }
    const r = await withTime('2026-06-11T00:00:00.000Z', () => withFetch(routes, undefined, () => ingestGithubContribution({ owner: OWNER, repo: REPO, prNumber: PR }, deps)))
    ok('pii: ingest with co-author evidence succeeds', r.ok && r.status === 'ingested', JSON.stringify(r))
    const dump = dumpAll(db)
    ok('pii: TOKEN never persisted anywhere', !dump.includes(TOKEN))
    ok('pii: no email persisted (rule 10 — no "@" in any stored cell)', !dump.includes('@'))
    ok('pii: public attribution IS stored (github_login present)', dump.includes('alice'))
    ok('pii: co-author name (public) kept, email dropped', dump.includes('Bob') && !dump.includes('bob@example.com')) }

  console.log('\ntest:github-credential-ingestion')
  console.log('────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ all 3B-3b ingestion-engine cases pass (no network; trust re-established; append-only; no token/email persisted)\n')
}

// no-network sentinel: outside an explicit withFetch swap, any real fetch THROWS.
const realFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error('REAL NETWORK BLOCKED IN TEST') }) as any
main().catch(e => { console.error(e); process.exit(1) }).finally(() => { globalThis.fetch = realFetch })
