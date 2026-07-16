/**
 * build_reputation routes (RFC-006 — Gap 2: contributor dashboard, stage 3).
 *
 *   GET /api/build-reputation/me   贡献者【自查】档案(KPI/等级/来源/provenance/限制+申诉)
 *
 * 不变量 3:仅【自查】,不暴露他人 / 不做公开榜(运营规模与贡献者隐私)。
 * 不变量 1:build_points 独立池,绝不喂交易侧准入(见 build-reputation-engine 注释)。
 * 注入:db / auth
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getBuildProfile } from '../../layer2-business/L2-9-contribution/build-reputation-engine.js'
import { withUncommittedValueBoundary } from '../../layer2-business/L2-9-contribution/contribution-display-envelope.js'

export interface BuildReputationDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerBuildReputationRoutes(app: Application, deps: BuildReputationDeps): void {
  const { db, auth } = deps

  // PR-5A/5B: this legacy RFC-006 contributor dashboard is a contribution display surface, so its
  // response is wrapped in the uncommitted-value boundary (RFC-017 I-12 / §7) — build_points/tier express
  // BUILD reputation (coordination layer) only and promise no economic value.
  app.get('/api/build-reputation/me', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    res.json(withUncommittedValueBoundary(await getBuildProfile(db, user.id as string)))
  })
}
