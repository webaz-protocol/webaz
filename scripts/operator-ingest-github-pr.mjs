#!/usr/bin/env node
/**
 * OPERATOR ingestion pass — merged GitHub PR → credential-backed contribution fact.
 *
 * Manual operator tool (the automatic trigger surface is deferred by design). Run INSIDE the deployed
 * container so it operates on the authoritative volume DB. Plain Node ESM running the BUILT engine (no
 * tsx in prod). Append-only + idempotent at the engine layer (re-run → re_observed); never deletes.
 *
 * SAFETY MODEL (this tool is gated BEFORE it ever touches the engine / DB):
 *   1. Default DRY-RUN — reports what WOULD be ingested and writes nothing. A real write needs --commit.
 *   2. Fail-closed without GITHUB_CONTRIB_READ_TOKEN (the engine re-fetches the PR; token never printed).
 *   3. You MUST pass the EXPECTED actor explicitly: --expected-actor-login + --expected-actor-id.
 *   4. Actor mismatch (PR author ≠ expected login/id) → rejected, no write.
 *   5. The PR author must be a real GitHub USER. An Organization / Bot actor is REJECTED as a personal
 *      claim anchor (DAO posture: an org account is a repo owner / maintainer / merge authority, NOT a
 *      personal identity anchor) — overridable only with --allow-non-user-actor once an explicit
 *      org/entity claim model exists.
 *
 * Usage (dry-run first, ALWAYS):
 *   node scripts/operator-ingest-github-pr.mjs --expected-actor-login=<login> --expected-actor-id=<id> <PR> [<PR> ...]
 *   # then, only after the dry-run looks right:
 *   node scripts/operator-ingest-github-pr.mjs --commit --expected-actor-login=<login> --expected-actor-id=<id> <PR>
 *
 * See docs/runbooks/production-contribution-ingestion.md for the full production checklist
 * (minimal read-only PAT, Railway env, pre-write checks, append-only / irreversibility risk).
 */
import os from 'node:os'
import path from 'node:path'

export const OWNER = 'webaz-protocol'
export const REPO = 'webaz'
export const REPO_NODE_ID = 'R_kgDOS9YurA'   // verified: gh api repos/<o>/<r> --jq .node_id

/**
 * Pure guard: decide whether a PR's author may be ingested as a personal claim anchor.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateActorGuard(prUser, { expectedLogin, expectedActorId, allowNonUser = false }) {
  if (!expectedLogin || !expectedActorId) return { ok: false, reason: 'missing_expected_actor' }
  if (!prUser || prUser.login == null || prUser.id == null) return { ok: false, reason: 'pr_or_actor_not_found' }
  if (String(prUser.id) !== String(expectedActorId) || String(prUser.login) !== String(expectedLogin)) {
    return { ok: false, reason: 'actor_mismatch' }
  }
  // GitHub user objects: type ∈ {'User','Organization','Bot'}. Only a real User can anchor a personal claim.
  if (String(prUser.type) !== 'User' && !allowNonUser) return { ok: false, reason: 'non_user_actor_blocked' }
  return { ok: true }
}

/**
 * Run the pass. Pure-ish orchestration with all side effects injected via `io`, so it is testable
 * offline without GitHub / a DB / the engine.
 *   io = { fetchPr(owner,repo,pr) → {login,id,type}|null, openDb() → { ingest, counts, close }, log }
 * Writes ONLY when `commit === true` AND the actor guard passes; in dry-run io.openDb is never called.
 */
export async function runIngestPass(opts, io) {
  const { prNumbers = [], expectedLogin, expectedActorId, commit = false, allowNonUser = false, token } = opts
  if (!token) return { aborted: 'no_token', results: [] }
  if (!expectedLogin || !expectedActorId) return { aborted: 'missing_expected_actor', results: [] }
  if (prNumbers.length === 0) return { aborted: 'no_pr', results: [] }

  const repositoryMapping = new Map([[`${OWNER}/${REPO}`, REPO_NODE_ID]])
  const results = []
  let dbctx = null
  let before = null

  for (const pr of prNumbers) {
    const prUser = await io.fetchPr(OWNER, REPO, pr)
    const guard = evaluateActorGuard(prUser, { expectedLogin, expectedActorId, allowNonUser })
    if (!guard.ok) { results.push({ pr, action: 'rejected', reason: guard.reason, actor: prUser ? `${prUser.login}#${prUser.id} (${prUser.type})` : null }); continue }
    if (!commit) { results.push({ pr, action: 'would_ingest', actor: `${prUser.login}#${prUser.id}` }); continue }
    // commit path — open the DB lazily on first real write, snapshot once
    if (!dbctx) { dbctx = io.openDb(); before = dbctx.counts() }
    const res = await dbctx.ingest({ owner: OWNER, repo: REPO, prNumber: pr }, { token, repositoryMapping })
    results.push(res.ok
      ? { pr, action: 'ingested', status: res.status, fact_id: res.fact_id, source_event_key: res.source_event_key }
      : { pr, action: 'refused', status: res.status, reason: res.reason, detail: res.detail })
  }
  const after = dbctx ? dbctx.counts() : null
  if (dbctx) dbctx.close()
  return { committed: commit, before, after, delta: (before && after) ? { facts: after.facts - before.facts, creds: after.creds - before.creds, links: after.links - before.links, observations: after.observations - before.observations } : null, results }
}

