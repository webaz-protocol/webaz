#!/usr/bin/env tsx
/**
 * Operator ingestion guards — the safety rails on scripts/operator-ingest-github-pr.mjs.
 *   用法:npm run test:operator-ingest-guards
 *
 * Pure-logic + injected-io tests (no GitHub, no DB, no engine, no dist needed): the actor guard accepts
 * only a matching real USER; the pass fails closed without a token / expected actor / PR, DRY-RUN never
 * opens the DB or calls the engine, a mismatched or organization/bot actor is NEVER ingested even under
 * --commit, and re-running surfaces the engine's idempotent re_observed without a second write claim.
 * (The engine's own append-only idempotency is additionally covered by test:github-credential-ingestion.)
 */
import { readFileSync } from 'node:fs'
import { evaluateActorGuard, runIngestPass, REPOS, OWNER, REPO } from './operator-ingest-github-pr.mjs'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const USER = { login: 'alice', id: 12345, type: 'User' }
const EXP = { expectedLogin: 'alice', expectedActorId: '12345' }

// spy io with a STATEFUL in-memory fake DB so before/after/delta (incl. observations) reflect reality:
// the engine's first observation of a PR → 'ingested' (+fact/cred/link/observation); a re-run →
// 're_observed' (+observation only). statusSeq drives which the fake engine returns per ingest call;
// state + ingest count persist across openDb() calls (mirrors one persistent DB across passes).
function makeIo(prUserByPr: Record<number, any>, statusSeq?: string[]) {
  const calls = { openDb: 0, ingest: 0, fetchPr: 0 }
  const state = { facts: 0, creds: 0, links: 0, observations: 0 }
  const io = {
    fetchPr: async (_o: string, _r: string, pr: number) => { calls.fetchPr++; return prUserByPr[pr] ?? null },
    openDb: () => {
      calls.openDb++
      return {
        ingest: async (_req: any, _deps: any) => {
          calls.ingest++
          const status = statusSeq ? statusSeq[Math.min(calls.ingest - 1, statusSeq.length - 1)] : 'ingested'
          if (status === 'ingested') { state.facts++; state.creds++; state.links++; state.observations++ }
          else if (status === 're_observed') { state.observations++ }   // append-only: no new fact/cred/link
          return { ok: true, status, fact_id: 'cfact_x', source_event_key: 'github:R:PR:merged' }
        },
        counts: () => ({ ...state }),
        close: () => {},
      }
    },
  }
  return { io, calls, state }
}

