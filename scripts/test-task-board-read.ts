#!/usr/bin/env tsx
/**
 * PR9C-1 — Task Board read/filter API tests (real express on an ephemeral port; node:http). Fresh DB.
 *   用法:npm run test:task-board-read
 *
 * Verifies: public list = audience=public + status=open only; public detail for restricted/internal → 404
 * (no existence leak); logged-in list/detail return core + parsed agent_metadata; old (no-metadata) tasks
 * return agent_metadata=null; the required filters work; a bad filter fails closed (400 + typed code);
 * every response carries the uncommitted value_boundary; list array fields are parsed arrays; no
 * economic-promise field; and the RFC-006 claim/submit/resolve state machine is unchanged.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildTasksSchema, createBuildTask, claimBuildTask, submitBuildTask, resolveBuildTask } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildReputationSchema } from '../src/layer2-business/L2-9-contribution/build-reputation-engine.js'
import { initBuildTaskAgentMetadataSchema, insertBuildTaskAgentMetadata, type BuildTaskAgentMetadata } from '../src/layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'
import { registerBuildTasksRoutes } from '../src/pwa/routes/build-tasks.js'
import { registerPublicBuildTasksRoutes } from '../src/pwa/routes/public-build-tasks.js'
import { getCanonicalContributionTarget } from '../src/layer2-business/L2-9-contribution/canonical-contribution-target.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const FORBIDDEN = /amount|currency|yield|payout|reward|\bprice\b|promise/i
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
function task(id: string, status: string, opts: { claim_expires_at?: string; claimer_id?: string } = {}): void {
  db.prepare(`INSERT INTO build_tasks (id,title,area,status,created_by,claimer_id,claim_expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, 'T ' + id, 'docs', status, 'usr_a', opts.claimer_id ?? null, opts.claim_expires_at ?? null)
}
function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_a','A','c','ka')`).run()
  db.exec(`CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)`)   // resolveBuildTask(done) reads this
  initBuildTasksSchema(db); initBuildTaskAgentMetadataSchema(db); initBuildReputationSchema(db); setSeamDb(db)
  // public+open, public+claimed, restricted+open, internal+open, old(no-metadata)+open
  // bt_pub carries a MALICIOUS external source_ref — it must never become the canonical contribution target.
  task('bt_pub', 'open'); insertBuildTaskAgentMetadata(db, 'bt_pub', META({ source_ref: 'https://github.com/evil/malicious-repo' }))
  task('bt_pub_claimed', 'claimed'); insertBuildTaskAgentMetadata(db, 'bt_pub_claimed', META())   // claimed, NO expiry → not released
  task('bt_expired', 'claimed', { claimer_id: 'usr_a', claim_expires_at: '2000-01-01 00:00:00' }); insertBuildTaskAgentMetadata(db, 'bt_expired', META({ risk_level: 'medium', agent_autonomy: 'supervised' }))   // expired claim → released to open on read; medium so risk_level filter narrows
  task('bt_restricted', 'open'); insertBuildTaskAgentMetadata(db, 'bt_restricted', META({ audience: 'restricted', risk_level: 'high', auto_claimable: false, agent_autonomy: 'human_only', human_confirmation_points: ['route to audit'] }))
  task('bt_internal', 'open'); insertBuildTaskAgentMetadata(db, 'bt_internal', META({ audience: 'internal', risk_level: 'critical', auto_claimable: false, agent_autonomy: 'human_only', human_confirmation_points: ['route to audit'] }))
  task('bt_old', 'open')   // no metadata
}

const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => { res.status(status).json({ error: message, error_code: code, ...(extra || {}) }) }
let server: Server, port = 0
function get(path: string, userId?: string): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}; if (userId) headers['x-test-user'] = userId
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j, raw }) })
    })
    req.on('error', reject); req.end()
  })
}
const tid = (t: any) => t.task_id || t.id   // public uses task_id; member keeps legacy id
const ids = (tasks: any[]) => tasks.map(tid).sort()

async function main(): Promise<void> {
  freshDb()
  const app = express(); app.use(express.json())
  registerBuildTasksRoutes(app, { db, auth: (req: Request, res: Response) => { const u = (req.headers['x-test-user'] as string) || ''; if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } }, requireSupportAdmin: () => null })
  registerPublicBuildTasksRoutes(app, { db, errorRes })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))

  // 0) RFC-006 claim TTL — an expired claim is auto-released to open BEFORE the read (parity with old list)
  { ok('TTL: bt_expired starts claimed', (db.prepare(`SELECT status FROM build_tasks WHERE id='bt_expired'`).get() as any).status === 'claimed')
    const r = await get('/api/public/build-tasks')
    ok('TTL: after a read, bt_expired auto-released to open', (db.prepare(`SELECT status FROM build_tasks WHERE id='bt_expired'`).get() as any).status === 'open')
    ok('TTL: released bt_expired appears in public open list', r.json.tasks.some((t: any) => tid(t) === 'bt_expired'))
    ok('TTL: claimed-without-expiry (bt_pub_claimed) NOT released → excluded from public', !r.json.tasks.some((t: any) => tid(t) === 'bt_pub_claimed')) }

  // 1) public list = audience=public + status=open only (bt_expired now open after auto-release)
  { const r = await get('/api/public/build-tasks')
    ok('1 public list = [bt_expired, bt_pub] (open+public)', JSON.stringify(ids(r.json.tasks)) === JSON.stringify(['bt_expired', 'bt_pub']), JSON.stringify(ids(r.json.tasks)))
    ok('1 public list excludes claimed/restricted/internal/old', !r.raw.includes('bt_pub_claimed') && !r.raw.includes('bt_restricted') && !r.raw.includes('bt_internal') && !r.raw.includes('bt_old')) }

  // 2) public detail of restricted/internal → 404 (no existence leak)
  { const r1 = await get('/api/public/build-tasks/bt_restricted'); ok('2 public detail restricted → 404', r1.status === 404)
    const r2 = await get('/api/public/build-tasks/bt_internal'); ok('2 public detail internal → 404', r2.status === 404)
    const r3 = await get('/api/public/build-tasks/bt_pub'); ok('2 public detail public+open → 200', r3.status === 200 && r3.json.task.task_id === 'bt_pub') }

  // 3) logged-in list/detail return FULL legacy core + appended agent_metadata; 4) old task agent_metadata=null
  const LEGACY_CORE = ['id', 'title', 'area', 'description', 'rfc_ref', 'status', 'claimer_id', 'claimer_provenance', 'pr_ref', 'claimed_at', 'claim_expires_at', 'created_by', 'resolution', 'resolved_by', 'created_at', 'updated_at']
  { const r = await get('/api/build-tasks', 'usr_a')
    ok('3 member list = public+null (any status), hides restricted/internal', JSON.stringify(ids(r.json.tasks)) === JSON.stringify(['bt_expired', 'bt_old', 'bt_pub', 'bt_pub_claimed']), JSON.stringify(ids(r.json.tasks)))
    ok('3 member list HIDES restricted/internal', !r.raw.includes('bt_restricted') && !r.raw.includes('bt_internal'))
    const pub = r.json.tasks.find((t: any) => tid(t) === 'bt_pub')
    ok('3 member task keeps ALL legacy build_tasks fields (backward-compat)', LEGACY_CORE.every(k => k in pub) && pub.id === 'bt_pub' && pub.title === 'T bt_pub')
    ok('3 member task appends agent_metadata', pub.agent_metadata && pub.agent_metadata.risk_level === 'low')
    const old = r.json.tasks.find((t: any) => tid(t) === 'bt_old')
    ok('4 old (no-metadata) task → agent_metadata: null', old.agent_metadata === null && old.id === 'bt_old')
    const d = await get('/api/build-tasks/bt_pub', 'usr_a')
    ok('3 member detail keeps legacy fields at top level + events (no {task} wrapper)', LEGACY_CORE.every(k => k in d.json) && Array.isArray(d.json.events))
    ok('3 member detail appends full agent_metadata', d.json.agent_metadata.allowed_paths && d.json.agent_metadata.verification_commands && d.json.agent_metadata.definition_of_done)
    const dRestricted = await get('/api/build-tasks/bt_restricted', 'usr_a')
    ok('4b member detail restricted → 404 (no leak)', dRestricted.status === 404) }
  { const noauth = await get('/api/build-tasks'); ok('member list unauth → 401', noauth.status === 401) }

  // 5) required filters (narrowing proven: bt_pub=low, bt_expired=medium)
  { ok('5 filter risk_level=low → [bt_pub]', ids((await get('/api/public/build-tasks?risk_level=low')).json.tasks).join() === 'bt_pub')
    ok('5 filter risk_level=medium → [bt_expired]', ids((await get('/api/public/build-tasks?risk_level=medium')).json.tasks).join() === 'bt_expired')
    ok('5 filter risk_level=high → empty', (await get('/api/public/build-tasks?risk_level=high')).json.tasks.length === 0)
    ok('5 filter auto_claimable=true → [bt_expired, bt_pub]', JSON.stringify(ids((await get('/api/public/build-tasks?auto_claimable=true')).json.tasks)) === JSON.stringify(['bt_expired', 'bt_pub']))
    ok('5 filter area=nope → empty', (await get('/api/public/build-tasks?area=nope')).json.tasks.length === 0) }

  // 6) bad filter → fail-closed 400 + typed error_code
  for (const [q, code] of [['risk_level=extreme', 'INVALID_FILTER_RISK_LEVEL'], ['audience=secret', 'INVALID_FILTER_AUDIENCE'], ['auto_claimable=maybe', 'INVALID_FILTER_AUTO_CLAIMABLE'], ['status=weird', 'INVALID_FILTER_STATUS']] as Array<[string, string]>) {
    const r = await get(`/api/public/build-tasks?${q}`)
    ok(`6 bad filter ${q} → 400 ${code}`, r.status === 400 && r.json.error_code === code, r.raw)
  }
  ok('6 bad filter on member list → 400', (await get('/api/build-tasks?risk_level=extreme', 'usr_a')).status === 400)

  // 7) value_boundary on every response
  { const pl = await get('/api/public/build-tasks'); const pd = await get('/api/public/build-tasks/bt_pub'); const ml = await get('/api/build-tasks', 'usr_a'); const md = await get('/api/build-tasks/bt_pub', 'usr_a')
    ok('7 value_boundary on public list/detail + member list/detail',
      [pl, pd, ml, md].every(r => r.json.value_boundary?.value_state === 'uncommitted' && r.json.value_boundary?.economic_rights === false)) }

  // 8) list array fields are parsed arrays (not raw JSON strings)
  { const pl = await get('/api/public/build-tasks'); const m = pl.json.tasks[0].agent_metadata
    ok('8 required_capabilities is an array', Array.isArray(m.required_capabilities) && m.required_capabilities[0] === 'edit markdown')
    ok('8 estimated_duration is {min,max}', m.estimated_duration.min_minutes === 10 && m.estimated_duration.max_minutes === 15) }

  // 9) no economic-promise field key in any response
  { for (const r of [await get('/api/public/build-tasks'), await get('/api/public/build-tasks/bt_pub'), await get('/api/build-tasks', 'usr_a')]) {
      ok('9 no economic-promise field key', !collectKeys(r.json).some(k => FORBIDDEN.test(k)), JSON.stringify(collectKeys(r.json).filter(k => FORBIDDEN.test(k)))) } }

  // 11) canonical contribution target — trusted constant; identical in all 4 responses; NOT overridable
  //     by a task's source_ref (anti GitHub-target confusion).
  { const pl = await get('/api/public/build-tasks'); const pd = await get('/api/public/build-tasks/bt_pub')
    const ml = await get('/api/build-tasks', 'usr_a'); const md = await get('/api/build-tasks/bt_pub', 'usr_a')
    const targets = [pl, pd, ml, md].map(r => r.json.canonical_contribution_target)
    void getCanonicalContributionTarget()
    ok('11 canonical target present in all 4 responses', targets.every(t => t && t.canonical_repository_full_name === 'webaz-protocol/webaz'))
    ok('11 canonical target IDENTICAL across public+member list+detail', new Set(targets.map(t => JSON.stringify(t))).size === 1, JSON.stringify(targets))
    ok('11 expected_pr_base_repo = canonical (not the evil source_ref repo)', targets.every(t => t.expected_pr_base_repo === 'webaz-protocol/webaz') && !targets.some(t => JSON.stringify(t).includes('evil')))
    ok('11 canonical_github_url + base_branch are the trusted constants', targets[0].canonical_github_url === 'https://github.com/webaz-protocol/webaz' && targets[0].base_branch === 'main')
    ok('11 task source_ref is reference-only, distinct from the canonical target', md.json.agent_metadata.source_ref === 'https://github.com/evil/malicious-repo' && md.json.canonical_contribution_target.expected_pr_base_repo === 'webaz-protocol/webaz')
    ok('11 note: only canonical repo merged PR → contribution fact + STOP if different', /WebAZ contribution fact/i.test(targets[0].note) && /STOP/i.test(targets[0].note))
    ok('11 canonical target carries no economic-promise key', !collectKeys(targets[0]).some(k => FORBIDDEN.test(k))) }

  // 12) PR9G — required_capabilities + max_duration_minutes filters (public + member; no-leak; fail-closed)
  { // distinct task: different caps + longer duration than the uniform fixture (bt_pub = ['edit markdown'], 10–15m)
    task('bt_cap_api', 'open'); insertBuildTaskAgentMetadata(db, 'bt_cap_api', META({ required_capabilities: ['edit JSON', 'read OpenAPI 3'], estimated_duration_min_minutes: 20, estimated_duration_max_minutes: 45, estimated_context_size: 'large', estimated_agent_budget: 'xlarge' }))
    const pub = async (param: string, value: string, userId?: string) => {
      const base = userId ? '/api/build-tasks?' : '/api/public/build-tasks?'
      const r = await get(base + param + '=' + encodeURIComponent(value), userId)
      return { r, a: ((r.json.tasks || []) as any[]).map(tid) }
    }
    // capability: match vs non-match
    { const { r, a } = await pub('required_capabilities', 'edit JSON')
      ok('12 cap filter includes the task that requires it', a.includes('bt_cap_api'), r.raw)
      ok('12 cap filter excludes a non-matching task', !a.includes('bt_pub'), a.join(',')) }
    // capability AND: must require ALL listed
    { const { a } = await pub('required_capabilities', 'edit JSON,read OpenAPI 3'); ok('12 cap AND: task with both → included', a.includes('bt_cap_api')) }
    { const { a } = await pub('required_capabilities', 'edit JSON,python'); ok('12 cap AND: missing one → excluded', !a.includes('bt_cap_api'), a.join(',')) }
    // duration: fit vs not-fit
    { const { a } = await pub('max_duration_minutes', '15'); ok('12 duration ≤15 → short task in, long task out', a.includes('bt_pub') && !a.includes('bt_cap_api'), a.join(',')) }
    { const { a } = await pub('max_duration_minutes', '45'); ok('12 duration ≤45 → both in', a.includes('bt_pub') && a.includes('bt_cap_api')) }
    // NO-LEAK: bt_restricted/bt_internal share caps ['edit markdown'] — a matching filter must still hide them
    { const { a } = await pub('required_capabilities', 'edit markdown'); ok('12 cap filter never leaks restricted/internal', !a.includes('bt_restricted') && !a.includes('bt_internal'), a.join(',')) }
    // member scope: same filters work AND still hide restricted/internal
    { const { a } = await pub('required_capabilities', 'edit JSON', 'usr_a'); ok('12 member scope: cap filter works + no leak', a.includes('bt_cap_api') && !a.includes('bt_restricted') && !a.includes('bt_internal')) }
    // fail-closed: invalid filters → typed 400
    for (const [param, value, code] of [['required_capabilities', '', 'INVALID_FILTER_REQUIRED_CAPABILITIES'], ['max_duration_minutes', 'abc', 'INVALID_FILTER_MAX_DURATION'], ['max_duration_minutes', '-5', 'INVALID_FILTER_MAX_DURATION'], ['max_duration_minutes', '0', 'INVALID_FILTER_MAX_DURATION']] as Array<[string, string, string]>) {
      const r = await get('/api/public/build-tasks?' + param + '=' + encodeURIComponent(value))
      ok(`12 invalid ${param}=${value || '(empty)'} → 400 ${code}`, r.status === 400 && r.json.error_code === code, r.raw)
    }
    // envelope preserved on a filtered response
    { const r = await get('/api/public/build-tasks?max_duration_minutes=45')
      ok('12 filtered response keeps canonical target + value_boundary', r.json.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz' && r.json.value_boundary?.value_state === 'uncommitted') }
  }

  // 13) PR9H — estimated_context_size + estimated_agent_budget enum filters (bt_cap_api = large/xlarge; bt_pub = small/minimal)
  { const pub = async (param: string, value: string, userId?: string) => {
      const base = userId ? '/api/build-tasks?' : '/api/public/build-tasks?'
      const r = await get(base + param + '=' + encodeURIComponent(value), userId)
      return { r, a: ((r.json.tasks || []) as any[]).map(tid) }
    }
    // context_size: match vs non-match
    { const { r, a } = await pub('estimated_context_size', 'large')
      ok('13 context_size=large → bt_cap_api in, bt_pub out', a.includes('bt_cap_api') && !a.includes('bt_pub'), r.raw) }
    { const { a } = await pub('estimated_context_size', 'small'); ok('13 context_size=small → bt_pub in, bt_cap_api out', a.includes('bt_pub') && !a.includes('bt_cap_api'), a.join(',')) }
    // agent_budget: match vs non-match
    { const { a } = await pub('estimated_agent_budget', 'xlarge'); ok('13 agent_budget=xlarge → bt_cap_api in, bt_pub out', a.includes('bt_cap_api') && !a.includes('bt_pub'), a.join(',')) }
    { const { a } = await pub('estimated_agent_budget', 'minimal'); ok('13 agent_budget=minimal → bt_pub in, bt_cap_api out', a.includes('bt_pub') && !a.includes('bt_cap_api'), a.join(',')) }
    // NO-LEAK: restricted/internal default to small/minimal — a matching filter must still hide them
    { const { a } = await pub('estimated_context_size', 'small'); ok('13 context filter never leaks restricted/internal', !a.includes('bt_restricted') && !a.includes('bt_internal'), a.join(',')) }
    { const { a } = await pub('estimated_agent_budget', 'minimal'); ok('13 budget filter never leaks restricted/internal', !a.includes('bt_restricted') && !a.includes('bt_internal'), a.join(',')) }
    // member scope: filters work AND still hide restricted/internal
    { const { a } = await pub('estimated_context_size', 'large', 'usr_a'); ok('13 member context filter works + no leak', a.includes('bt_cap_api') && !a.includes('bt_restricted') && !a.includes('bt_internal')) }
    // fail-closed: invalid enums → typed 400
    for (const [param, value, code] of [['estimated_context_size', 'huge', 'INVALID_FILTER_CONTEXT_SIZE'], ['estimated_agent_budget', 'infinite', 'INVALID_FILTER_AGENT_BUDGET']] as Array<[string, string, string]>) {
      const r = await get('/api/public/build-tasks?' + param + '=' + encodeURIComponent(value))
      ok(`13 invalid ${param}=${value} → 400 ${code}`, r.status === 400 && r.json.error_code === code, r.raw)
    }
    // envelope preserved on a filtered response
    { const r = await get('/api/public/build-tasks?estimated_context_size=large')
      ok('13 filtered response keeps canonical target + value_boundary', r.json.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz' && r.json.value_boundary?.value_state === 'uncommitted') }
  }

  // 14) Codex P3 — agent_capabilities SUBSET filter (tasks the agent can do). bt_cap_api requires
  //   ['edit JSON','read OpenAPI 3']; bt_pub requires ['edit markdown']; restricted/internal require ['edit markdown'].
  { const pub = async (param: string, value: string, userId?: string) => {
      const base = userId ? '/api/build-tasks?' : '/api/public/build-tasks?'
      const r = await get(base + param + '=' + encodeURIComponent(value), userId)
      return { r, a: ((r.json.tasks || []) as any[]).map(tid) }
    }
    // the false-negative case: agent has MORE than the task needs → task IS returned (subset, not AND)
    { const { r, a } = await pub('agent_capabilities', 'edit JSON,read OpenAPI 3,python')
      ok('14 agent has a superset of a task’s reqs → task returned (no false-negative)', a.includes('bt_cap_api'), r.raw)
      ok('14 task needing a capability the agent lacks → excluded', !a.includes('bt_pub'), a.join(',')) }
    // agent missing one required capability → cannot do that task
    { const { a } = await pub('agent_capabilities', 'edit JSON'); ok('14 agent missing one req → task excluded', !a.includes('bt_cap_api'), a.join(',')) }
    { const { a } = await pub('agent_capabilities', 'edit markdown'); ok('14 agent_capabilities=edit markdown → bt_pub in, bt_cap_api out', a.includes('bt_pub') && !a.includes('bt_cap_api'), a.join(',')) }
    // NO-LEAK: restricted/internal require 'edit markdown' (subset of the filter) but must STILL be hidden
    { const { a } = await pub('agent_capabilities', 'edit markdown'); ok('14 subset filter never leaks restricted/internal', !a.includes('bt_restricted') && !a.includes('bt_internal'), a.join(',')) }
    // member scope: subset filter works AND still hides restricted/internal
    { const { a } = await pub('agent_capabilities', 'edit JSON,read OpenAPI 3,python', 'usr_a'); ok('14 member subset filter works + no leak', a.includes('bt_cap_api') && !a.includes('bt_restricted') && !a.includes('bt_internal')) }
    // contrast: required_capabilities (superset/AND) with the SAME input → bt_cap_api EXCLUDED (it doesn't require python).
    //   Proves required_capabilities behavior is unchanged and distinct from agent_capabilities.
    { const { a } = await pub('required_capabilities', 'edit JSON,read OpenAPI 3,python'); ok('14 required_capabilities (AND) unchanged: superset input → task excluded', !a.includes('bt_cap_api'), a.join(',')) }
    // fail-closed: invalid / empty agent_capabilities → typed 400
    for (const value of ['', ',,']) {
      const r = await get('/api/public/build-tasks?agent_capabilities=' + encodeURIComponent(value))
      ok(`14 invalid agent_capabilities="${value}" → 400 INVALID_FILTER_AGENT_CAPABILITIES`, r.status === 400 && r.json.error_code === 'INVALID_FILTER_AGENT_CAPABILITIES', r.raw)
    }
    // envelope preserved on a filtered response
    { const r = await get('/api/public/build-tasks?agent_capabilities=' + encodeURIComponent('edit JSON,read OpenAPI 3'))
      ok('14 filtered response keeps canonical target + value_boundary', r.json.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz' && r.json.value_boundary?.value_state === 'uncommitted') }
  }

  // 15) Codex P2 — subset filter must match BEFORE the 200-row cap. Seed 201 public/open tasks; the only
  //   one the agent can do sorts LAST (oldest updated_at → row 201). With LIMIT-before-filter it was dropped.
  { // seed under a separate creator (not usr_a) so the engine's per-creator anti-flood limit in block 10 is untouched
    const seed = (id: string, caps: string[]) => { db.prepare(`INSERT INTO build_tasks (id,title,area,status,created_by) VALUES (?,?,?,?,?)`).run(id, 'T ' + id, 'docs', 'open', 'usr_seed'); insertBuildTaskAgentMetadata(db, id, META({ required_capabilities: caps })) }
    for (let i = 0; i < 200; i++) seed('bt_fill_' + i, ['edit markdown'])
    seed('bt_needle', ['python'])
    db.prepare(`UPDATE build_tasks SET updated_at='2000-01-01 00:00:00' WHERE id='bt_needle'`).run()   // → sorts last
    const r = await get('/api/public/build-tasks?agent_capabilities=' + encodeURIComponent('python'))
    const a = ((r.json.tasks || []) as any[]).map(tid)
    ok('15 needle past row 200 IS found by agent_capabilities subset (no LIMIT false-negative)', a.includes('bt_needle'), `count=${a.length}`)
    // the SQL-side required_capabilities filter never had this bug (LIMIT applies after the WHERE) — sanity
    const r2 = await get('/api/public/build-tasks?required_capabilities=' + encodeURIComponent('python'))
    ok('15 required_capabilities=python also finds the needle', ((r2.json.tasks || []) as any[]).map(tid).includes('bt_needle')) }

  await new Promise<void>(r => server.close(() => r()))

  // 10) RFC-006 claim/submit/resolve state machine unchanged
  { const created: any = createBuildTask(db, { creatorId: 'usr_a', title: 'RFC-006 regression task', area: 'docs' } as any)
    ok('10 createBuildTask ok', !('error' in created))
    ok('10 claim open→claimed', !('error' in claimBuildTask(db, created.id, 'usr_a', 'human')))
    ok('10 submit claimed→in_review', !('error' in submitBuildTask(db, created.id, 'usr_a', 'PR#1', 'note')))
    ok('10 resolve in_review→done', !('error' in resolveBuildTask(db, created.id, 'done', 'usr_a', 'ok'))) }

  console.log('\ntest:task-board-read')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ task board read: public=public+open only · restricted/internal never leaked (404) · member core+metadata · old→agent_metadata:null · filters + fail-closed 400 · value_boundary + canonical_contribution_target (trusted, identical, not overridable by source_ref) everywhere · parsed arrays · no economic field · RFC-006 state machine intact\n')
}

main().catch(e => { console.error(e); process.exit(1) })
