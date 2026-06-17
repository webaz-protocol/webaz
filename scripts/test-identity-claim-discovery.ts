#!/usr/bin/env tsx
/**
 * F10 — claimable GitHub contribution discovery (engine + route, behavioral). Fresh in-memory DB.
 *   用法:npm run test:identity-claim-discovery
 *
 * Verifies: only active + github-source + credential-backed + executor-matching facts whose actor is NOT
 * bound by ANY account appear; inactive / non-github / unlinked / actor-mismatched / other-bound /
 * self-bound facts never appear (self-bound facts surface via /github/me instead); the output carries no
 * secret (account_id / credential_id / core digest / token / nonce / nonce_hash / proof material); the
 * route is auth-gated, anchors the account context on the SESSION user (an ?account_id= injection is
 * ignored), wraps the response in the uncommitted-value boundary; and discovery performs ZERO writes
 * (no challenge issued, no binding/fact/link row changed) — also asserted statically (SELECT-only source).
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { listClaimableGithubIdentityFacts } from '../src/layer2-business/L2-9-contribution/identity-claim-discovery.js'
import { getMyGithubIdentitySurface } from '../src/layer2-business/L2-9-contribution/identity-claim-read.js'
import { registerContributionIdentityRoutes } from '../src/pwa/routes/contribution-identity.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
// minimal mirrors of the prod tables (only the columns the engines read)
db.exec(`CREATE TABLE contribution_facts (fact_id TEXT PRIMARY KEY, source_event_key TEXT UNIQUE, source TEXT, type TEXT, artifact_ref TEXT, occurred_at TEXT, executor_ref TEXT, provenance TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE github_contribution_credentials (credential_id TEXT PRIMARY KEY, source_event_key TEXT, github_actor_id TEXT, repository_id TEXT, pr_number INTEGER, merge_commit_sha TEXT, merged_at TEXT, lifecycle_event TEXT DEFAULT 'merged')`)
db.exec(`CREATE TABLE github_fact_credentials (fact_id TEXT, credential_id TEXT, source_event_key TEXT)`)
db.exec(`CREATE TABLE identity_bindings_active (github_actor_id TEXT PRIMARY KEY, account_id TEXT, visibility TEXT DEFAULT 'private', bound_at TEXT DEFAULT (datetime('now')))`)
setSeamDb(db)

// seed: a full credential-backed fact for ACTOR, plus every negative-case variant
const fact = (id: string, sek: string, over: Record<string, unknown> = {}) => {
  const row = { fact_id: id, source_event_key: sek, source: 'github', type: 'merged_pr', artifact_ref: 'sha_' + id, occurred_at: '2026-06-10 00:00:00', executor_ref: '', provenance: 'authenticated_fetch', status: 'active', ...over }
  db.prepare(`INSERT INTO contribution_facts (fact_id, source_event_key, source, type, artifact_ref, occurred_at, executor_ref, provenance, status) VALUES (@fact_id,@source_event_key,@source,@type,@artifact_ref,@occurred_at,@executor_ref,@provenance,@status)`).run(row)
}
const cred = (cid: string, sek: string, actor: string, pr: number, mergedAt = '2026-06-12 00:00:00') =>
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id, source_event_key, github_actor_id, repository_id, pr_number, merge_commit_sha, merged_at) VALUES (?,?,?,?,?,?,?)`).run(cid, sek, actor, 'R_repo1', pr, 'mc_' + cid, mergedAt)
const link = (fid: string, cid: string, sek: string) =>
  db.prepare(`INSERT INTO github_fact_credentials (fact_id, credential_id, source_event_key) VALUES (?,?,?)`).run(fid, cid, sek)

// ✓ claimable: active, credential-backed, executor matches, actor unbound
fact('f_ok', 'sek_ok', { executor_ref: 'github:111' }); cred('c_ok', 'sek_ok', '111', 1); link('f_ok', 'c_ok', 'sek_ok')
// ✗ inactive fact
fact('f_rev', 'sek_rev', { executor_ref: 'github:112', status: 'reverted' }); cred('c_rev', 'sek_rev', '112', 2); link('f_rev', 'c_rev', 'sek_rev')
// ✗ non-github source
fact('f_gov', 'sek_gov', { source: 'governance', executor_ref: 'github:113' }); cred('c_gov', 'sek_gov', '113', 3); link('f_gov', 'c_gov', 'sek_gov')
// ✗ no credential link
fact('f_nolink', 'sek_nolink', { executor_ref: 'github:114' }); cred('c_nolink', 'sek_nolink', '114', 4)
// ✗ executor mismatch (credential actor != fact executor)
fact('f_mismatch', 'sek_mm', { executor_ref: 'github:999' }); cred('c_mm', 'sek_mm', '115', 5); link('f_mismatch', 'c_mm', 'sek_mm')
// ✗ actor bound by ANOTHER account
fact('f_other', 'sek_other', { executor_ref: 'github:116' }); cred('c_other', 'sek_other', '116', 6); link('f_other', 'c_other', 'sek_other')
db.prepare(`INSERT INTO identity_bindings_active (github_actor_id, account_id) VALUES ('116', 'usr_other')`).run()
// ✗ in claimable / ✓ in /github/me: actor bound by the CURRENT account
fact('f_mine', 'sek_mine', { executor_ref: 'github:117' }); cred('c_mine', 'sek_mine', '117', 7); link('f_mine', 'c_mine', 'sek_mine')
db.prepare(`INSERT INTO identity_bindings_active (github_actor_id, account_id) VALUES ('117', 'usr_me')`).run()

const snapshot = () => JSON.stringify(['contribution_facts', 'github_fact_credentials', 'github_contribution_credentials', 'identity_bindings_active'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))

let server: Server, port = 0
const get = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const r = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = JSON.parse(raw) } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.end()
})

async function main(): Promise<void> {
  const before = snapshot()

  // ── engine ───────────────────────────────────────────────────────────────────────────────────────
  const r = await listClaimableGithubIdentityFacts('usr_me')
  const ids = r.claimable_facts.map(f => f.fact_id)
  ok('claimable: qualifying fact appears', ids.includes('f_ok'), ids.join(','))
  ok('claimable: ONLY the qualifying fact appears', ids.length === 1, ids.join(','))
  for (const [bad, why] of [['f_rev', 'inactive'], ['f_gov', 'non-github'], ['f_nolink', 'no credential link'], ['f_mismatch', 'executor mismatch'], ['f_other', 'actor bound by another account'], ['f_mine', 'actor bound by current account']] as const) {
    ok(`excluded: ${bad} (${why})`, !ids.includes(bad))
  }
  // the self-bound fact surfaces via /github/me instead
  const me = await getMyGithubIdentitySurface('usr_me')
  ok('self-bound fact appears in /github/me attributable_facts (not claimable)', me.attributable_facts.some(f => f.fact_id === 'f_mine'))
  // display fields present, secrets absent
  const row0 = r.claimable_facts[0] as Record<string, unknown>
  for (const f of ['fact_id', 'source_event_key', 'github_actor_id', 'repository_id', 'pr_number', 'merge_commit_sha', 'merged_at', 'lifecycle_event', 'artifact_ref']) ok(`field present: ${f}`, f in row0)
  const SECRET = /account_id|credential_id|core_json|core_digest|token|nonce|proof_marker/i
  ok('no secret key in the engine output', !Object.keys(row0).some(k => SECRET.test(k)), Object.keys(row0).join(','))

  // ── route ────────────────────────────────────────────────────────────────────────────────────────
  const app = express(); app.use(express.json())
  let authedAs: string | null = 'usr_me'
  registerContributionIdentityRoutes(app, {
    auth: ((_req: Request, res: Response) => { if (!authedAs) { res.status(401).json({ error: 'unauth' }); return null } return { id: authedAs } }) as any,
    requireHumanPresence: (() => ({ ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED' })) as any,
    errorRes: ((res: any, status: number, code: string, message: string, extra: any) => res.status(status).json({ error: message, error_code: code, ...(extra || {}) })) as any,
    getGithubReadToken: () => undefined,
  })
  server = createServer(app)
  await new Promise<void>(rr => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; rr() }))

  { authedAs = null
    const res = await get('/api/contribution-identity/github/claimable')
    ok('route: unauthenticated → 401', res.status === 401) }
  { authedAs = 'usr_me'
    const res = await get('/api/contribution-identity/github/claimable')
    ok('route: 200 + claimable_facts', res.status === 200 && res.json?.claimable_facts?.length === 1)
    ok('route: uncommitted value boundary present', res.json?.value_boundary?.value_state === 'uncommitted')
    const inj = await get('/api/contribution-identity/github/claimable?account_id=usr_other&github_actor_id=116')
    ok('route: ?account_id / actor injection ignored (same session-scoped result)', JSON.stringify(inj.json?.claimable_facts) === JSON.stringify(res.json?.claimable_facts))
    ok('route: response carries no secret key', !JSON.stringify(res.json).match(/credential_id|core_digest|nonce|proof_marker|"token"/i)) }
  server.close()

  // ── zero writes (behavioral + static) ────────────────────────────────────────────────────────────
  ok('discovery performed ZERO writes (tables byte-identical)', snapshot() === before)
  const engineSrc = readFileSync(join(ROOT, 'src/layer2-business/L2-9-contribution/identity-claim-discovery.ts'), 'utf8')
  ok('engine source is SELECT-only (no INSERT/UPDATE/DELETE, no challenge issuance)',
    !/INSERT|UPDATE|DELETE/i.test(engineSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')) && !/issueGithubIdentityClaimChallenge|claimGithubIdentity/.test(engineSrc))

  if (fail === 0) {
    console.log(`\n✅ identity-claim discovery (F10): qualifying fact only · inactive/non-github/unlinked/mismatched/other-bound/self-bound all excluded (self-bound → /github/me) · minimal display fields, zero secrets · route auth-gated + session-anchored (injection ignored) + uncommitted boundary · ZERO writes (behavioral + SELECT-only source)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ identity-claim discovery FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
