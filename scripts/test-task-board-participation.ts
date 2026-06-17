#!/usr/bin/env tsx
/**
 * PR9C-2 — Task Board participation API tests (real express on an ephemeral port; node:http). Fresh DB.
 *   用法:npm run test:task-board-participation
 *
 * Verifies the participation guard on claim/submit/release: public+open+auto_claimable task is claimable;
 * restricted/internal can't be claimed/submitted/released even by id (404, no existence leak); old
 * no-metadata stays legacy-claimable but is NOT a public agent-ready entry; auto_claimable=false → typed
 * refusal; submit accepts only a canonical-repo PR and rejects an external-repo PR URL; wrong-user
 * submit/release still fail (RFC-006 unchanged); every success carries value_boundary +
 * canonical_contribution_target with no economic field.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildTasksSchema } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildReputationSchema } from '../src/layer2-business/L2-9-contribution/build-reputation-engine.js'
import { initBuildTaskAgentMetadataSchema, insertBuildTaskAgentMetadata, type BuildTaskAgentMetadata } from '../src/layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'
import { registerBuildTasksRoutes } from '../src/pwa/routes/build-tasks.js'
import { registerPublicBuildTasksRoutes } from '../src/pwa/routes/public-build-tasks.js'
import { validatePrRefAgainstCanonical } from '../src/layer2-business/L2-9-contribution/build-task-participation.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const FORBIDDEN = /amount|currency|yield|payout|reward|\bprice\b|promise|\bscore\b/i
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out) }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.push(k); collectKeys((v as any)[k], out) } }
  return out
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any
const META = (over: Partial<BuildTaskAgentMetadata> = {}): BuildTaskAgentMetadata => ({
  task_type: 'docs', allowed_paths: ['docs/**'], forbidden_paths: ['src/**'], prohibited_actions: ['no DB change'],
  risk_level: 'low', audience: 'public', agent_autonomy: 'autonomous', auto_claimable: true,
  human_confirmation_points: ['DCO'], required_capabilities: ['edit markdown'], acceptance_criteria: ['build passes'],
  verification_commands: ['npm run build'], expected_results: 'build passes', deliverables: ['one PR'],
  definition_of_done: 'CI green', estimated_duration_min_minutes: 10, estimated_duration_max_minutes: 15,
  estimated_context_size: 'small', estimated_agent_budget: 'minimal', dependencies: [], blocking_conditions: [],
  value_state: 'uncommitted', contribution_type: 'docs', accountable_party_required: true, ...over,
})
const task = (id: string, status = 'open') => db.prepare(`INSERT INTO build_tasks (id,title,area,status,created_by) VALUES (?,?,?,?,?)`).run(id, 'T ' + id, 'docs', status, 'usr_a')
function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_a','A','c','ka'),('usr_b','B','c','kb'),('usr_c','C','c','kc')`).run()
  db.exec(`CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)`)
  initBuildTasksSchema(db); initBuildTaskAgentMetadataSchema(db); initBuildReputationSchema(db); setSeamDb(db)
  task('bt_claimable'); insertBuildTaskAgentMetadata(db, 'bt_claimable', META())
  task('bt_submit'); insertBuildTaskAgentMetadata(db, 'bt_submit', META())
  task('bt_no_auto'); insertBuildTaskAgentMetadata(db, 'bt_no_auto', META({ auto_claimable: false, agent_autonomy: 'supervised' }))
  task('bt_restricted'); insertBuildTaskAgentMetadata(db, 'bt_restricted', META({ audience: 'restricted', risk_level: 'high', auto_claimable: false, agent_autonomy: 'human_only', human_confirmation_points: ['route to audit'] }))
  task('bt_internal'); insertBuildTaskAgentMetadata(db, 'bt_internal', META({ audience: 'internal', risk_level: 'critical', auto_claimable: false, agent_autonomy: 'human_only', human_confirmation_points: ['route to audit'] }))
  task('bt_old')   // no metadata
}

const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => { res.status(status).json({ error: message, error_code: code, ...(extra || {}) }) }
let server: Server, port = 0
function req(method: string, path: string, userId?: string, body?: any): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (userId) headers['x-test-user'] = userId
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j, raw }) })
    })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
const post = (p: string, u?: string, b?: any) => req('POST', p, u, b ?? {})
const get = (p: string, u?: string) => req('GET', p, u)
const hasEnvelope = (j: any) => j?.value_boundary?.value_state === 'uncommitted' && j?.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz'

async function main(): Promise<void> {
  freshDb()
  const app = express(); app.use(express.json())
  registerBuildTasksRoutes(app, { db, auth: (rq: Request, rs: Response) => { const u = (rq.headers['x-test-user'] as string) || ''; if (!u) { rs.status(401).json({ error: 'unauth' }); return null } return { id: u } }, requireSupportAdmin: () => null })
  registerPublicBuildTasksRoutes(app, { db, errorRes })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))

  // 1) public + open + auto_claimable=true → logged-in user can claim; success carries envelope, no econ field
  { const r = await post('/api/build-tasks/bt_claimable/claim', 'usr_a')
    ok('1 claim public auto_claimable task → 200', r.status === 200 && r.json.status === 'claimed', r.raw)
    ok('1 claim success carries value_boundary + canonical_contribution_target', hasEnvelope(r.json))
    ok('1 claim success has no economic/score field', !collectKeys(r.json).some(k => FORBIDDEN.test(k)), JSON.stringify(collectKeys(r.json).filter(k => FORBIDDEN.test(k)))) }

  // 2) restricted/internal can't be claimed/submitted/released even by id → 404, no existence leak
  for (const id of ['bt_restricted', 'bt_internal']) {
    for (const action of ['claim', 'submit', 'release']) {
      const r = await post(`/api/build-tasks/${id}/${action}`, 'usr_a', { pr_ref: 'https://github.com/webaz-protocol/webaz/pull/1' })
      ok(`2 ${action} ${id} → 404 NOT_FOUND (no leak)`, r.status === 404 && r.json.error_code === 'NOT_FOUND', r.raw)
      ok(`2 ${action} ${id} response leaks no audience/risk_level`, !/restricted|internal|risk_level|audience/i.test(r.raw))
    }
  }

  // 3) old no-metadata task: NOT in public agent-ready entry (absent from public list); legacy member claim still works
  { const pub = await get('/api/public/build-tasks')
    ok('3 old no-metadata task absent from public agent-ready list', !pub.raw.includes('bt_old'))
    const r = await post('/api/build-tasks/bt_old/claim', 'usr_c')
    ok('3 legacy member claim of old task still works (compat)', r.status === 200 && r.json.status === 'claimed', r.raw) }

  // 4) auto_claimable=false public task → typed refusal
  { const r = await post('/api/build-tasks/bt_no_auto/claim', 'usr_a')
    ok('4 claim auto_claimable=false → 409 NOT_AUTO_CLAIMABLE', r.status === 409 && r.json.error_code === 'NOT_AUTO_CLAIMABLE', r.raw)
    ok('4 task not claimed', (db.prepare(`SELECT status FROM build_tasks WHERE id='bt_no_auto'`).get() as any).status === 'open') }

  // 5) submit must target canonical repo — FAIL-CLOSED (Codex P1: lookalike host / non-GitHub / arbitrary text)
  { // 5a) pure-function matrix (strict parse): only canonical github.com URL or #N/N is accepted
    const REJECT: Array<[string, string]> = [
      ['https://evilgithub.com/webaz-protocol/webaz/pull/1', 'WRONG_PR_BASE_REPO'],
      ['https://notgithub.com/webaz-protocol/webaz/pull/1', 'WRONG_PR_BASE_REPO'],
      ['https://github.com.evil.com/webaz-protocol/webaz/pull/1', 'WRONG_PR_BASE_REPO'],
      ['https://gitlab.com/evil/repo/-/merge_requests/1', 'WRONG_PR_BASE_REPO'],
      ['https://github.com/evil/malicious-repo/pull/123', 'WRONG_PR_BASE_REPO'],
      ['evil/malicious-repo#123', 'INVALID_PR_REF'],
      ['just some text', 'INVALID_PR_REF'],
      ['', 'PR_REF_REQUIRED'],
    ]
    for (const [ref, code] of REJECT) { const v = validatePrRefAgainstCanonical(ref); ok(`5a reject pr_ref "${ref}" → ${code}`, !v.ok && v.code === code, JSON.stringify(v)) }
    for (const ref of ['https://github.com/webaz-protocol/webaz/pull/42', '#123', '123']) ok(`5a accept pr_ref "${ref}"`, validatePrRefAgainstCanonical(ref).ok === true)

    // 5b) route-level: each bad ref is rejected (task stays claimed) and the canonical PR URL advances it
    const claim = await post('/api/build-tasks/bt_submit/claim', 'usr_b'); ok('5b setup: usr_b claims bt_submit', claim.status === 200)
    for (const [ref, code] of [
      ['https://github.com/evil/malicious-repo/pull/123', 'WRONG_PR_BASE_REPO'],
      ['https://evilgithub.com/webaz-protocol/webaz/pull/1', 'WRONG_PR_BASE_REPO'],
      ['https://gitlab.com/evil/repo/-/merge_requests/1', 'WRONG_PR_BASE_REPO'],
      ['evil/malicious-repo#123', 'INVALID_PR_REF'],
    ] as Array<[string, string]>) {
      const r = await post('/api/build-tasks/bt_submit/submit', 'usr_b', { pr_ref: ref, note: 'n' })
      ok(`5b route rejects "${ref}" → 400 ${code} + canonical target shown`, r.status === 400 && r.json.error_code === code && r.json.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz', r.raw)
    }
    ok('5b bt_submit NOT advanced by any rejected submit', (db.prepare(`SELECT status FROM build_tasks WHERE id='bt_submit'`).get() as any).status === 'claimed')
    // submit evidence (design contract): a bare pr_ref (no verification_summary) is rejected fail-closed; task stays claimed
    const bare = await post('/api/build-tasks/bt_submit/submit', 'usr_b', { pr_ref: 'https://github.com/webaz-protocol/webaz/pull/42' })
    ok('5b bare pr_ref (no verification_summary) → 400 VERIFICATION_SUMMARY_REQUIRED + canonical target shown', bare.status === 400 && bare.json.error_code === 'VERIFICATION_SUMMARY_REQUIRED' && bare.json.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz', bare.raw)
    ok('5b bt_submit still claimed after bare submit', (db.prepare(`SELECT status FROM build_tasks WHERE id='bt_submit'`).get() as any).status === 'claimed')
    const good = await post('/api/build-tasks/bt_submit/submit', 'usr_b', { pr_ref: 'https://github.com/webaz-protocol/webaz/pull/42', verification_summary: 'ran npm run build + the task verification_commands; all green', note: 'n' })
    ok('5b submit canonical PR URL + verification_summary → 200 in_review', good.status === 200 && good.json.status === 'in_review', good.raw)
    ok('5b submit success carries envelope, no econ field', hasEnvelope(good.json) && !collectKeys(good.json).some(k => FORBIDDEN.test(k))) }

  // 6) wrong-user submit/release still fail (RFC-006 unchanged): bt_claimable is claimed by usr_a
  { const wrongSubmit = await post('/api/build-tasks/bt_claimable/submit', 'usr_b', { pr_ref: 'https://github.com/webaz-protocol/webaz/pull/7' })
    ok('6 wrong-user submit → not advanced (engine refuses)', wrongSubmit.status >= 400, wrongSubmit.raw)
    const wrongRelease = await post('/api/build-tasks/bt_claimable/release', 'usr_b')
    ok('6 wrong-user release → fails', wrongRelease.status >= 400, wrongRelease.raw)
    ok('6 bt_claimable still claimed by usr_a', (db.prepare(`SELECT status, claimer_id FROM build_tasks WHERE id='bt_claimable'`).get() as any).claimer_id === 'usr_a')
    // owner can release
    const rel = await post('/api/build-tasks/bt_claimable/release', 'usr_a')
    ok('6 owner release → 200, carries envelope', rel.status === 200 && hasEnvelope(rel.json), rel.raw) }

  await new Promise<void>(r => server.close(() => r()))

  console.log('\ntest:task-board-participation')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ participation guard: public+auto_claimable claimable · restricted/internal 404 no-leak (claim/submit/release) · old=legacy not public entry · auto_claimable=false typed refusal · submit canonical-only (external repo PR rejected) · wrong-user fails (RFC-006 intact) · envelope everywhere, no economic field\n')
}

main().catch(e => { console.error(e); process.exit(1) })
