#!/usr/bin/env tsx
/**
 * PR9D — MCP webaz_contribute wiring tests (behavioral). Drives the REAL handleContribute() against an
 * ephemeral express server hosting the actual #329 public read routes, #330-guarded member participation
 * routes, and the #331 public proposal inbox (fresh in-memory DB). Run in network_readonly (no api_key):
 *   用法:npm run test:mcp-contribute
 *
 * Verifies the wiring decided in PR9D:
 *   · Discovery is KEYLESS and uses the PUBLIC surface — list_open / detail return the rich execution
 *     boundary + the trusted canonical_contribution_target + value_boundary, and restricted/internal/old
 *     tasks never appear (no leak). Filters (area/risk_level/auto_claimable) pass through.
 *   · detail attaches a copy-ready agent_handoff sourced FROM the response's canonical target (not a
 *     hardcoded/metadata repo), naming the canonical-repo PR rule + that sandbox/local draft ≠ participation.
 *   · suggest is KEYLESS → returns a proposal id + a "this is a suggestion, not a contribution/reward"
 *     note, and surfaces typed DUPLICATE_PROPOSAL / RATE_LIMITED.
 *   · Participation (claim/submit/status/profile) REQUIRES an api_key (typed API_KEY_REQUIRED without one);
 *     claim returns a handoff with the canonical repo; submit is rejected unless pr_ref targets canonical.
 *   · No economic field (amount/reward/payout/score/price) appears in any response.
 *
 * NB (dual-mode lesson): handleContribute reads WEBAZ_API_URL/MODE as module-load consts, so we set the
 * URL + clear WEBAZ_API_KEY/WEBAZ_MODE (→ network_readonly) BEFORE dynamically importing the server.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildTasksSchema } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildTaskAgentMetadataSchema, insertBuildTaskAgentMetadata, type BuildTaskAgentMetadata } from '../src/layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'
import { initTaskProposalSchema } from '../src/layer2-business/L2-9-contribution/task-proposal-store.js'
import { registerBuildTasksRoutes } from '../src/pwa/routes/build-tasks.js'
import { registerPublicBuildTasksRoutes } from '../src/pwa/routes/public-build-tasks.js'
import { registerTaskProposalsRoutes } from '../src/pwa/routes/task-proposals.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const FORBIDDEN = /amount|currency|yield|payout|reward|\bprice\b|promise|\bscore\b/i
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out) }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.push(k); collectKeys((v as any)[k], out) } }
  return out
}
const noEcon = (j: unknown) => !collectKeys(j).some(k => FORBIDDEN.test(k))

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any
let RATE_OK = true
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
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_a','A','c','ka'),('usr_b','B','c','kb')`).run()
  initBuildTasksSchema(db); initBuildTaskAgentMetadataSchema(db); initTaskProposalSchema(db); setSeamDb(db)
  task('bt_claimable'); insertBuildTaskAgentMetadata(db, 'bt_claimable', META())
  task('bt_submit'); insertBuildTaskAgentMetadata(db, 'bt_submit', META())
  task('bt_no_auto'); insertBuildTaskAgentMetadata(db, 'bt_no_auto', META({ auto_claimable: false, agent_autonomy: 'supervised' }))
  task('bt_restricted'); insertBuildTaskAgentMetadata(db, 'bt_restricted', META({ audience: 'restricted', risk_level: 'high', auto_claimable: false, agent_autonomy: 'human_only' }))
  task('bt_internal'); insertBuildTaskAgentMetadata(db, 'bt_internal', META({ audience: 'internal', risk_level: 'critical', auto_claimable: false, agent_autonomy: 'human_only' }))
  task('bt_old')   // no metadata
  // distinct caps + longer duration than the uniform fixture — for the filter-passthrough checks
  task('bt_cap'); insertBuildTaskAgentMetadata(db, 'bt_cap', META({ required_capabilities: ['edit JSON', 'read OpenAPI 3'], estimated_duration_min_minutes: 30, estimated_duration_max_minutes: 60, estimated_context_size: 'large', estimated_agent_budget: 'xlarge' }))
}

const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => { res.status(status).json({ error: message, error_code: code, ...(extra || {}) }) }

async function main(): Promise<void> {
  freshDb()
  const app = express(); app.use(express.json())
  // member auth: Bearer api_key → user row (real lookup, like production)
  const auth = (rq: Request, rs: Response) => {
    const h = (rq.headers.authorization as string) || ''
    const key = h.startsWith('Bearer ') ? h.slice(7) : ''
    const u = key ? db.prepare('SELECT id FROM users WHERE api_key = ?').get(key) : null
    if (!u) { rs.status(401).json({ error: 'unauth' }); return null }
    return u
  }
  registerBuildTasksRoutes(app, { db, auth: auth as any, requireSupportAdmin: () => null })
  registerPublicBuildTasksRoutes(app, { db, errorRes })
  // optional resolver (no 401) — mirrors production getUser(): links a submission to the logged-in submitter.
  const resolveUser = (rq: Request) => {
    const h = (rq.headers.authorization as string) || ''
    const key = h.startsWith('Bearer ') ? h.slice(7) : ((rq.body?.api_key as string) || '')
    return key ? (db.prepare('SELECT id FROM users WHERE api_key = ?').get(key) || null) : null
  }
  registerTaskProposalsRoutes(app, { db, errorRes, requireSupportAdmin: () => null, rateLimitOk: () => RATE_OK, auth: auth as any, resolveUser: resolveUser as any })
  const server: Server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => r()))
  const port = (server.address() as any).port

  // set the network target + force network_readonly BEFORE importing the server module (consts at load)
  process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`
  delete process.env.WEBAZ_API_KEY
  delete process.env.WEBAZ_MODE
  const { handleContribute } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
  const call = (args: Record<string, unknown>) => handleContribute(args)

  // ── 1) list_open is KEYLESS, uses the public surface, hides restricted/internal/old, carries the trust envelope
  { const r = await call({ action: 'list_open' })
    const ids = (r.tasks as any[] ?? []).map(t => t.task_id)
    ok('1 list_open works with NO api_key', !r.error && Array.isArray(r.tasks), r.error as string)
    ok('1 list_open shows the public/open task', ids.includes('bt_claimable'))
    ok('1 list_open hides restricted/internal/old (no leak)', !ids.includes('bt_restricted') && !ids.includes('bt_internal') && !ids.includes('bt_old'), ids.join(','))
    ok('1 list_open carries the trusted canonical target', (r.canonical_contribution_target as any)?.expected_pr_base_repo === 'webaz-protocol/webaz')
    ok('1 list_open carries value_boundary=uncommitted', (r.value_boundary as any)?.value_state === 'uncommitted')
    ok('1 list_open next-action breadcrumb (→ detail → claim)', /action=detail/.test(r._next as string || '') && /action=claim/.test(r._next as string || ''))
    ok('1 list_open has no economic/score field', noEcon(r), collectKeys(r).filter(k => FORBIDDEN.test(k)).join(',')) }

  // ── 2) list_open filters pass through (and still never leak restricted)
  { const lo = await call({ action: 'list_open', risk_level: 'low' })
    ok('2 risk_level=low → bt_claimable present', (lo.tasks as any[]).some(t => t.task_id === 'bt_claimable'))
    const hi = await call({ action: 'list_open', risk_level: 'high' })
    ok('2 risk_level=high → empty (the only high task is restricted, never public)', (hi.tasks as any[]).length === 0, JSON.stringify((hi.tasks as any[]).map(t => t.task_id)))
    const noAuto = await call({ action: 'list_open', auto_claimable: false })
    const naIds = (noAuto.tasks as any[]).map(t => t.task_id)
    ok('2 auto_claimable=false → bt_no_auto present, bt_claimable absent', naIds.includes('bt_no_auto') && !naIds.includes('bt_claimable'), naIds.join(','))
    // PR9G: required_capabilities + max_duration_minutes forwarded through list_open
    const cap = await call({ action: 'list_open', required_capabilities: 'edit JSON' })
    const capIds = (cap.tasks as any[]).map(t => t.task_id)
    ok('2 required_capabilities forwarded → bt_cap in, bt_claimable out', capIds.includes('bt_cap') && !capIds.includes('bt_claimable'), capIds.join(','))
    const dur = await call({ action: 'list_open', max_duration_minutes: 15 })
    const durIds = (dur.tasks as any[]).map(t => t.task_id)
    ok('2 max_duration_minutes forwarded → short task in, long bt_cap out', durIds.includes('bt_claimable') && !durIds.includes('bt_cap'), durIds.join(','))
    const capLeak = await call({ action: 'list_open', required_capabilities: 'edit markdown' })
    const clIds = (capLeak.tasks as any[]).map(t => t.task_id)
    ok('2 cap filter still hides restricted/internal (no leak)', !clIds.includes('bt_restricted') && !clIds.includes('bt_internal'), clIds.join(','))
    const badDur = await call({ action: 'list_open', max_duration_minutes: -5 })
    ok('2 invalid filter forwarded → typed INVALID_FILTER_MAX_DURATION', badDur.error_code === 'INVALID_FILTER_MAX_DURATION', JSON.stringify(badDur))
    // PR9H: estimated_context_size + estimated_agent_budget forwarded through list_open
    const ctx = await call({ action: 'list_open', estimated_context_size: 'large' })
    const ctxIds = (ctx.tasks as any[]).map(t => t.task_id)
    ok('2 estimated_context_size forwarded → bt_cap in, bt_claimable out', ctxIds.includes('bt_cap') && !ctxIds.includes('bt_claimable'), ctxIds.join(','))
    const bud = await call({ action: 'list_open', estimated_agent_budget: 'minimal' })
    const budIds = (bud.tasks as any[]).map(t => t.task_id)
    ok('2 estimated_agent_budget forwarded → bt_claimable in, bt_cap out', budIds.includes('bt_claimable') && !budIds.includes('bt_cap'), budIds.join(','))
    const badCtx = await call({ action: 'list_open', estimated_context_size: 'huge' })
    ok('2 invalid context_size forwarded → typed INVALID_FILTER_CONTEXT_SIZE', badCtx.error_code === 'INVALID_FILTER_CONTEXT_SIZE', JSON.stringify(badCtx))
    // Codex P3: agent_capabilities (SUBSET) forwarded — agent with a superset of bt_cap's reqs gets it (no false-negative)
    const agc = await call({ action: 'list_open', agent_capabilities: 'edit JSON,read OpenAPI 3,python' })
    const agcIds = (agc.tasks as any[]).map(t => t.task_id)
    ok('2 agent_capabilities forwarded → bt_cap in (subset match), bt_claimable out', agcIds.includes('bt_cap') && !agcIds.includes('bt_claimable'), agcIds.join(','))
    const agcLeak = await call({ action: 'list_open', agent_capabilities: 'edit markdown' })
    const aglIds = (agcLeak.tasks as any[]).map(t => t.task_id)
    ok('2 agent_capabilities subset still hides restricted/internal', !aglIds.includes('bt_restricted') && !aglIds.includes('bt_internal'), aglIds.join(','))
    const badAgc = await call({ action: 'list_open', agent_capabilities: '' })
    ok('2 empty agent_capabilities → forwarded → typed INVALID_FILTER_AGENT_CAPABILITIES (fail-closed)', badAgc.error_code === 'INVALID_FILTER_AGENT_CAPABILITIES', JSON.stringify(badAgc)) }

  // ── 3) detail is KEYLESS, returns the full execution boundary + canonical target + a copy-ready handoff
  { const r = await call({ action: 'detail', task_id: 'bt_claimable' })
    const m = (r.task as any)?.agent_metadata || {}
    ok('3 detail works with NO api_key', !r.error && !!r.task, r.error as string)
    ok('3 detail has the execution boundary', Array.isArray(m.allowed_paths) && Array.isArray(m.forbidden_paths) && Array.isArray(m.prohibited_actions))
    ok('3 detail has acceptance + verification', Array.isArray(m.acceptance_criteria) && Array.isArray(m.verification_commands))
    ok('3 detail carries canonical target + value_boundary', (r.canonical_contribution_target as any)?.expected_pr_base_repo === 'webaz-protocol/webaz' && (r.value_boundary as any)?.value_state === 'uncommitted')
    const h = r.agent_handoff as any
    ok('3 detail attaches an agent_handoff', !!h)
    ok('3 handoff canonical_repo is SOURCED FROM the response (not hardcoded)', h?.canonical_repo === (r.canonical_contribution_target as any)?.expected_pr_base_repo)
    ok('3 handoff names the canonical-repo PR rule', /BASE repo is/.test(h?.submit_pr || '') && /non-canonical/.test(h?.submit_pr || ''))
    ok('3 handoff: sandbox/local draft is NOT participation', /sandbox.*NOT participation|NOT participation/i.test(h?.not_participation || ''))
    ok('3 handoff: DCO + human accountable', /git commit -s/.test(h?.pr_flow || '') && /accountable/.test(h?.human_note || ''))
    ok('3 handoff submit instruction includes verification_summary (matches the hardened guard)', /verification_summary=/.test(h?.then || '') && /pr_ref=/.test(h?.then || ''))
    ok('3 detail has no economic/score field', noEcon(r), collectKeys(r).filter(k => FORBIDDEN.test(k)).join(',')) }

  // ── 4) detail on restricted / missing → error, no existence leak
  { const r = await call({ action: 'detail', task_id: 'bt_restricted' })
    ok('4 detail restricted → error (404), no leak', !!r.error && r.http_status === 404 && !/audience|risk_level/i.test(JSON.stringify(r)))
    const miss = await call({ action: 'detail' })
    ok('4 detail without task_id → typed local error', /task_id required/.test(miss.error as string || '')) }

  // ── 5) suggest is KEYLESS → proposal id + "suggestion ≠ contribution/reward" note
  { const r = await call({ action: 'suggest', title: 'Improve the search docs', summary: 'the search docs are unclear for new agents' })
    ok('5 suggest works with NO api_key → proposal id', !r.error && !!(r.proposal as any)?.id, r.error as string)
    ok('5 suggest note: a suggestion, NOT a contribution/reward/participation (route proposal_notice)', /SUGGESTION/.test(r.proposal_notice as string || '') && /never appears on the public task board/i.test(r.proposal_notice as string || ''))
    ok('5 suggest does NOT duplicate the note (no MCP _note)', r._note === undefined)
    ok('5 suggest has no economic/score field', noEcon(r))
    // title too short → local typed refusal (no network write)
    const short = await call({ action: 'suggest', title: 'x', summary: 'reason here' })
    ok('5 suggest title<3 → typed local error', /title required/.test(short.error as string || '')) }

  // ── 6) suggest surfaces typed DUPLICATE_PROPOSAL and RATE_LIMITED
  { const dup = await call({ action: 'suggest', title: 'Improve the search docs', summary: 'the search docs are unclear for new agents' })
    ok('6 identical suggest → DUPLICATE_PROPOSAL', dup.error_code === 'DUPLICATE_PROPOSAL', JSON.stringify(dup))
    RATE_OK = false
    const rl = await call({ action: 'suggest', title: 'A totally different idea', summary: 'something else entirely' })
    ok('6 over the rate limit → RATE_LIMITED', rl.error_code === 'RATE_LIMITED', JSON.stringify(rl))
    RATE_OK = true }

  // ── 7) participation REQUIRES an api_key — typed API_KEY_REQUIRED without one
  for (const action of ['claim', 'submit', 'status', 'profile']) {
    const r = await call({ action, task_id: 'bt_claimable' })
    ok(`7 ${action} without api_key → API_KEY_REQUIRED`, r.error_code === 'API_KEY_REQUIRED', JSON.stringify(r))
  }

  // ── 8) claim WITH a key → claimed + handoff sourced from the response canonical target
  { const r = await call({ action: 'claim', task_id: 'bt_claimable', api_key: 'ka', provenance: 'human' })
    ok('8 keyed claim → claimed', r.status === 'claimed', JSON.stringify(r))
    ok('8 claim handoff canonical_repo from response', (r.handoff as any)?.canonical_repo === (r.canonical_contribution_target as any)?.expected_pr_base_repo)
    ok('8 claim handoff submit instruction includes verification_summary', /verification_summary=/.test((r.handoff as any)?.then || ''))
    ok('8 claim has no economic/score field', noEcon(r))
    const na = await call({ action: 'claim', task_id: 'bt_no_auto', api_key: 'ka' })
    ok('8 claim auto_claimable=false → NOT_AUTO_CLAIMABLE', na.error_code === 'NOT_AUTO_CLAIMABLE', JSON.stringify(na))
    const rs = await call({ action: 'claim', task_id: 'bt_restricted', api_key: 'ka' })
    ok('8 claim restricted → 404, no leak', rs.http_status === 404 && !/audience|risk_level/i.test(JSON.stringify(rs))) }

  // ── 9) submit WITH a key: needs pr_ref→canonical AND a verification_summary (design contract); status returns mine
  { const VS = 'ran npm run build + the task verification_commands; all green'
    const claim = await call({ action: 'claim', task_id: 'bt_submit', api_key: 'kb', provenance: 'ai_assisted' })
    ok('9 setup: kb claims bt_submit', claim.status === 'claimed')
    // bare pr_ref (no verification_summary) → refused before any network write (MCP-local typed guard)
    const bare = await call({ action: 'submit', task_id: 'bt_submit', api_key: 'kb', pr_ref: '#42' })
    ok('9 bare submit (no verification_summary) → VERIFICATION_SUMMARY_REQUIRED', bare.error_code === 'VERIFICATION_SUMMARY_REQUIRED', JSON.stringify(bare))
    const bad = await call({ action: 'submit', task_id: 'bt_submit', api_key: 'kb', pr_ref: 'https://evilgithub.com/webaz-protocol/webaz/pull/1', verification_summary: VS })
    ok('9 submit lookalike host → WRONG_PR_BASE_REPO (rejected)', bad.error_code === 'WRONG_PR_BASE_REPO', JSON.stringify(bad))
    const good = await call({ action: 'submit', task_id: 'bt_submit', api_key: 'kb', pr_ref: '#42', verification_summary: VS })
    ok('9 submit canonical #N + verification_summary → in_review', good.status === 'in_review', JSON.stringify(good))
    ok('9 submit success: next-action breadcrumb (human review, done≠merge)', /human maintainer/i.test(good._next as string || '') && /done ≠ merge/i.test(good._next as string || ''))
    const st = await call({ action: 'status', api_key: 'kb' })
    ok('9 status (keyed) returns the holder’s tasks', Array.isArray(st.tasks) && (st.tasks as any[]).some(t => t.id === 'bt_submit' || t.task_id === 'bt_submit')) }

  // ── 10) sandbox mode → contribution has nothing to coordinate with (typed CONTRIBUTE_NEEDS_NETWORK)
  //   (network_readonly is active here, so we assert the inverse: discovery is NOT mode-blocked.)
  { const r = await call({ action: 'list_open' })
    ok('10 network_readonly: discovery is not mode-blocked', !r.error_code || r.error_code !== 'CONTRIBUTE_NEEDS_NETWORK') }

  server.close()
  if (fail === 0) {
    console.log(`\n✅ MCP webaz_contribute wiring (PR9D): keyless discovery (list_open/detail) over the public surface + canonical target + value_boundary, restricted/internal/old hidden · detail handoff sourced from the response (canonical-repo PR rule, sandbox≠participation, DCO) · keyless suggest → proposal id + note + typed DUPLICATE/RATE_LIMITED · participation needs api_key (typed) · claim handoff canonical · submit canonical-only · no economic field\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
    process.exit(0)
  } else {
    console.error(`\n❌ MCP webaz_contribute wiring FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
