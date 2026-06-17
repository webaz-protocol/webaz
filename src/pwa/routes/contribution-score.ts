/**
 * PR5F — Contribution Score v1 evidence READ surface (logged-in self-view). READ-ONLY; NOT a score engine.
 *
 *   GET /api/contribution-score/evidence/me  → the caller's OWN component evidence, wrapped in the PR5A
 *                                              uncommitted-value boundary.
 *
 * This layer adds NO new trust and NO computation: it only calls the layer2 evidence collector (PR5E) for
 * the SESSION account and stamps the boundary. It returns component evidence ONLY — never a
 * `contribution_score` / total / weight / tier / eligibility, and no formula/ranking. Scope is the security
 * argument: `accountId` is ALWAYS the session user (no query/body input is read), so a caller cannot ask
 * about another account; the collector already excludes other accounts / unbound actors / non-active facts.
 * The route holds no `db` handle and writes no core table.
 *
 * spec: docs/CONTRIBUTION-SCORE-V1-DESIGN.md · contribution-score-{contract,evidence}.ts · IDENTITY-CLAIM-DESIGN.md §8.8.
 */
import type { Application, Request, Response } from 'express'
import { collectContributionScoreEvidence } from '../../layer2-business/L2-9-contribution/contribution-score-evidence.js'
import { withUncommittedValueBoundary } from '../../layer2-business/L2-9-contribution/contribution-display-envelope.js'

export interface ContributionScoreDeps {
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
}

export function registerContributionScoreRoutes(app: Application, deps: ContributionScoreDeps): void {
  const { auth, errorRes } = deps

  // READ-ONLY self-view of contribution-score EVIDENCE (not a score). No query/body input — accountId is
  // always the session user. Output is component evidence wrapped in the uncommitted-value boundary.
  app.get('/api/contribution-score/evidence/me', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    try {
      const components = await collectContributionScoreEvidence(user.id as string)
      res.json(withUncommittedValueBoundary({ evidence_version: 'v1', components }))
    } catch {
      return void errorRes(res, 500, 'INTERNAL', '内部错误')   // never leak a stack / query
    }
  })
}
