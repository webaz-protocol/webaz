/**
 * Reputation 公开查询
 *
 * 由 #1013 Phase 71 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/reputation              我的（auth）
 *   GET /api/reputation/:userId      任意用户公开（含 decay 元数据）
 *
 * decay_rate 固定 0.02（月）；写在 reputation_scores.last_decay_at
 *
 * 跨域注入：auth + getReputation + getSellerMetrics
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ReputationDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  // 真实 ReputationProfile 类型未对外导出；用 any 保留调用侧推断
  getReputation: (db: Database.Database, userId: string) => any
  getSellerMetrics: (userId: string) => any
}

export function registerReputationRoutes(app: Application, deps: ReputationDeps): void {
  const { db, auth, getReputation, getSellerMetrics } = deps

  app.get('/api/reputation', (req, res) => {
    const user = auth(req, res); if (!user) return
    const rep = getReputation(db, user.id as string)
    res.json({
      level:             rep.level,
      total_points:      rep.total_points,
      transactions_done: rep.transactions_done,
      disputes_won:      rep.disputes_won,
      disputes_lost:     rep.disputes_lost,
      violations:        rep.violations,
      recent_events:     rep.recent_events,
      metrics:           getSellerMetrics(user.id as string),
    })
  })

  app.get('/api/reputation/:userId', async (req, res) => {
    const rep = getReputation(db, req.params.userId)
    const decayRow = await dbOne<{ last_decay_at: string | null }>(`SELECT last_decay_at FROM reputation_scores WHERE user_id = ?`, [req.params.userId])
    res.json({
      level:             rep.level,
      total_points:      rep.total_points,
      transactions_done: rep.transactions_done,
      disputes_won:      rep.disputes_won,
      disputes_lost:     rep.disputes_lost,
      violations:        rep.violations,
      metrics:           getSellerMetrics(req.params.userId),
      last_decay_at:     decayRow?.last_decay_at || null,
      decay_rate:        0.02,
    })
  })
}
