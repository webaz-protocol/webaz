/**
 * build_task quota-increase request routes (PR #18).
 *   - requester (any authenticated user who hit the create cap): submit + view own requests
 *   - ROOT admin only: list / detail (with requester's live 24h usage) / approve / reject / revoke
 *
 * Seam-clean (RFC-016): the route file holds no raw db.prepare — all DB access goes through the
 * build-task-quota store helpers. Self-approval is rejected in the store (decided_by ≠ requester) and
 * the review surface is gated by requireRootAdmin (non-root admins get 403).
 *
 * 注入:db / errorRes / auth / requireRootAdmin
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  createQuotaRequest, listMyQuotaRequests, listQuotaRequests, getQuotaRequest,
  approveQuotaRequest, rejectQuotaRequest, revokeQuotaRequest,
  requesterUsage24h, remainingQuota, isQuotaError,
} from '../../layer2-business/L2-9-contribution/build-task-quota.js'

export interface BuildTaskQuotaDeps {
  db: Database.Database
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

// map a store error_code to an HTTP status
function httpFor(code: string): number {
  if (code === 'NOT_FOUND') return 404
  if (code === 'ALREADY_PENDING' || code === 'BAD_STATE') return 409
  if (code === 'SELF_DECISION') return 403
  return 400
}

// parse the stored linked_refs JSON + surface a derived remaining count for approved grants
function shapeRequest(r: Record<string, unknown>): Record<string, unknown> {
  let linked: string[] = []
  try { linked = JSON.parse(String(r.linked_refs ?? '[]')) } catch { linked = [] }
  const granted = r.granted_count == null ? null : Number(r.granted_count)
  const consumed = Number(r.consumed_count ?? 0)
  return { ...r, linked_refs: linked, remaining: granted == null ? null : Math.max(0, granted - consumed) }
}

export function registerBuildTaskQuotaRoutes(app: Application, deps: BuildTaskQuotaDeps): void {
  const { db, errorRes, auth, requireRootAdmin } = deps

  // ── requester surface ─────────────────────────────────────────────────────
  // submit a quota-increase request
  app.post('/api/me/quota-requests', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const r = createQuotaRequest(db, {
      requesterId: String(user.id),
      requestedExtraCount: Number(b.requested_extra_count),
      reason: String(b.reason ?? ''),
      linkedRefs: b.linked_refs,
      urgency: b.urgency as string | undefined,
      requestedDurationHours: b.requested_duration_hours == null ? null : Number(b.requested_duration_hours),
      quotaType: b.quota_type as string | undefined,
    })
    if (isQuotaError(r)) return void errorRes(res, httpFor(r.error_code), r.error_code, r.error)
    res.json({ request: r })
  })

  // list my own requests + current remaining temporary quota
  app.get('/api/me/quota-requests', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const requests = listMyQuotaRequests(db, String(user.id)).map(shapeRequest)
    res.json({ requests, remaining_quota: remainingQuota(db, String(user.id)) })
  })

  // ── ROOT admin review surface ─────────────────────────────────────────────
  // list quota requests (optional ?status=)
  app.get('/api/admin/quota-requests', (req: Request, res: Response) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const requests = listQuotaRequests(db, { status }).map(shapeRequest)
    res.json({ requests })
  })

  // detail of one request + the requester's live 24h create usage (reviewer context)
  app.get('/api/admin/quota-requests/:id', (req: Request, res: Response) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const r = getQuotaRequest(db, String(req.params.id))
    if (!r) return void errorRes(res, 404, 'NOT_FOUND', 'quota request not found')
    res.json({ request: shapeRequest(r), requester_usage_24h: requesterUsage24h(db, String(r.requester_user_id)) })
  })

  // approve → time-boxed counted grant (self-approval rejected in the store)
  app.post('/api/admin/quota-requests/:id/approve', (req: Request, res: Response) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const r = approveQuotaRequest(db, String(req.params.id), String(admin.id), {
      grantedCount: b.extra_count == null ? undefined : Number(b.extra_count),
      durationHours: b.duration_hours == null ? undefined : Number(b.duration_hours),
      expiresAt: typeof b.expires_at === 'string' ? b.expires_at : undefined,
      decisionNote: typeof b.approval_note === 'string' ? b.approval_note : undefined,
    })
    if (isQuotaError(r)) return void errorRes(res, httpFor(r.error_code), r.error_code, r.error)
    res.json({ approved: r })
  })

  // reject (self-rejection also blocked by the store's SELF_DECISION guard)
  app.post('/api/admin/quota-requests/:id/reject', (req: Request, res: Response) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const r = rejectQuotaRequest(db, String(req.params.id), String(admin.id), { decisionNote: typeof b.rejection_note === 'string' ? b.rejection_note : undefined })
    if (isQuotaError(r)) return void errorRes(res, httpFor(r.error_code), r.error_code, r.error)
    res.json({ rejected: r })
  })

  // revoke an already-approved grant (root)
  app.post('/api/admin/quota-requests/:id/revoke', (req: Request, res: Response) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const r = revokeQuotaRequest(db, String(req.params.id), String(admin.id), { decisionNote: typeof b.revocation_note === 'string' ? b.revocation_note : undefined })
    if (isQuotaError(r)) return void errorRes(res, httpFor(r.error_code), r.error_code, r.error)
    res.json({ revoked: r })
  })
}
