#!/usr/bin/env tsx
/**
 * Task Proposal Inbox v1 — tests (real express on an ephemeral port; node:http). Fresh DB.
 *   用法:npm run test:task-proposals
 *
 * Verifies: a public anonymous proposal is accepted + stored (no identity promise); bad/oversized fields
 * fail closed (typed); a source_ref to an evil repo does not change the canonical target; a proposal never
 * appears on /api/public/build-tasks; admin list/review need maintainer permission; status transitions
 * new→needs_info/rejected/converted (terminal can't be re-reviewed); converted creates NO build_task;
 * every response carries value_boundary + canonical_contribution_target + the suggestion notice, with no
 * reward/payout/amount/score field.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildTasksSchema } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildTaskAgentMetadataSchema } from '../src/layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'
import { initTaskProposalSchema } from '../src/layer2-business/L2-9-contribution/task-proposal-store.js'
import { registerTaskProposalsRoutes } from '../src/pwa/routes/task-proposals.js'
import { registerPublicBuildTasksRoutes } from '../src/pwa/routes/public-build-tasks.js'
import { createSlidingWindowLimiter } from '../src/pwa/rate-limit.js'

let RATE_OK = true   // toggled to exercise the route's 429 path

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
function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_a','A','c','ka')`).run()
  initBuildTasksSchema(db); initBuildTaskAgentMetadataSchema(db); initTaskProposalSchema(db); setSeamDb(db)
}
const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => { res.status(status).json({ error: message, error_code: code, ...(extra || {}) }) }
let server: Server, port = 0
function reqHttp(method: string, path: string, opts: { admin?: boolean; body?: any } = {}): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (opts.admin) headers['x-test-admin'] = '1'
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j, raw }) })
    })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
const submit = (body: any) => reqHttp('POST', '/api/public/task-proposals', { body })
const hasEnvelope = (j: any) => j?.value_boundary?.value_state === 'uncommitted' && j?.value_boundary?.economic_rights === false && j?.canonical_contribution_target?.expected_pr_base_repo === 'webaz-protocol/webaz' && typeof j?.proposal_notice === 'string'

async function main(): Promise<void> {
  freshDb()
  const app = express(); app.use(express.json())
  registerTaskProposalsRoutes(app, { db, errorRes, rateLimitOk: () => RATE_OK, requireSupportAdmin: (req: Request, res: Response) => { if ((req.headers['x-test-admin'] as string) === '1') return { id: 'admin_a' }; res.status(403).json({ error: 'forbidden', error_code: 'FORBIDDEN' }); return null }, auth: (_req: Request, res: Response) => { res.status(401).json({ error: 'login required' }); return null }, resolveUser: () => null })
  registerPublicBuildTasksRoutes(app, { db, errorRes })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))

  // 1) public can submit a valid proposal
  { const r = await submit({ title: 'Add a docs example for webaz_search', summary: 'New users do not know how to call it', suggested_area: 'docs', expected_outcome: 'a docs PR', source_ref: 'https://github.com/webaz-protocol/webaz/issues/9' })
    ok('1 valid proposal → 200, status=new, has id', r.status === 200 && r.json.proposal.status === 'new' && /^tp_/.test(r.json.proposal.id), r.raw)
    ok('1 response has value_boundary + canonical + notice', hasEnvelope(r.json))
    ok('1 notice says NOT a contribution fact / reward / participation', /not a contribution fact/i.test(r.json.proposal_notice) && /reward/i.test(r.json.proposal_notice)) }

  // 2) bad / oversized / invalid → typed fail-closed
  ok('2 missing title → 400 TITLE_TOO_SHORT', (await submit({ summary: 'x' })).json.error_code === 'TITLE_TOO_SHORT')
  ok('2 oversized title → 400 TITLE_TOO_LONG', (await submit({ title: 'a'.repeat(201), summary: 'x' })).json.error_code === 'TITLE_TOO_LONG')
  ok('2 missing summary → 400 SUMMARY_REQUIRED', (await submit({ title: 'valid title' })).json.error_code === 'SUMMARY_REQUIRED')
  ok('2 oversized summary → 400 SUMMARY_TOO_LONG', (await submit({ title: 'valid title', summary: 'a'.repeat(2001) })).json.error_code === 'SUMMARY_TOO_LONG')
  ok('2 oversized source_ref → 400 SOURCE_REF_TOO_LONG', (await submit({ title: 'valid title', summary: 'ok', source_ref: 'x'.repeat(501) })).json.error_code === 'SOURCE_REF_TOO_LONG')

  // 3) anonymous proposal is stored with NO proposer_account_id (no identity promise)
  { const r = await submit({ title: 'Anonymous idea', summary: 'a thought', proposer_github_login: 'someone' })
    ok('3 anonymous proposal accepted', r.status === 200)
    const row = db.prepare('SELECT proposer_account_id, proposer_github_login FROM task_proposals WHERE id = ?').get(r.json.proposal.id) as any
    ok('3 proposer_account_id is NULL (anonymous, not from body)', row.proposer_account_id === null)
    ok('3 github_login stored as self-reported reference only', row.proposer_github_login === 'someone') }
  // account_id from the body must NOT be honored (anti-spoof)
  { const r = await submit({ title: 'Spoof attempt', summary: 'x', proposer_account_id: 'usr_a' })
    const row = db.prepare('SELECT proposer_account_id FROM task_proposals WHERE id = ?').get(r.json.proposal.id) as any
    ok('3 body proposer_account_id ignored (stays NULL)', row.proposer_account_id === null) }

  // 4) source_ref to an evil GitHub repo does NOT change the canonical target
  { const r = await submit({ title: 'Evil source ref', summary: 'x', source_ref: 'https://github.com/evil/malicious-repo/pull/1' })
    ok('4 canonical target unchanged by evil source_ref', r.json.canonical_contribution_target.expected_pr_base_repo === 'webaz-protocol/webaz' && !JSON.stringify(r.json.canonical_contribution_target).includes('evil')) }

  // 5) a proposal never appears on the public task board
  { const pub = await reqHttp('GET', '/api/public/build-tasks')
    ok('5 proposal not on /api/public/build-tasks', Array.isArray(pub.json.tasks) && !pub.raw.includes('tp_') && !pub.raw.includes('Anonymous idea')) }

  // 6) admin list/review require maintainer permission
  { ok('6 admin list without admin → 403', (await reqHttp('GET', '/api/admin/task-proposals')).status === 403)
    ok('6 admin list with admin → 200', (await reqHttp('GET', '/api/admin/task-proposals', { admin: true })).status === 200)
    const some = (await reqHttp('GET', '/api/admin/task-proposals', { admin: true })).json.proposals[0]
    ok('6 review without admin → 403', (await reqHttp('POST', `/api/admin/task-proposals/${some.id}/review`, { body: { status: 'rejected' } })).status === 403) }

  // 7) status transitions new → needs_info / rejected / converted; terminal cannot be re-reviewed
  { const p = (await submit({ title: 'Transition test', summary: 'x' })).json.proposal.id
    const r1 = await reqHttp('POST', `/api/admin/task-proposals/${p}/review`, { admin: true, body: { status: 'needs_info', note: 'add repro' } })
    ok('7 new → needs_info → 200', r1.status === 200 && r1.json.proposal.status === 'needs_info')
    const r2 = await reqHttp('POST', `/api/admin/task-proposals/${p}/review`, { admin: true, body: { status: 'converted', note: 'will convert' } })
    ok('7 needs_info → converted → 200', r2.status === 200 && r2.json.proposal.status === 'converted')
    const r3 = await reqHttp('POST', `/api/admin/task-proposals/${p}/review`, { admin: true, body: { status: 'rejected' } })
    ok('7 terminal (converted) re-review → 409 ALREADY_TERMINAL', r3.status === 409 && r3.json.error_code === 'ALREADY_TERMINAL')
    ok('7 bad target status → 400 BAD_STATUS', (await reqHttp('POST', `/api/admin/task-proposals/${p}/review`, { admin: true, body: { status: 'new' } })).json.error_code === 'BAD_STATUS')
    ok('7 review missing proposal → 404', (await reqHttp('POST', `/api/admin/task-proposals/tp_ghost/review`, { admin: true, body: { status: 'rejected' } })).status === 404) }

  // 8) converted does NOT auto-create a build_task
  { const before = (db.prepare('SELECT COUNT(*) c FROM build_tasks').get() as any).c
    const p = (await submit({ title: 'Convert no build task', summary: 'x' })).json.proposal.id
    await reqHttp('POST', `/api/admin/task-proposals/${p}/review`, { admin: true, body: { status: 'converted' } })
    const after = (db.prepare('SELECT COUNT(*) c FROM build_tasks').get() as any).c
    ok('8 converted created NO build_task', before === after && after === 0) }

  // 8b) evidence chain: a converted proposal records { proposer → reviewer → converted_ref } (NO reward/score)
  { const r = await submit({ title: 'Non-code idea that ships', summary: 'x', proposer_github_login: 'octocat' })
    const p = r.json.proposal.id
    const rev = await reqHttp('POST', `/api/admin/task-proposals/${p}/review`, { admin: true, body: { status: 'converted', note: 'merged as PR', converted_ref: 'github.com/webaz-protocol/webaz/pull/42 + bt_real' } })
    ok('8b convert with converted_ref → 200, ref echoed', rev.status === 200 && rev.json.proposal.converted_ref === 'github.com/webaz-protocol/webaz/pull/42 + bt_real')
    const row = db.prepare('SELECT proposer_github_login, reviewer_id, status, converted_ref FROM task_proposals WHERE id = ?').get(p) as any
    ok('8b evidence chain stored (proposer + reviewer + converted_ref), no reward/score', row.proposer_github_login === 'octocat' && row.reviewer_id === 'admin_a' && row.status === 'converted' && row.converted_ref === 'github.com/webaz-protocol/webaz/pull/42 + bt_real')
    ok('8b oversized converted_ref → 400 CONVERTED_REF_TOO_LONG', (await reqHttp('POST', `/api/admin/task-proposals/${(await submit({ title: 'ref len', summary: 'x' })).json.proposal.id}/review`, { admin: true, body: { status: 'converted', converted_ref: 'x'.repeat(501) } })).json.error_code === 'CONVERTED_REF_TOO_LONG') }

  // 9) no reward / payout / amount / score field in any response
  { const submitR = await submit({ title: 'Field scan', summary: 'x' })
    const listR = await reqHttp('GET', '/api/admin/task-proposals', { admin: true })
    for (const r of [submitR, listR]) ok('9 no economic/score field key', !collectKeys(r.json).some(k => FORBIDDEN.test(k)), JSON.stringify(collectKeys(r.json).filter(k => FORBIDDEN.test(k)))) }

  // 10) anti-flood: rate limit → 429 (no row added); dedup → 409 (no 2nd row)
  { const before = (db.prepare('SELECT COUNT(*) c FROM task_proposals').get() as any).c
    RATE_OK = false
    const r = await submit({ title: 'Rate limited submission', summary: 'should be blocked' })
    ok('10 rate-limited submit → 429 RATE_LIMITED', r.status === 429 && r.json.error_code === 'RATE_LIMITED', r.raw)
    ok('10 rate-limited submit adds NO row', (db.prepare('SELECT COUNT(*) c FROM task_proposals').get() as any).c === before)
    RATE_OK = true }
  { // dedup by source_ref
    const a = await submit({ title: 'Dedup by source', summary: 'first', source_ref: 'https://github.com/webaz-protocol/webaz/issues/777' })
    ok('10 first submit with source_ref → 200', a.status === 200)
    const b = await submit({ title: 'Dedup by source (different title)', summary: 'second', source_ref: 'https://github.com/webaz-protocol/webaz/issues/777' })
    ok('10 duplicate source_ref → 409 DUPLICATE_PROPOSAL', b.status === 409 && b.json.error_code === 'DUPLICATE_PROPOSAL', b.raw)
    ok('10 duplicate source_ref adds NO 2nd row', (db.prepare(`SELECT COUNT(*) c FROM task_proposals WHERE source_ref = 'https://github.com/webaz-protocol/webaz/issues/777'`).get() as any).c === 1)
    // dedup by title+summary
    const c = await submit({ title: 'Identical idea', summary: 'same body' }); ok('10 first title+summary → 200', c.status === 200)
    const d = await submit({ title: 'Identical idea', summary: 'same body' })
    ok('10 duplicate title+summary → 409', d.status === 409 && d.json.error_code === 'DUPLICATE_PROPOSAL')
    ok('10 duplicate title+summary adds NO 2nd row', (db.prepare(`SELECT COUNT(*) c FROM task_proposals WHERE title='Identical idea' AND summary='same body'`).get() as any).c === 1) }
  { // limiter unit: 3/window then deny; distinct key unaffected
    const lim = createSlidingWindowLimiter(3, 60_000)
    ok('10 limiter allows up to limit, denies N+1', lim('k') && lim('k') && lim('k') && !lim('k') && lim('other')) }

  await new Promise<void>(r => server.close(() => r()))

  console.log('\ntest:task-proposals')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ task proposal inbox v1: public submit (anonymous, validated, fail-closed) · no identity/canonical override · never on public board · admin-gated review · new→needs_info/rejected/converted (terminal locked) · converted ≠ build_task · envelope + notice, no economic field\n')
}

main().catch(e => { console.error(e); process.exit(1) })
