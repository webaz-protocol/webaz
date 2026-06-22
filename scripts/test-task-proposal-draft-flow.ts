#!/usr/bin/env tsx
/**
 * Task Proposal → Formal Task Draft → Publish (human-gated). 用法:npm run test:task-proposal-draft-flow
 *
 * Proves the human-gated flow + boundaries:
 *  - authorized admin converts a proposal → UNPUBLISHED internal draft (reuses build_tasks, no parallel system)
 *  - draft preserves source proposal linkage (converted_ref) + proposer context
 *  - draft is NOT discoverable on the member task board and NOT claimable before publish
 *  - publish VALIDATES agent-handoff completeness (incomplete → DRAFT_INCOMPLETE, never publishes)
 *  - publish is explicit + records the human actor; published task becomes a normal board task: discoverable +
 *    claimable via the EXISTING read/participation flow; canonical PR target enforced by the existing path
 *  - unauthorized users cannot create/publish
 *  - AI-assist is assistant-only: storing a suggestion never publishes/rejects/creates a task/changes proposal
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { initBuildTasksSchema } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildTaskAgentMetadataSchema } from '../src/layer2-business/L2-9-contribution/build-task-agent-metadata-store.js'
import { initTaskProposalSchema, insertTaskProposal, reviewTaskProposal } from '../src/layer2-business/L2-9-contribution/task-proposal-store.js'
import { initTaskProposalAiSchema } from '../src/layer2-business/L2-9-contribution/task-proposal-ai-store.js'
import { createDraftFromProposal, publishDraftBuildTask, listDraftBuildTasks, discardDraft, withdrawPublishedTask, initTaskProposalDraftLinkSchema } from '../src/layer2-business/L2-9-contribution/task-proposal-draft.js'
import { listBuildTasksWithAgentMetadata, validateTaskFilters } from '../src/layer2-business/L2-9-contribution/build-task-read.js'
import { guardParticipation, validatePrRefAgainstCanonical } from '../src/layer2-business/L2-9-contribution/build-task-participation.js'
import { registerTaskProposalsRoutes } from '../src/pwa/routes/task-proposals.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
initBuildTasksSchema(db); initBuildTaskAgentMetadataSchema(db); initTaskProposalSchema(db); initTaskProposalAiSchema(db); initTaskProposalDraftLinkSchema(db)

const filters = (() => { const v = validateTaskFilters({}); if (!v.ok) throw new Error('filters'); return v.filters })()
const boardHas = (id: string): boolean => listBuildTasksWithAgentMetadata(db, filters, 'member').some((t: any) => t.id === id)
const fullHandoff = {
  title: 'Add EN locale for checkout page', area: 'i18n', description: 'Checkout page has no EN strings; add them.',
  sourceRef: 'src/pwa/public/i18n.js', acceptanceCriteria: ['every checkout string has an _EN entry'],
  verificationCommands: ['npm run test:i18n-parity'], deliverables: ['i18n.js EN entries'],
  allowedPaths: ['src/pwa/public/i18n.js'], forbiddenPaths: ['src/layer*/**'], forbiddenActions: ['do not touch funds/orders'],
  requiredCapabilities: ['i18n'], definitionOfDone: 'zh/en parity test green', expectedResults: 'EN strings render on checkout',
}

