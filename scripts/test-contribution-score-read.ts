#!/usr/bin/env tsx
/**
 * PR5F — Contribution Score v1 evidence READ surface tests (real express on an ephemeral port; node:http).
 *   用法:npm run test:contribution-score-read
 *
 * Verifies: GET /api/contribution-score/evidence/me requires auth; returns ONLY the caller's own component
 * evidence (other accounts / unbound actors / non-active facts never leak); ignores any account_id /
 * github_actor_id query param; carries the PR5A value_boundary (value_state='uncommitted'); never returns a
 * contribution_score / total / weight / tier / eligibility, nor any economic-promise field key; the route
 * source reads no req.query/req.body and does no DB write; and the collector stays read-only with
 * reverted_penalty 0/[] (not read from fact.status).
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { bindGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'
import { registerContributionScoreRoutes } from '../src/pwa/routes/contribution-score.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const ALICE = 'usr_alice', BOB = 'usr_bob'
const FORBIDDEN = /amount|currency|yield|payout|reward|\bprice\b|promise|\bclaim\b/i
const SCORE_FIELDS = /contribution_score|"score"|total|weight|tier|eligibility/i
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out) }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.push(k); collectKeys((v as any)[k], out) } }
  return out
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any
function seedFact(sek: string, actor: string, factId: string, credId: string, opts: { type?: string | null; status?: string; executorActor?: string } = {}): void {
  const executor = `github:${opts.executorActor ?? actor}`
  db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status) VALUES (?,?,'github',?,'m','t',?,NULL,'unknown',?)`)
    .run(factId, sek, opts.type ?? null, executor, opts.status ?? 'active')
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES (?,?,'2',?,'R','P',1,'m','t',?,'merged','{}')`)
    .run(credId, `dig_${credId}`, sek, actor)
  db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES (?,?,?)`).run(factId, credId, sek)
}
function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','c','ka'),('usr_bob','Bob','c','kb')`).run()
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  setSeamDb(db)
}

const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => {
  res.status(status).json({ error: message, error_code: code, ...(extra || {}) })
}

let server: Server, port = 0
function get(path: string, userId?: string): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (userId) headers['x-test-user'] = userId
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j, raw }) })
    })
    req.on('error', reject); req.end()
  })
}
const byKey = (comps: any[], k: string) => comps.find((c: any) => c.key === k)

async function main(): Promise<void> {
  freshDb()
  await bindGithubIdentity({ githubActorId: 'U_alice', accountId: ALICE, proofMethod: 'github_publication_challenge' })
  await bindGithubIdentity({ githubActorId: 'U_bob', accountId: BOB, proofMethod: 'github_publication_challenge' })
  seedFact('sek:a:code', 'U_alice', 'cf_a_code', 'cr_a_code', { type: 'code' })
  seedFact('sek:a:audit', 'U_alice', 'cf_a_audit', 'cr_a_audit', { type: 'audit' })
  seedFact('sek:a:rev', 'U_alice', 'cf_a_rev', 'cr_a_rev', { type: 'code', status: 'reverted' })   // regression-guard fixture
  seedFact('sek:b:code', 'U_bob', 'cf_b_code', 'cr_b_code', { type: 'code' })
  seedFact('sek:orphan', 'U_orphan', 'cf_orphan', 'cr_orphan', { type: 'code' })

  const app = express()
  app.use(express.json())
  registerContributionScoreRoutes(app, {
    auth: (req: Request, res: Response) => { const u = (req.headers['x-test-user'] as string) || ''; if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } },
    errorRes,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))
  const ME = '/api/contribution-score/evidence/me'

  // 1) no auth → 401
  { const r = await get(ME); ok('1 no auth → 401', r.status === 401, r.raw) }

  // 2) alice sees only alice's evidence
  { const r = await get(ME, ALICE)
    ok('2 alice 200 + evidence_version v1', r.status === 200 && r.json.evidence_version === 'v1', r.raw)
    const accepted = byKey(r.json.components, 'accepted_contributions')
    ok('2 accepted = alice active attributable (cf_a_code, cf_a_audit)', accepted.raw_count === 2 && JSON.stringify([...accepted.evidence_refs].sort()) === JSON.stringify(['cf_a_audit', 'cf_a_code']), JSON.stringify(accepted))
    ok('2 components present (5 keys)', Array.isArray(r.json.components) && r.json.components.length === 5)
    // 3) other-account / unbound / non-active never leak
    ok('3 bob fact not leaked', !r.raw.includes('cf_b_code') && !r.raw.includes('U_bob') && !r.raw.includes(BOB))
    ok('3 orphan (unbound) fact not leaked', !r.raw.includes('cf_orphan'))
    ok('3 reverted (non-active) fact not in accepted', !accepted.evidence_refs.includes('cf_a_rev'))
    ok('3 no account_id / token / nonce / email leak', !/account_id|token|nonce|email|gist/i.test(r.raw))
    // 5) value_boundary
    ok('5 value_boundary.value_state = uncommitted', r.json.value_boundary?.value_state === 'uncommitted', r.raw)
    ok('5 valuation/redemption not_defined + economic_rights false',
      r.json.value_boundary?.valuation_state === 'not_defined' && r.json.value_boundary?.redemption_state === 'not_defined' && r.json.value_boundary?.economic_rights === false)
    // 6) NO score/total/weight/tier/eligibility
    ok('6 no contribution_score/total/weight/tier/eligibility anywhere', !SCORE_FIELDS.test(r.raw), r.raw)
    // 7) no economic-promise field key
    ok('7 no economic-promise field key', !collectKeys(r.json).some(k => FORBIDDEN.test(k)), JSON.stringify(collectKeys(r.json).filter(k => FORBIDDEN.test(k))))
    // 10) collector stays read-only: reverted_penalty 0/[]
    ok('10 reverted_penalty = 0/[] (not read from fact.status)', byKey(r.json.components, 'reverted_penalty').raw_count === 0 && byKey(r.json.components, 'reverted_penalty').evidence_refs.length === 0) }

  // 2b) bob sees only bob's
  { const r = await get(ME, BOB)
    ok('2b bob accepted = [cf_b_code]', byKey(r.json.components, 'accepted_contributions').raw_count === 1 && byKey(r.json.components, 'accepted_contributions').evidence_refs[0] === 'cf_b_code')
    ok('2b bob response has no alice data', !r.raw.includes('cf_a_code') && !r.raw.includes('U_alice')) }

  // 4) query-param injection ignored — still alice's own
  { const r = await get(`${ME}?account_id=${BOB}&github_actor_id=U_bob`, ALICE)
    ok('4 ?account_id/github_actor_id IGNORED (still alice)', r.status === 200 && byKey(r.json.components, 'accepted_contributions').raw_count === 2, r.raw)
    ok('4 injection returns no bob data', !r.raw.includes('cf_b_code') && !r.raw.includes('U_bob')) }

  await new Promise<void>(r => server.close(() => r()))

  // 8/9) route source guard
  { const src = readFileSync(join(HERE, '..', 'src', 'pwa', 'routes', 'contribution-score.ts'), 'utf8')
    ok('8 route reads no req.query/req.body', !/req\.(query|body)/.test(src))
    ok('9 route has no db.prepare/db.exec', !/db\.(prepare|exec)\s*\(/.test(src))
    ok('9 route no INSERT/UPDATE/DELETE/REPLACE', !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(src))
    ok('9 route uses session user.id (never body accountId)', /collectContributionScoreEvidence\(\s*user\.id/.test(src))
    ok('9 route wraps output in withUncommittedValueBoundary', /withUncommittedValueBoundary\s*\(/.test(src)) }

  console.log('\ntest:contribution-score-read')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ score evidence read surface: auth-gated + self-only (no other-account/unbound/non-active leak) + query-injection ignored + value_boundary + NO score/total/weight/tier/eligibility + read-only route\n')
}

main().catch(e => { console.error(e); process.exit(1) })