// CLI entry (guarded so importing the module for tests doesn't run it)
const isCli = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isCli) {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(`--${name}`)
  const opt = (name) => { const p = argv.find(a => a.startsWith(`--${name}=`)); return p ? p.split('=').slice(1).join('=') : undefined }
  const prNumbers = argv.filter(a => /^[0-9]+$/.test(a)).map(Number)
  const token = process.env.GITHUB_CONTRIB_READ_TOKEN
  if (!token) { console.error('✗ GITHUB_CONTRIB_READ_TOKEN not set — abort (no fetch, no write).'); process.exit(2) }

  // build real io with the genuine engine + DB (dynamic import keeps tests dist-free)
  const { setSeamDb } = await import('../dist/layer0-foundation/L0-1-database/db.js')
  const { ingestGithubContribution } = await import('../dist/layer2-business/L2-9-contribution/github-credential-ingestion-engine.js')
  const { default: Database } = await import('better-sqlite3')
  const fetchPr = async (owner, repo, pr) => {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'webaz-operator-ingest' },
    })
    if (!r.ok) { console.error(`  PR #${pr}: GitHub fetch failed (${r.status})`); return null }
    const j = await r.json()
    return j?.user ? { login: j.user.login, id: j.user.id, type: j.user.type } : null
  }
  const openDb = () => {
    const DB_PATH = path.join(os.homedir(), '.webaz', 'webaz.db')
    const db = new Database(DB_PATH)
    // FK enforcement is connection-level in SQLite. The github credential store relies on it for the
    // github_fact_credentials composite FK — an authoritative-ledger writer must NOT lose this backstop.
    db.pragma('foreign_keys = ON')
    const fk = db.prepare('PRAGMA foreign_keys').get()
    if (!fk || fk.foreign_keys !== 1) {   // fail closed BEFORE setSeamDb / any engine write
      try { db.close() } catch {}
      throw new Error('foreign_keys pragma could not be enabled — aborting (no setSeamDb, no write)')
    }
    db.pragma('busy_timeout = 8000')
    setSeamDb(db)
    const counts = () => ({
      facts: db.prepare('SELECT COUNT(*) n FROM contribution_facts').get().n,
      creds: db.prepare('SELECT COUNT(*) n FROM github_contribution_credentials').get().n,
      links: db.prepare('SELECT COUNT(*) n FROM github_fact_credentials').get().n,
      observations: db.prepare('SELECT COUNT(*) n FROM github_credential_observations').get().n,
    })
    return { ingest: ingestGithubContribution, counts, close: () => db.close() }
  }

  const out = await runIngestPass({
    prNumbers,
    expectedLogin: opt('expected-actor-login'),
    expectedActorId: opt('expected-actor-id'),
    commit: flag('commit'),
    allowNonUser: flag('allow-non-user-actor'),
    token,
  }, { fetchPr, openDb })

  if (out.aborted) {
    const hint = {
      missing_expected_actor: 'pass --expected-actor-login=<login> --expected-actor-id=<id>',
      no_pr: 'pass one or more PR numbers',
      no_token: 'set GITHUB_CONTRIB_READ_TOKEN',
    }[out.aborted] || ''
    console.error(`✗ aborted: ${out.aborted}${hint ? ` — ${hint}` : ''}`)
    process.exit(2)
  }
  console.log(`mode: ${out.committed ? 'COMMIT (writing)' : 'DRY-RUN (no write)'}`)
  for (const r of out.results) console.log(JSON.stringify(r))
  if (out.committed) { console.log('before:', JSON.stringify(out.before)); console.log('after: ', JSON.stringify(out.after)); console.log('delta: ', JSON.stringify(out.delta)) }
  const rejected = out.results.filter(r => r.action === 'rejected')
  if (rejected.length) console.error(`\n⚠ ${rejected.length} PR(s) rejected (no write): ${rejected.map(r => `#${r.pr}=${r.reason}`).join(', ')}`)
  process.exit(0)
}
