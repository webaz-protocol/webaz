/**
 * Contribution read-out V1 — GET /api/contribution-facts/me (read-only self-view).
 *
 * Returns the caller's OWN attributable contribution facts (GitHub + admin coordination), grouped by
 * source, anchored on the session account. A SEPARATE endpoint from /contribution-identity/github/me so
 * the GitHub-only semantics there are not polluted with admin-coordination attribution.
 *
 * Read-only: the engine issues SELECT only — no INSERT/UPDATE/DELETE, no accountable_ref write-back, no
 * reward/payout/amount. The response is wrapped in the RFC-017 uncommitted-value boundary so the display
 * can never read as a payout promise. accountId is ALWAYS the session user (never a query/body param), so
 * a caller can never read another account's facts; no admin_audit_log.detail is exposed.
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getMyContributionFacts } from '../../layer2-business/L2-9-contribution/contribution-facts-read.js'
import { withUncommittedValueBoundary } from '../../layer2-business/L2-9-contribution/contribution-display-envelope.js'

export interface ContributionFactsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
}

export function registerContributionFactsRoutes(app: Application, deps: ContributionFactsDeps): void {
  const { db, auth, errorRes } = deps

  // ── READ-ONLY: the caller's OWN attributable contribution facts (GitHub + admin coordination) ──
  app.get('/api/contribution-facts/me', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    try {
      const surface = getMyContributionFacts(db, user.id as string)
      res.json(withUncommittedValueBoundary(surface))
    } catch {
      return void errorRes(res, 500, 'INTERNAL', '内部错误')   // never leak a stack / query
    }
  })
}
