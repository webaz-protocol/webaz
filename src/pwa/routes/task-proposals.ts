/**
 * Task Proposal Inbox v1 — routes. A suggestion enters the inbox; a maintainer reviews it; it NEVER
 * auto-becomes a build_task or appears on the public task board (#329/#330 unchanged).
 *
 *   POST /api/public/task-proposals            submit a suggestion (anonymous OK; validated; typed errors)
 *   GET  /api/admin/task-proposals             list (admin/maintainer only)
 *   POST /api/admin/task-proposals/:id/review  set needs_info | rejected | converted (admin only)
 *
 * Every response carries the uncommitted value_boundary + the trusted canonical_contribution_target + a
 * notice clarifying this is NOT a contribution fact / reward / participation. No external input overrides
 * the canonical target; `source_ref` is a reference only. No reward / payout / amount / score field.
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { validateProposalInput, insertTaskProposal, listTaskProposals, listMyProposals, reviewTaskProposal } from '../../layer2-business/L2-9-contribution/task-proposal-store.js'
import { withUncommittedValueBoundary } from '../../layer2-business/L2-9-contribution/contribution-display-envelope.js'
import { getCanonicalContributionTarget } from '../../layer2-business/L2-9-contribution/canonical-contribution-target.js'
import { createDraftFromProposal, listDraftBuildTasks, getDraftBuildTaskDetail, publishDraftBuildTask, discardDraft, withdrawPublishedTask } from '../../layer2-business/L2-9-contribution/task-proposal-draft.js'
import { recommendForProposal, insertAiSuggestion, listAiSuggestions, getProposalLite } from '../../layer2-business/L2-9-contribution/task-proposal-ai-store.js'

const AI_NOTICE = 'AI suggestion — assistant only, NOT a decision. A human maintainer must explicitly create / publish / reject the formal task. AI never auto-publishes, auto-rejects, hides proposals, or assigns reward / credit.'

const PROPOSAL_NOTICE = 'A task proposal is a SUGGESTION in the maintainer review inbox. It is NOT a contribution fact, formal participation, or any reward / payout / score, and it never appears on the public task board until a maintainer reviews and (manually) converts it. source_ref is a reference only; the canonical contribution target is fixed by trusted config.'

function withProposalEnvelope<T extends object>(payload: T): T & Record<string, unknown> {
  return withUncommittedValueBoundary({ ...payload, proposal_notice: PROPOSAL_NOTICE, canonical_contribution_target: getCanonicalContributionTarget() }) as any
}

export interface TaskProposalsDeps {
  db: Database.Database
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
  requireSupportAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  // anti-flood for the anonymous public endpoint: true while under the per-key limit (key = proposal:<ip>).
  rateLimitOk: (key: string) => boolean
  // required auth (sends 401) — for the proposer-facing "my proposals" read.
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  // optional resolver (no 401) — links a submission to the logged-in submitter without breaking anonymous submit.
  resolveUser: (req: Request) => Record<string, unknown> | null
}

// Agent-readable next-step hint per status (the channel is agent-native both ways).
function nextActionFor(status: string): string {
  switch (status) {
    case 'new': return 'Awaiting maintainer review — no action needed.'
    case 'needs_info': return 'Maintainer needs more detail. Submit an updated proposal (webaz_feedback type=proposal) referencing this id; see public_reply for what is missing.'
    case 'rejected': return 'Not converted to a task. See public_reply for the reason; you may submit a revised proposal.'
    case 'converted': return 'Converted to a task. See converted_ref for the linked task / PR / decision.'
    default: return 'No action.'
  }
}

export function registerTaskProposalsRoutes(app: Application, deps: TaskProposalsDeps): void {
  const { db, errorRes, requireSupportAdmin, rateLimitOk, auth, resolveUser } = deps

  // public submit — anonymous; proposer_account_id is never taken from the body (anti-spoof).
  app.post('/api/public/task-proposals', (req: Request, res: Response) => {
    // anti-flood: per-IP rate limit (counts every attempt, before validation) then a recent-window dedup.
    const ip = (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') || req.ip || 'unknown'
    if (!rateLimitOk(`proposal:${ip}`)) return void errorRes(res, 429, 'RATE_LIMITED', '提交过于频繁,请稍后再试')
    const v = validateProposalInput(req.body)
    if (!v.ok) return void errorRes(res, 400, v.code, v.message)
    // Link to the submitter when authenticated (account id comes from the session, NEVER the body — anti-spoof);
    // anonymous submit still works (account id null) — it just won't show up in "my proposals".
    const submitter = resolveUser(req)
    const accountId = submitter ? String(submitter.id) : null
    const result = insertTaskProposal(db, v.input, accountId)
    if ('duplicate' in result) return void errorRes(res, 409, 'DUPLICATE_PROPOSAL', '相同建议已在收件箱中,请勿重复提交', { existing_id: result.existing_id })
    res.json(withProposalEnvelope({ proposal: { id: result.id, status: result.status }, linked_to_account: !!accountId }))
  })

  // proposer-facing read: the caller's OWN proposals + status + public_reply (agent-readable). No review_note; own rows only.
  app.get('/api/me/task-proposals', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    // case_id threads the whole case (proposal → task → PR). For a proposal it is the proposal's own id.
    const proposals = listMyProposals(db, String(user.id)).map(p => ({ ...p, case_id: p.id, next_action: nextActionFor(String(p.status)) }))
    res.json(withProposalEnvelope({ proposals }))
  })

  // admin list (maintainer only)
  app.get('/api/admin/task-proposals', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    // case_id = the proposal's own id (the case originates at the proposal); shown in the management inbox.
    const proposals = listTaskProposals(db, { status }).map(p => ({ ...p, case_id: p.id }))
    res.json(withProposalEnvelope({ proposals }))
  })

  // admin review (maintainer only): needs_info | rejected | converted — no build_task is created here.
  app.post('/api/admin/task-proposals/:id/review', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const { status, note, converted_ref, public_reply } = req.body ?? {}
    const result = reviewTaskProposal(db, String(req.params.id), admin.id as string, String(status), note, converted_ref, public_reply)
    if ('error' in result) {
      const code = result.code === 'NOT_FOUND' ? 404 : result.code === 'ALREADY_TERMINAL' ? 409 : 400
      return void errorRes(res, code, result.code, result.error)
    }
    res.json(withProposalEnvelope({ proposal: result }))
  })

  // ── AI-assist (ASSISTANT ONLY) ─────────────────────────────────────────────
  // Classify + suggest draft fields; stored as recommendation/evidence with accountability metadata.
  // NEVER a decision: no auto-publish / auto-reject / hide / reward. A human admin must act explicitly.
  app.post('/api/admin/task-proposals/:id/ai-assist', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const p = getProposalLite(db, String(req.params.id))
    if (!p) return void errorRes(res, 404, 'NOT_FOUND', 'proposal not found')
    const { recommendation, model, provider } = recommendForProposal(db, p)
    const stored = insertAiSuggestion(db, { proposalId: p.id, reviewerType: 'ai', model, provider,
      inputSummary: `${p.title}\n${p.summary}`, outputJson: JSON.stringify(recommendation) })
    res.json(withProposalEnvelope({ ai_suggestion: recommendation, model, provider, suggestion_id: stored.id, requested_by: admin.id, ai_notice: AI_NOTICE }))
  })

  // stored AI suggestions (evidence) for a proposal
  app.get('/api/admin/task-proposals/:id/ai-suggestions', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    res.json(withProposalEnvelope({ suggestions: listAiSuggestions(db, String(req.params.id)), ai_notice: AI_NOTICE }))
  })

  // ── create an UNPUBLISHED formal task draft from a proposal — explicit maintainer action ──
  // No auto-publish (draft is internal/unclaimable until an explicit publish); no reward/credit side effect.
  app.post('/api/admin/task-proposals/:id/create-task-draft', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.title || String(b.title).trim().length < 3) return void errorRes(res, 400, 'TITLE_REQUIRED', 'title is required (>=3 chars) — the maintainer must review/confirm the formal title')
    const r = createDraftFromProposal(db, {
      proposalId: String(req.params.id), adminId: admin.id as string,
      title: String(b.title), area: (b.area as string) ?? null, description: (b.description as string) ?? null,
      sourceRef: (b.source_ref as string) ?? null,
      acceptanceCriteria: Array.isArray(b.acceptance_criteria) ? b.acceptance_criteria as string[] : [],
      verificationCommands: Array.isArray(b.verification_commands) ? b.verification_commands as string[] : [],
      deliverables: Array.isArray(b.deliverables) ? b.deliverables as string[] : [],
      allowedPaths: Array.isArray(b.allowed_paths) ? b.allowed_paths as string[] : [],
      forbiddenPaths: Array.isArray(b.forbidden_paths) ? b.forbidden_paths as string[] : [],
      forbiddenActions: Array.isArray(b.forbidden_actions) ? b.forbidden_actions as string[] : [],
      requiredCapabilities: Array.isArray(b.required_capabilities) ? b.required_capabilities as string[] : [],
      definitionOfDone: (b.definition_of_done as string) ?? null,
      expectedResults: (b.expected_results as string) ?? null,
      autoClaimable: b.auto_claimable === false ? false : undefined,
      riskLevel: b.risk_level as string | undefined, taskType: b.task_type as string | undefined, note: (b.note as string) ?? null,
    })
    if ('error' in r) {
      const code = r.error_code === 'PROPOSAL_NOT_FOUND' ? 404 : r.error_code === 'PROPOSAL_TERMINAL' ? 409 : r.error_code === 'RATE_LIMITED' ? 429 : 400
      return void errorRes(res, code, r.error_code, r.error)
    }
    res.json(withProposalEnvelope({ draft: { draft_task_id: r.draft_task_id, status: 'draft', audience: 'internal', published: false }, created_by: admin.id }))
  })

  // admin list of UNPUBLISHED drafts (internal, open) + source proposal id
  app.get('/api/admin/build-task-drafts', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    res.json(withProposalEnvelope({ drafts: listDraftBuildTasks(db) }))
  })

  // full stored body of ONE unpublished internal draft — for PRE-PUBLISH PREVIEW (publish against visible content).
  app.get('/api/admin/build-task-drafts/:id', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const draft = getDraftBuildTaskDetail(db, String(req.params.id))
    if (!draft) return void errorRes(res, 404, 'NOT_FOUND', 'draft not found (or not an unpublished internal draft)')
    res.json(withProposalEnvelope({ draft }))
  })

  // PUBLISH a draft → public open task — explicit human/admin action; records the acting admin
  app.post('/api/admin/build-task-drafts/:id/publish', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const r = publishDraftBuildTask(db, String(req.params.id), admin.id as string)
    if ('error' in r) {
      const code = r.error_code === 'NOT_FOUND' ? 404
        : (r.error_code === 'PROPOSAL_REJECTED' || r.error_code === 'PROPOSAL_CONVERTED_ELSEWHERE') ? 409 : 400
      return void errorRes(res, code, r.error_code, r.error, r.missing ? { missing: r.missing } : undefined)
    }
    res.json(withProposalEnvelope({ published: { task_id: r.task_id, published: true }, published_by: admin.id }))
  })

  // DISCARD an unpublished internal draft (soft-delete → frees the proposal's draft slot; provenance retained).
  // Fail-closed: refuses a published / claimed draft or an already-converted source proposal. Scope = discard only.
  app.post('/api/admin/build-task-drafts/:id/discard', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const r = discardDraft(db, String(req.params.id), admin.id as string)
    if ('error' in r) {
      const code = r.error_code === 'NOT_FOUND' ? 404
        : (r.error_code === 'ALREADY_PUBLISHED' || r.error_code === 'DRAFT_CLAIMED' || r.error_code === 'ALREADY_CONVERTED') ? 409 : 400
      return void errorRes(res, code, r.error_code, r.error)
    }
    res.json(withProposalEnvelope({ discarded: { task_id: r.task_id, status: 'discarded', already_discarded: !!r.already_discarded }, discarded_by: admin.id }))
  })

  // RECOVERY: withdraw an UNCLAIMED published task off the board + reopen its source proposal (so a corrected
  // draft can be built). Fail-closed: refuses a claimed task or a non-published task. Soft-delete (provenance kept).
  app.post('/api/admin/build-tasks/:id/withdraw', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const r = withdrawPublishedTask(db, String(req.params.id), admin.id as string)
    if ('error' in r) {
      const code = r.error_code === 'NOT_FOUND' ? 404
        : (r.error_code === 'TASK_CLAIMED' || r.error_code === 'NOT_PUBLISHED') ? 409 : 400
      return void errorRes(res, code, r.error_code, r.error)
    }
    res.json(withProposalEnvelope({ withdrawn: { task_id: r.task_id, reopened_proposal_id: r.reopened_proposal_id }, withdrawn_by: admin.id }))
  })
}
