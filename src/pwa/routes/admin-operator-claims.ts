/**
 * Admin operator-claim workflow routes (Phase 2). Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md.
 *
 * Links an admin SEAT → a real CONTRIBUTOR account via a claim workflow:
 *   admin proposes → contributor confirms → root approves → revoke/supersede.
 * Thin orchestration over admin-operator-claim-workflow.ts; every mutation also writes admin_audit_log
 * (logAdminAction) in the SAME transaction. This is a claim workflow — it NEVER writes contribution_facts
 * and never calls the ingestion engine.
 *
 * Permissions: propose = the admin for their OWN seat · confirm/reject = the named contributor only ·
 * approve/reject/revoke/list-all = root only · a normal user sees only claims pointing at them.
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { logAdminAction } from '../admin-audit.js'
import {
  proposeClaim, confirmClaim, approveClaim, rejectClaim, revokeApprovedClaim,
  deriveClaimState, listClaimsForSeat, listPendingConfirmationsForContributor, listAllClaims,
  emitClaimNotifications, claimedEventIdOfApproved,
  type ClaimStatus, type ClaimTransition,
} from '../../layer2-business/L2-9-contribution/admin-operator-claim-workflow.js'

interface Deps {
  db: Database.Database
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

function httpFor(code: string): number {
  switch (code) {
    case 'claim_not_found': case 'approved_not_found': return 404
    case 'not_admin': case 'not_root': case 'not_contributor': return 403
    case 'bad_state': case 'not_confirmed': case 'contributor_rejected': return 409
    default: return 400   // invalid_input / contributor_not_found / self_link_* / dishonest_marking
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function shape(v: any): any {
  if (!v) return null
  return {
    claimed_event_id: v.claimed.event_id,
    admin_account_id: v.claimed.admin_account_id,
    contributor_account_id: v.claimed.contributor_account_id,
    status: v.status,
    proposed_at: v.claimed.created_at,
    confirmation: v.confirmation ? { decision: v.confirmation.decision, decided_by: v.confirmation.decided_by, at: v.confirmation.created_at } : null,
    approved: v.approved ? { event_id: v.approved.event_id, at: v.approved.created_at } : null,
  }
}

export function registerAdminOperatorClaimRoutes(app: Application, deps: Deps): void {
  const { db, errorRes, auth, requireAdmin, requireRootAdmin } = deps
  // Best-effort: a notify failure must never roll back / fail the claim mutation.
  const notify = (kind: ClaimTransition, claimedEventId: string) => { try { emitClaimNotifications(db, kind, claimedEventId) } catch { /* notifications are degradable */ } }

  // ── admin proposes linking THEIR OWN seat to a contributor account ──
  app.post('/api/admin/operator-claims', (req: Request, res: Response) => {
    const admin = requireAdmin(req, res); if (!admin) return
    const contributorAccountId = String((req.body?.contributor_account_id ?? '')).trim()
    const rationale = req.body?.rationale ? String(req.body.rationale) : undefined
    if (!contributorAccountId) return errorRes(res, 400, 'invalid_input', 'contributor_account_id required')
    try {
      const out = db.transaction(() => {
        const r = proposeClaim(db, { actorAdminId: admin.id as string, contributorAccountId, rationale })
        if (!(r as any).ok) return r
        logAdminAction(db, { adminId: admin.id as string, action: 'operator_claim.propose', targetType: 'user', targetId: contributorAccountId, detail: { claimed_event_id: (r as any).claimedEventId }, context: { actorType: 'admin_account', agentMode: 'human_direct' } })
        return r
      })()
      if (!(out as any).ok) return errorRes(res, httpFor((out as any).code), (out as any).code, (out as any).message)
      notify('proposed', (out as any).claimedEventId)   // → tell the contributor to confirm
      res.json({ ok: true, claim: shape(deriveClaimState(db, (out as any).claimedEventId)) })
    } catch (e) { errorRes(res, 500, 'internal', (e as Error).message) }
  })

  // ── the calling admin's own seat: its claims + states ──
  app.get('/api/admin/operator-claims/me', (req: Request, res: Response) => {
    const admin = requireAdmin(req, res); if (!admin) return
    res.json({ seat: admin.id, claims: listClaimsForSeat(db, admin.id as string).map(shape) })
  })

  // ── contributor: claims pointing at ME awaiting my confirmation ──
  app.get('/api/me/operator-claim-confirmations', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    res.json({ pending: listPendingConfirmationsForContributor(db, user.id as string).map(shape) })
  })

  // ── contributor accepts/rejects a claim pointing at them ──
  app.post('/api/me/operator-claim-confirmations/:claimedEventId', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const decision = String(req.body?.decision ?? '')
    const rationale = req.body?.rationale ? String(req.body.rationale) : undefined
    try {
      const out = db.transaction(() => {
        const r = confirmClaim(db, { claimedEventId: String(req.params.claimedEventId), deciderId: user.id as string, decision: decision as any, rationale })
        if (!(r as any).ok) return r
        logAdminAction(db, { adminId: user.id as string, action: 'operator_claim.confirm', targetType: 'operator_claim', targetId: String(req.params.claimedEventId), detail: { decision }, context: { actorType: 'human', agentMode: 'human_direct' } })
        return r
      })()
      if (!(out as any).ok) return errorRes(res, httpFor((out as any).code), (out as any).code, (out as any).message)
      notify(decision === 'accepted' ? 'accepted' : 'rejected_by_contributor', String(req.params.claimedEventId))   // → root to approve, or admin that it was declined
      res.json({ ok: true, claim: shape(deriveClaimState(db, String(req.params.claimedEventId))) })
    } catch (e) { errorRes(res, 500, 'internal', (e as Error).message) }
  })

  // ── ROOT: review queue (all claims, optional ?status=) ──
  app.get('/api/admin/operator-claims', (req: Request, res: Response) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const status = req.query.status ? String(req.query.status) as ClaimStatus : undefined
    res.json({ claims: listAllClaims(db, status).map(shape) })
  })

  // ── ROOT: claim detail ──
  app.get('/api/admin/operator-claims/:claimedEventId', (req: Request, res: Response) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const v = deriveClaimState(db, String(req.params.claimedEventId))
    if (!v) return errorRes(res, 404, 'claim_not_found', 'no such claim')
    res.json({ claim: shape(v) })
  })

  // Shared tx + audit + error boilerplate. Each ROOT route below inlines requireRootAdmin(req, res)
  // FIRST (so the api-docs/OpenAPI generator detects the auth gate) then delegates here.
  const runRootMutation = (res: Response, root: Record<string, unknown>, req: Request, action: string, targetId: string, fn: () => any, notifyKind?: ClaimTransition, notifyClaimedEventId?: string) => {
    try {
      const out = db.transaction(() => {
        const r = fn()
        if (!(r as any).ok) return r
        logAdminAction(db, { adminId: root.id as string, action, targetType: 'operator_claim', targetId, detail: { result: r }, context: { actorType: 'admin_account', agentMode: 'human_direct', approvalKind: req.body?.approval_kind, conflictDisclosure: req.body?.conflict_disclosure } })
        return r
      })()
      if (!(out as any).ok) return errorRes(res, httpFor((out as any).code), (out as any).code, (out as any).message)
      if (notifyKind && notifyClaimedEventId) notify(notifyKind, notifyClaimedEventId)   // → tell contributor + proposing admin
      res.json({ ok: true, result: out })
    } catch (e) { errorRes(res, 500, 'internal', (e as Error).message) }
  }

  // ── ROOT: approve a proposed-or-confirmed claim ──
  app.post('/api/admin/operator-claims/:claimedEventId/approve', (req: Request, res: Response) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const id = String(req.params.claimedEventId)
    runRootMutation(res, root, req, 'operator_claim.approve', id, () =>
      approveClaim(db, { claimedEventId: id, approverId: root.id as string, approvalKind: String(req.body?.approval_kind ?? ''), conflictDisclosure: String(req.body?.conflict_disclosure ?? ''), rationale: req.body?.rationale ? String(req.body.rationale) : undefined }), 'approved', id)
  })

  // ── ROOT: reject a still-proposed/confirmed claim ──
  app.post('/api/admin/operator-claims/:claimedEventId/reject', (req: Request, res: Response) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const id = String(req.params.claimedEventId)
    runRootMutation(res, root, req, 'operator_claim.reject', id, () =>
      rejectClaim(db, { claimedEventId: id, approverId: root.id as string, rationale: req.body?.rationale ? String(req.body.rationale) : undefined }), 'rejected_by_root', id)
  })

  // ── ROOT: revoke an APPROVED (active) claim ──
  app.post('/api/admin/operator-claims/:approvedEventId/revoke', (req: Request, res: Response) => {
    const root = requireRootAdmin(req, res); if (!root) return
    const id = String(req.params.approvedEventId)
    const claimedId = claimedEventIdOfApproved(db, id) ?? undefined   // resolve the claim behind the approval for notifications
    runRootMutation(res, root, req, 'operator_claim.revoke', id, () =>
      revokeApprovedClaim(db, { approvedEventId: id, revokerId: root.id as string, rationale: req.body?.rationale ? String(req.body.rationale) : undefined }), 'revoked', claimedId)
  })
}