async function main(): Promise<void> {
  // ── pure actor guard matrix ─────────────────────────────────────────────────────────────────────
  ok('guard: matching real User → ok', evaluateActorGuard(USER, EXP).ok === true)
  ok('guard: id mismatch → actor_mismatch', evaluateActorGuard({ ...USER, id: 999 }, EXP).reason === 'actor_mismatch')
  ok('guard: login mismatch → actor_mismatch', evaluateActorGuard({ ...USER, login: 'bob' }, EXP).reason === 'actor_mismatch')
  ok('guard: Organization actor → non_user_actor_blocked', evaluateActorGuard({ login: 'alice', id: 12345, type: 'Organization' }, EXP).reason === 'non_user_actor_blocked')
  ok('guard: Bot actor → non_user_actor_blocked', evaluateActorGuard({ login: 'alice', id: 12345, type: 'Bot' }, EXP).reason === 'non_user_actor_blocked')
  ok('guard: Organization + allowNonUser → ok (explicit org/entity model)', evaluateActorGuard({ login: 'alice', id: 12345, type: 'Organization' }, { ...EXP, allowNonUser: true }).ok === true)
  ok('guard: null actor → pr_or_actor_not_found', evaluateActorGuard(null, EXP).reason === 'pr_or_actor_not_found')
  ok('guard: missing expected actor → missing_expected_actor', evaluateActorGuard(USER, { expectedLogin: '', expectedActorId: '' }).reason === 'missing_expected_actor')

  // ── pass-level fail-closed ──────────────────────────────────────────────────────────────────────
  { const { io, calls } = makeIo({ 1: USER })
    const r = await runIngestPass({ prNumbers: [1], ...EXP, commit: true }, io)
    ok('no token → aborted, engine/DB never touched', r.aborted === 'no_token' && calls.openDb === 0 && calls.ingest === 0) }
  { const { io } = makeIo({ 1: USER })
    const r = await runIngestPass({ prNumbers: [1], expectedLogin: '', expectedActorId: '', commit: true, token: 't' }, io)
    ok('missing expected actor → aborted', r.aborted === 'missing_expected_actor') }
  { const { io } = makeIo({})
    const r = await runIngestPass({ prNumbers: [], ...EXP, commit: true, token: 't' }, io)
    ok('no PR → aborted', r.aborted === 'no_pr') }

  // ── DRY-RUN never writes ────────────────────────────────────────────────────────────────────────
  { const { io, calls } = makeIo({ 1: USER })
    const r = await runIngestPass({ prNumbers: [1], ...EXP, commit: false, token: 't' }, io)
    ok('dry-run: would_ingest, DB never opened, engine never called', r.results[0].action === 'would_ingest' && calls.openDb === 0 && calls.ingest === 0 && r.committed === false) }

  // ── commit path: matching User ingests; mismatch / org NEVER reach the engine even with --commit ──
  { const { io, calls } = makeIo({ 1: USER })
    const r = await runIngestPass({ prNumbers: [1], ...EXP, commit: true, token: 't' }, io)
    ok('commit + matching User → ingested (engine called once); delta counts fact+observation', r.results[0].action === 'ingested' && calls.ingest === 1 && r.delta?.facts === 1 && r.delta?.observations === 1, JSON.stringify(r.delta)) }
  { const { io, calls } = makeIo({ 7: { ...USER, id: 999 } })
    const r = await runIngestPass({ prNumbers: [7], ...EXP, commit: true, token: 't' }, io)
    ok('commit + actor mismatch → rejected, engine NEVER called', r.results[0].action === 'rejected' && r.results[0].reason === 'actor_mismatch' && calls.ingest === 0 && calls.openDb === 0) }
  { const { io, calls } = makeIo({ 8: { login: 'alice', id: 12345, type: 'Organization' } })
    const r = await runIngestPass({ prNumbers: [8], ...EXP, commit: true, token: 't' }, io)
    ok('commit + org actor → rejected, engine NEVER called', r.results[0].action === 'rejected' && r.results[0].reason === 'non_user_actor_blocked' && calls.ingest === 0) }

  // ── idempotency: re-run → re_observed; observations delta increments, fact/cred/link delta stay 0 ──
  { const { io, calls } = makeIo({ 1: USER }, ['ingested', 're_observed'])
    const r1 = await runIngestPass({ prNumbers: [1], ...EXP, commit: true, token: 't' }, io)
    const r2 = await runIngestPass({ prNumbers: [1], ...EXP, commit: true, token: 't' }, io)
    ok('1st run: ingested (+fact +observation)', r1.results[0].status === 'ingested' && r1.delta?.facts === 1 && r1.delta?.observations === 1)
    ok('re-run: re_observed — fact/cred/link delta 0, observations delta +1 (append-only, no duplicate fact)',
      r2.results[0].status === 're_observed' && r2.delta?.facts === 0 && r2.delta?.creds === 0 && r2.delta?.links === 0 && r2.delta?.observations === 1 && calls.ingest === 2, JSON.stringify(r2.delta)) }

  // ── source contract: the commit DB connection enables FK enforcement + counts observations ──────
  // (the real openDb opens the authoritative volume DB — not exercised offline; assert the source shape)
  { const src = readFileSync(new URL('./operator-ingest-github-pr.mjs', import.meta.url), 'utf8')
    const fkIdx = src.indexOf("pragma('foreign_keys = ON')")
    const seamIdx = src.indexOf('setSeamDb(db)')
    ok('commit openDb enables foreign_keys BEFORE setSeamDb', fkIdx > 0 && seamIdx > fkIdx)
    ok('commit openDb fails closed if foreign_keys != 1 (before any write)', /foreign_keys !== 1/.test(src) && /no setSeamDb, no write/.test(src))
    ok('counts() includes github_credential_observations', /observations:[^\n]*github_credential_observations/.test(src)) }

  // ── multi-repo: repoKey resolves ONLY via the REPOS allowlist (no caller-supplied node id is trusted) ──
  ok('REPOS registry includes canonical + archive repos with their node ids',
    REPOS['webaz-protocol/webaz'] === 'R_kgDOS9YurA' && REPOS['seasonsagents-art/webaz-archive'] === 'R_kgDOSacm8Q')
  { const seen = { fetch: [] as any[], ingest: [] as any[] }
    const io = {
      fetchPr: async (o: string, r: string, pr: number) => { seen.fetch.push([o, r, pr]); return USER },
      openDb: () => ({
        ingest: async (req: any, deps: any) => {
          seen.ingest.push([req.owner, req.repo, [...deps.repositoryMapping.keys()][0], [...deps.repositoryMapping.values()][0]])
          return { ok: true, status: 'ingested', fact_id: 'f', source_event_key: 'k' }
        },
        counts: () => ({ facts: 0, creds: 0, links: 0, observations: 0 }), close: () => {},
      }),
    }
    await runIngestPass({ prNumbers: [292], ...EXP, commit: true, token: 't', repoKey: 'seasonsagents-art/webaz-archive' }, io)
    ok('repoKey → fetchPr receives archive owner/name/pr', seen.fetch[0]?.[0] === 'seasonsagents-art' && seen.fetch[0]?.[1] === 'webaz-archive' && seen.fetch[0]?.[2] === 292)
    ok('repoKey → engine ingest gets archive owner/repo + node-id mapping resolved FROM the allowlist',
      seen.ingest[0]?.[0] === 'seasonsagents-art' && seen.ingest[0]?.[1] === 'webaz-archive' && seen.ingest[0]?.[2] === 'seasonsagents-art/webaz-archive' && seen.ingest[0]?.[3] === 'R_kgDOSacm8Q', JSON.stringify(seen.ingest[0])) }
  { const seen: any[] = []
    const io = { fetchPr: async (o: string, r: string) => { seen.push([o, r]); return USER },
      openDb: () => ({ ingest: async () => ({ ok: true, status: 'ingested' }), counts: () => ({ facts: 0, creds: 0, links: 0, observations: 0 }), close: () => {} }) }
    await runIngestPass({ prNumbers: [1], ...EXP, commit: true, token: 't' }, io)
    ok('no repoKey → backward-compat default to canonical owner/name', seen[0]?.[0] === OWNER && seen[0]?.[1] === REPO) }
  // SECURITY: an unlisted repoKey can NEVER reach fetch / DB / engine — the allowlist is the only source of
  // the trusted repositoryMapping, even for a direct programmatic caller (CLI --repo is just one caller).
  { const calls = { fetch: 0, openDb: 0, ingest: 0 }
    const io = { fetchPr: async () => { calls.fetch++; return USER },
      openDb: () => { calls.openDb++; return { ingest: async () => { calls.ingest++; return { ok: true, status: 'ingested' } }, counts: () => ({ facts: 0, creds: 0, links: 0, observations: 0 }), close: () => {} } } }
    const r = await runIngestPass({ prNumbers: [1], ...EXP, commit: true, token: 't', repoKey: 'evil/repo' }, io)
    ok('unlisted repoKey → aborted unknown_repo, NOTHING fetched/opened/ingested',
      r.aborted === 'unknown_repo' && calls.fetch === 0 && calls.openDb === 0 && calls.ingest === 0, JSON.stringify({ aborted: r.aborted, calls })) }

  if (fail === 0) {
    console.log(`\n✅ operator ingestion guards: actor guard (match-only User; mismatch/org/bot/null rejected; allowNonUser override) · fail-closed (no token / no expected actor / no PR) · DRY-RUN opens no DB + calls no engine · mismatch/org NEVER ingested even with --commit · idempotent re_observed surfaced · repoKey resolves only via REPOS allowlist (unlisted → unknown_repo, no fetch/DB/ingest)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ operator ingestion guards FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