// ── module-level: create / linkage / discoverability / claimability / validation ──
function moduleTests(): void {
  const p1 = insertTaskProposal(db, { title: 'EN locale for checkout', summary: 'no EN strings on checkout, please add', suggested_area: 'i18n' } as any, 'usr_proposer') as any
  ok('proposal inserted', !!p1.id, JSON.stringify(p1))

  // authorized create draft (full handoff)
  const d = createDraftFromProposal(db, { proposalId: p1.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('admin creates draft', !!d.draft_task_id, JSON.stringify(d))
  const taskId = d.draft_task_id

  // draft creation is NOT acceptance: proposal stays NON-terminal (status unchanged, no converted_ref);
  // the source proposal ↔ draft link is held separately + proposer context preserved.
  const prop = db.prepare('SELECT status, converted_ref, reviewer_id, proposer_account_id FROM task_proposals WHERE id = ?').get(p1.id) as any
  ok('draft create does NOT mark proposal converted (stays non-terminal, no converted_ref)', prop.status === 'new' && !prop.converted_ref && prop.proposer_account_id === 'usr_proposer', JSON.stringify(prop))

  // before publish: internal draft is NOT on the member board, NOT claimable, but IS in the admin draft list
  ok('draft NOT on member board pre-publish', !boardHas(taskId))
  ok('draft NOT claimable pre-publish (404 no-leak)', guardParticipation(db, taskId, 'claim').status === 404)
  ok('draft IS in admin draft list (linked to source proposal)', listDraftBuildTasks(db).some((x: any) => x.id === taskId && x.source_proposal_id === p1.id))

  // a second draft from the same proposal is refused WITHOUT relying on a terminal proposal status
  const dup = createDraftFromProposal(db, { proposalId: p1.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('one draft per proposal (PROPOSAL_HAS_DRAFT, not terminal)', dup.error_code === 'PROPOSAL_HAS_DRAFT', JSON.stringify(dup))

  // publish (complete) → discoverable + claimable via existing flow + acceptance recorded HERE
  const pub = publishDraftBuildTask(db, taskId, 'usr_admin2') as any
  ok('publish complete draft ok', pub.ok === true && pub.task_id === taskId, JSON.stringify(pub))
  ok('published task ON member board', boardHas(taskId))
  const g = guardParticipation(db, taskId, 'claim')
  ok('published task claimable via existing guard', g.ok === true, JSON.stringify(g))
  ok('canonical PR target enforced by existing submit path', validatePrRefAgainstCanonical('#123').ok === true && (validatePrRefAgainstCanonical('https://evilgithub.com/x/y#1') as any).ok === false)
  // acceptance happens at PUBLISH: only now is the proposal converted + linked + reviewer recorded
  const propPub = db.prepare('SELECT status, converted_ref, reviewer_id FROM task_proposals WHERE id = ?').get(p1.id) as any
  ok('publish marks proposal converted + converted_ref + reviewer (acceptance at publish)', propPub.status === 'converted' && propPub.converted_ref === taskId && propPub.reviewer_id === 'usr_admin2', JSON.stringify(propPub))
  ok('no longer in draft list after publish', !listDraftBuildTasks(db).some((x: any) => x.id === taskId))

  // incomplete handoff → create refuses up front (never creates an incomplete/orphan task)
  const tasksBeforeIncomplete = (db.prepare('SELECT COUNT(*) c FROM build_tasks').get() as any).c
  const p2 = insertTaskProposal(db, { title: 'vague idea', summary: 'do the thing somehow', suggested_area: 'code' } as any, 'usr_proposer') as any
  const d2 = createDraftFromProposal(db, { proposalId: p2.id, adminId: 'usr_admin', title: 'Do the thing', description: 'do it' }) as any
  ok('incomplete create refused with missing list', d2.error_code === 'DRAFT_INCOMPLETE' && Array.isArray(d2.missing) && d2.missing.includes('allowed_paths (execution boundary)') && d2.missing.includes('acceptance_criteria') && d2.missing.includes('deliverables') && d2.missing.includes('forbidden_actions'), JSON.stringify(d2))
  ok('incomplete create produced NO build_task (no orphan)', (db.prepare('SELECT COUNT(*) c FROM build_tasks').get() as any).c === tasksBeforeIncomplete)
  ok('incomplete create did NOT convert the proposal', (db.prepare('SELECT status FROM task_proposals WHERE id = ?').get(p2.id) as any).status === 'new')

  // terminal proposal cannot be re-converted
  const again = createDraftFromProposal(db, { proposalId: p1.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('already-converted proposal cannot create another draft', again.error_code === 'PROPOSAL_TERMINAL', JSON.stringify(again))

  // EVIDENCE-CHAIN GUARD: draft → reject the source proposal → publish MUST fail + task MUST stay internal
  const p4 = insertTaskProposal(db, { title: 'reject then publish', summary: 'add a settings toggle to the profile page', suggested_area: 'ui' } as any, 'usr_proposer') as any
  const d4 = createDraftFromProposal(db, { proposalId: p4.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('draft created for reject-test', !!d4.draft_task_id, JSON.stringify(d4))
  reviewTaskProposal(db, p4.id, 'usr_admin', 'rejected', 'not wanted')
  const pubRej = publishDraftBuildTask(db, d4.draft_task_id, 'usr_admin') as any
  ok('publish refused when source proposal rejected', pubRej.error_code === 'PROPOSAL_REJECTED', JSON.stringify(pubRej))
  ok('rejected-source draft did NOT reach the board', !boardHas(d4.draft_task_id))
  ok('rejected-source draft stays internal/unclaimable', guardParticipation(db, d4.draft_task_id, 'claim').status === 404)
  ok('source proposal stays rejected (not flipped to converted)', (db.prepare('SELECT status FROM task_proposals WHERE id = ?').get(p4.id) as any).status === 'rejected')
}

// ── route-level: permission boundaries + AI-assist no side effects ──
let server: Server, port = 0
let authUser: any = null
const post = (path: string, body?: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = body ? JSON.stringify(body) : ''
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); if (p) r.write(p); r.end()
})
const get = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const r = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.end()
})

async function routeTests(): Promise<void> {
  const app = express(); app.use(express.json())
  const errorRes = (res: any, status: number, code: string, message: string, extra?: any) => res.status(status).json({ error: code, message, ...(extra ?? {}) })
  registerTaskProposalsRoutes(app, {
    db,
    errorRes: errorRes as any,
    // mirror requireSupportAdmin: returns the admin or writes 403 + returns null
    requireSupportAdmin: ((_req: any, res: any) => { if (authUser) return authUser; errorRes(res, 403, 'FORBIDDEN', 'admin only'); return null }) as any,
    rateLimitOk: (() => true) as any,
    auth: ((_req: any, res: any) => { res.status(401).json({ error: 'login required' }); return null }) as any,
    resolveUser: (() => null) as any,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  const p = insertTaskProposal(db, { title: 'route test proposal', summary: 'add a docs page for onboarding', suggested_area: 'docs' } as any, 'usr_proposer') as any

  // unauthorized cannot create or publish
  authUser = null
  ok('unauthorized create-task-draft → 403', (await post(`/api/admin/task-proposals/${p.id}/create-task-draft`, { title: 'x docs' })).status === 403)
  ok('unauthorized publish → 403', (await post(`/api/admin/build-task-drafts/anytask/publish`)).status === 403)
  ok('unauthorized discard → 403', (await post(`/api/admin/build-task-drafts/anytask/discard`)).status === 403)
  ok('unauthorized withdraw → 403', (await post(`/api/admin/build-tasks/anytask/withdraw`)).status === 403)
  ok('unauthorized ai-assist → 403', (await post(`/api/admin/task-proposals/${p.id}/ai-assist`)).status === 403)

  // AI-assist (authorized): stores a suggestion, NO publish/reject/create-task/proposal-change side effect
  authUser = { id: 'usr_admin', role: 'admin' }
  const tasksBefore = (db.prepare('SELECT COUNT(*) c FROM build_tasks').get() as any).c
  const ai = await post(`/api/admin/task-proposals/${p.id}/ai-assist`)
  ok('ai-assist returns suggestion + notice', ai.status === 200 && !!ai.json?.ai_suggestion && typeof ai.json?.ai_notice === 'string' && !!ai.json?.suggestion_id, JSON.stringify(ai.json))
  ok('ai-assist stores model/provider (model-ready stub)', ai.json?.model === 'heuristic-v1' && ai.json?.provider === 'local')
  const tasksAfter = (db.prepare('SELECT COUNT(*) c FROM build_tasks').get() as any).c
  ok('ai-assist creates NO build_task', tasksBefore === tasksAfter, `${tasksBefore} → ${tasksAfter}`)
  ok('ai-assist does NOT change proposal status', (db.prepare('SELECT status FROM task_proposals WHERE id = ?').get(p.id) as any).status === 'new')
  ok('ai-assist suggestion persisted as evidence', (db.prepare('SELECT COUNT(*) c FROM task_proposal_ai_suggestions WHERE proposal_id = ?').get(p.id) as any).c === 1)

  // authorized create-task-draft via route records actor; create→publish round-trip through routes
  const cr = await post(`/api/admin/task-proposals/${p.id}/create-task-draft`, { title: 'Onboarding docs page', description: 'add an onboarding docs page', source_ref: 'docs/ONBOARDING.md', acceptance_criteria: ['onboarding page documents passkey + first task'], verification_commands: ['test -f docs/ONBOARDING.md'], deliverables: ['docs/ONBOARDING.md'], allowed_paths: ['docs/ONBOARDING.md'], forbidden_paths: ['src/**'], forbidden_actions: ['do not modify code'], required_capabilities: ['docs'], definition_of_done: 'docs page exists', expected_results: 'onboarding page renders' })
  ok('authorized create-task-draft → 200 + actor recorded', cr.status === 200 && !!cr.json?.draft?.draft_task_id && cr.json?.created_by === 'usr_admin', JSON.stringify(cr.json))
  const tId = cr.json.draft.draft_task_id
  ok('route-created draft not on board pre-publish', !boardHas(tId))

  // pre-publish PREVIEW: the full stored body is fetchable + admin-gated; publish acts on this visible content
  authUser = null
  ok('preview: unauthorized draft detail → 403', (await get(`/api/admin/build-task-drafts/${tId}`)).status === 403)
  authUser = { id: 'usr_admin', role: 'admin' }
  const detail = await get(`/api/admin/build-task-drafts/${tId}`)
  ok('preview: authorized draft detail → 200 with full body', detail.status === 200
    && detail.json?.draft?.agent_metadata?.acceptance_criteria?.length > 0
    && Array.isArray(detail.json?.draft?.agent_metadata?.verification_commands)
    && Array.isArray(detail.json?.draft?.agent_metadata?.allowed_paths)
    && typeof detail.json?.draft?.description === 'string', JSON.stringify(detail.json?.draft && Object.keys(detail.json.draft)))
  ok('preview: unknown draft → 404', (await get(`/api/admin/build-task-drafts/bt_nope`)).status === 404)

  const pubR = await post(`/api/admin/build-task-drafts/${tId}/publish`)
  ok('authorized publish → 200 + published_by recorded', pubR.status === 200 && pubR.json?.published?.published === true && pubR.json?.published_by === 'usr_admin', JSON.stringify(pubR.json))
  ok('route-published draft now on board', boardHas(tId))
  ok('preview: published task no longer previewable as a draft → 404', (await get(`/api/admin/build-task-drafts/${tId}`)).status === 404)

  server.close()
}

// ── discard draft: soft-delete frees the slot (provenance retained); fail-closed on published/claimed/converted ──
function discardTests(): void {
  // unlock chain: create → discard (soft) → slot freed → recreate succeeds (v2)
  const p = insertTaskProposal(db, { title: 'discard unlock chain', summary: 'create, discard, recreate' } as any, 'usr_proposer') as any
  const d1 = createDraftFromProposal(db, { proposalId: p.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('discard: first draft created', !!d1.draft_task_id, JSON.stringify(d1))
  ok('discard: 2nd create blocked while active (PROPOSAL_HAS_DRAFT)', (createDraftFromProposal(db, { proposalId: p.id, adminId: 'usr_admin', ...fullHandoff }) as any).error_code === 'PROPOSAL_HAS_DRAFT')
  const disc = discardDraft(db, d1.draft_task_id, 'usr_admin') as any
  ok('discard: internal draft discarded ok', disc.ok === true && !disc.already_discarded, JSON.stringify(disc))
  const linkRow = db.prepare('SELECT status, discarded_by FROM task_proposal_draft_links WHERE task_id = ?').get(d1.draft_task_id) as any
  ok('discard: link row RETAINED + status=discarded + discarded_by recorded (provenance)', !!linkRow && linkRow.status === 'discarded' && linkRow.discarded_by === 'usr_admin', JSON.stringify(linkRow))
  ok('discard: discarded draft NOT in admin draft list', !listDraftBuildTasks(db).some((x: any) => x.id === d1.draft_task_id))
  const d2 = createDraftFromProposal(db, { proposalId: p.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('discard: slot freed → recreate succeeds (v2), distinct task id', !!d2.draft_task_id && d2.draft_task_id !== d1.draft_task_id, JSON.stringify(d2))
  ok('discard: v2 draft IS in the admin draft list', listDraftBuildTasks(db).some((x: any) => x.id === d2.draft_task_id))
  ok('discard: re-discard is idempotent (already_discarded)', (discardDraft(db, d1.draft_task_id, 'usr_admin') as any).already_discarded === true)
  ok('discard: publishing a discarded draft → DRAFT_DISCARDED', (publishDraftBuildTask(db, d1.draft_task_id, 'usr_admin') as any).error_code === 'DRAFT_DISCARDED')

  // fail-closed: a PUBLISHED draft cannot be discarded
  const p2 = insertTaskProposal(db, { title: 'discard published guard', summary: 'x' } as any, 'usr_proposer') as any
  const d3 = createDraftFromProposal(db, { proposalId: p2.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('discard: (setup) publish ok', (publishDraftBuildTask(db, d3.draft_task_id, 'usr_admin2') as any).ok === true)
  ok('discard: published draft refused (ALREADY_PUBLISHED)', (discardDraft(db, d3.draft_task_id, 'usr_admin') as any).error_code === 'ALREADY_PUBLISHED')

  ok('discard: unknown task → NOT_FOUND', (discardDraft(db, 'bt_nope', 'usr_admin') as any).error_code === 'NOT_FOUND')
}

// ── withdraw recovery: pull an UNCLAIMED published task off the board + reopen its proposal (fail-closed) ──
function withdrawTests(): void {
  const p = insertTaskProposal(db, { title: 'withdraw recovery flow', summary: 'publish then withdraw then recreate' } as any, 'usr_proposer') as any
  const d = createDraftFromProposal(db, { proposalId: p.id, adminId: 'usr_admin', ...fullHandoff }) as any
  const tId = d.draft_task_id
  ok('withdraw: (setup) publish ok', (publishDraftBuildTask(db, tId, 'usr_admin2') as any).ok === true)
  const w = withdrawPublishedTask(db, tId, 'usr_admin') as any
  ok('withdraw: unclaimed published task withdrawn + proposal reopened', w.ok === true && w.reopened_proposal_id === p.id, JSON.stringify(w))
  ok('withdraw: task set abandoned (off the board)', (db.prepare('SELECT status FROM build_tasks WHERE id = ?').get(tId) as any).status === 'abandoned')
  ok('withdraw: draft link discarded (provenance kept)', (db.prepare('SELECT status FROM task_proposal_draft_links WHERE task_id = ?').get(tId) as any).status === 'discarded')
  const prop = db.prepare('SELECT status, converted_ref FROM task_proposals WHERE id = ?').get(p.id) as any
  ok('withdraw: source proposal reopened (status=new, converted_ref cleared)', prop.status === 'new' && !prop.converted_ref, JSON.stringify(prop))
  const re = createDraftFromProposal(db, { proposalId: p.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('withdraw: slot freed + proposal non-terminal → recreate succeeds (distinct id)', !!re.draft_task_id && re.draft_task_id !== tId, JSON.stringify(re))

  // fail-closed: a CLAIMED published task cannot be withdrawn
  const p2 = insertTaskProposal(db, { title: 'withdraw claimed guard', summary: 'x' } as any, 'usr_proposer') as any
  const d2 = createDraftFromProposal(db, { proposalId: p2.id, adminId: 'usr_admin', ...fullHandoff }) as any
  publishDraftBuildTask(db, d2.draft_task_id, 'usr_admin2')
  db.prepare("UPDATE build_tasks SET status='claimed', claimer_id='usr_claimer' WHERE id = ?").run(d2.draft_task_id)
  ok('withdraw: claimed task refused (TASK_CLAIMED)', (withdrawPublishedTask(db, d2.draft_task_id, 'usr_admin') as any).error_code === 'TASK_CLAIMED')

  // fail-closed: a non-published internal draft → NOT_PUBLISHED (use discard for those)
  const p3 = insertTaskProposal(db, { title: 'withdraw notpub guard', summary: 'x' } as any, 'usr_proposer') as any
  const d3 = createDraftFromProposal(db, { proposalId: p3.id, adminId: 'usr_admin', ...fullHandoff }) as any
  ok('withdraw: internal (unpublished) draft refused (NOT_PUBLISHED)', (withdrawPublishedTask(db, d3.draft_task_id, 'usr_admin') as any).error_code === 'NOT_PUBLISHED')

  ok('withdraw: unknown task → NOT_FOUND', (withdrawPublishedTask(db, 'bt_nope', 'usr_admin') as any).error_code === 'NOT_FOUND')
}

async function main(): Promise<void> {
  moduleTests()
  discardTests()
  withdrawTests()
  await routeTests()
  if (fail === 0) {
    console.log(`\n✅ task-proposal draft flow: proposal→AI-assist(evidence only)→internal draft→explicit human publish→normal claimable board task;权限边界 + AI 不做决策 + 发布前校验 handoff 字段\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ task-proposal draft flow FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
